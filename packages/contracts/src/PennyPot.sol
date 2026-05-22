// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IJackpot} from "./interfaces/IJackpot.sol";

interface IERC20 {
    function transfer(address, uint256) external returns (bool);
    function transferFrom(address, address, uint256) external returns (bool);
    function approve(address, uint256) external returns (bool);
    function balanceOf(address) external view returns (uint256);
}

/**
 * @title PennyPot
 * @notice Buy 1¢ shares of Megapot lottery tickets.
 *
 *         Each Megapot ticket costs $1 (1 USDC). PennyPot fronts every ticket from a
 *         reserve, then sells it as 100 shares at 1¢ each. Share proceeds replenish
 *         the reserve. Within a single drawing window, tickets roll: when one fills,
 *         anyone can crank `buyNextTicket` to buy the next, until `drawingTime`.
 *
 *         Each share's payout is `ticketWinnings / sharesActuallySold` — so when a
 *         ticket is undersubscribed, every shareholder's slice grows. The pool keeps
 *         zero winnings. Revenue comes from Megapot's referral fees, accrued at an
 *         operator-owned `feeReceiver` address (set in the constructor; PennyPot
 *         lists it as the referrer on every ticket purchase).
 *
 *         Three permissionless cranks keep the machine moving:
 *           - buyNextTicket(drawingId)      : buy the next ticket once active is full
 *           - finalizeDrawing(drawingId)    : close ticket purchases at drawing close
 *           - claimDrawing(drawingId)       : claim all winnings from Megapot
 *
 *         Users have exactly two write functions:
 *           - buyShares(drawingId, count)   : buy 1..N shares of the active ticket
 *           - withdrawWinnings(drawingId)   : pull their share of winnings
 *
 * @dev Tightly scoped, non-upgradeable. Pause + reserve withdrawal are the only owner
 *      knobs. See README for the full spec and reasoning.
 */
contract PennyPot {
    // -----------------------------------------------------------------------
    // Constants
    // -----------------------------------------------------------------------

    /// @notice Price of a Megapot ticket, in 6-decimal USDC. Hardcoded; reverts in
    ///         buyNextTicket if Megapot's live ticketPrice differs.
    uint256 public constant TICKET_PRICE = 1_000_000; // 1 USDC

    /// @notice Price of a single PennyPot share. TICKET_PRICE / SHARES_PER_TICKET.
    uint256 public constant SHARE_PRICE = 10_000; // 0.01 USDC

    /// @notice Number of shares each ticket is split into.
    uint8 public constant SHARES_PER_TICKET = 100;

    /// @notice Minimum seconds before drawingTime that buyNextTicket will still buy
    ///         a fresh ticket. Prevents an attacker from filling a ticket near close,
    ///         cranking buyNextTicket, and forcing the reserve to subsidize a ticket
    ///         that has no time to resell its shares.
    uint256 public constant MIN_SELLING_WINDOW = 1 hours;

    /// @notice Single-element referrer-split weight passed to Megapot's buyTickets.
    ///         Megapot's `_referralSplit` is in 1e18 scale and must sum to exactly 1e18,
    ///         so a single 100% referrer uses the full 1e18 weight.
    uint256 internal constant REFERRAL_SPLIT_FULL = 1e18;

    /// @notice Integration source tag passed to Megapot for on-chain analytics.
    ///         Megapot convention: keccak256 of the app name.
    bytes32 public constant SOURCE = keccak256("pennypot");

    // -----------------------------------------------------------------------
    // Immutables
    // -----------------------------------------------------------------------

    IERC20 public immutable USDC;
    IJackpot public immutable JACKPOT;

    /// @notice Operator-owned address listed as the referrer on every ticket buy.
    ///         Earns Megapot's per-ticket referral fee and per-claim win share. Must
    ///         differ from address(this) — Megapot's buyTickets reverts otherwise.
    address public immutable feeReceiver;

    // -----------------------------------------------------------------------
    // State
    // -----------------------------------------------------------------------

    enum DrawingState {
        None, // never opened
        Selling, // open for share purchases
        Bought, // drawingTime passed; awaiting Megapot settlement
        Settled // claimed and per-ticket winningsPerShare set
    }

    struct Ticket {
        uint256 ticketId; // Megapot user-ticket ID
        uint8 sold; // 0..100
        uint256 winningsPerShare; // set by claimDrawing; 0 if losing/unsold
    }

    struct Drawing {
        DrawingState state;
        uint64 drawingTime; // snapshot from Megapot at first interaction
        uint32 activeTicketIdx; // current ticket selling shares
        bool nextTicketQueued; // true between "ticket filled" and buyNextTicket()
        // tickets and per-ticket share ledgers live in dedicated mappings below to
        // avoid Solidity's limitations on struct arrays with nested mappings.
    }

    /// @notice Drawing metadata, keyed by Megapot's drawingId.
    mapping(uint256 => Drawing) internal drawings;

    /// @notice Ticket count per drawing. tickets[drawingId][i] gives the i-th ticket.
    mapping(uint256 => uint256) public ticketCount;

    /// @notice tickets[drawingId][ticketIdx] => Ticket
    mapping(uint256 => mapping(uint256 => Ticket)) internal tickets;

    /// @notice shares[drawingId][ticketIdx][user] => count of shares this user owns
    ///         on that ticket. Zeroed out lazily when the user calls withdrawWinnings
    ///         for the drawing.
    mapping(uint256 => mapping(uint256 => mapping(address => uint8))) internal shares;

    /// @notice USDC owned by the reserve. Floats every ticket; replenished by share
    ///         purchases. Decreases only on buyNextTicket and owner withdrawals.
    uint256 public reservePool;

    address public owner;
    address public pendingOwner;
    bool public paused;

    // -----------------------------------------------------------------------
    // Events
    // -----------------------------------------------------------------------

    event DrawingOpened(uint256 indexed drawingId, uint64 drawingTime);
    event TicketBought(
        uint256 indexed drawingId, uint256 indexed ticketIdx, uint256 indexed megapotTicketId, address caller
    );
    event SharesBought(
        uint256 indexed drawingId, uint256 indexed ticketIdx, address indexed buyer, uint8 count, uint8 newSold
    );
    event TicketFilled(uint256 indexed drawingId, uint256 indexed ticketIdx);
    event DrawingFinalized(uint256 indexed drawingId, uint256 ticketCount, uint8 lastTicketSold);
    event DrawingClaimed(uint256 indexed drawingId, uint256 totalWinnings);
    event TicketSettled(
        uint256 indexed drawingId, uint256 indexed ticketIdx, uint256 totalWin, uint256 winningsPerShare
    );
    event WinningsWithdrawn(address indexed user, uint256 indexed drawingId, uint256 amount);
    event ReserveDeposited(address indexed from, uint256 amount, uint256 newReserve);
    event ReserveWithdrawn(address indexed to, uint256 amount, uint256 newReserve);
    event PausedSet(bool paused);
    event OwnershipTransferStarted(address indexed from, address indexed to);
    event OwnershipTransferred(address indexed from, address indexed to);

    // -----------------------------------------------------------------------
    // Errors
    // -----------------------------------------------------------------------

    error NotOwner();
    error Paused();
    error ZeroAddress();
    error FeeReceiverEqualsContract();
    error InvalidCount();
    error WrongDrawingState(DrawingState expected, DrawingState actual);
    error TicketNotFull();
    error NoActiveTicket(); // active ticket needs to be bought via buyNextTicket first
    error PastSellingWindow();
    error DrawingTimeNotReached();
    error DrawingNotSettled();
    error MegapotTicketPriceMismatch(uint256 expected, uint256 actual);
    error ReserveTooLowForTicket(uint256 reserve, uint256 needed);
    error NothingToWithdraw();
    error InsufficientReserve();
    error ApprovalFailed();

    // -----------------------------------------------------------------------
    // Modifiers
    // -----------------------------------------------------------------------

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier whenNotPaused() {
        if (paused) revert Paused();
        _;
    }

    // -----------------------------------------------------------------------
    // Constructor
    // -----------------------------------------------------------------------

    /// @param _usdc        Base mainnet USDC address.
    /// @param _jackpot     Megapot Jackpot contract address.
    /// @param _feeReceiver Address listed as the referrer on every ticket buy.
    ///                     MUST be different from address(this).
    /// @param _owner       Operator address with admin powers (reserve mgmt, pause).
    constructor(address _usdc, address _jackpot, address _feeReceiver, address _owner) {
        if (_usdc == address(0) || _jackpot == address(0) || _feeReceiver == address(0) || _owner == address(0)) {
            revert ZeroAddress();
        }
        if (_feeReceiver == address(this)) revert FeeReceiverEqualsContract();

        USDC = IERC20(_usdc);
        JACKPOT = IJackpot(_jackpot);
        feeReceiver = _feeReceiver;
        owner = _owner;

        // One-time max approval. Re-approval would be needed only if USDC ever upgrades
        // to a "race-condition-safe" approve pattern; current USDC on Base is fine.
        if (!IERC20(_usdc).approve(_jackpot, type(uint256).max)) revert ApprovalFailed();

        emit OwnershipTransferred(address(0), _owner);
    }

    // -----------------------------------------------------------------------
    // User-facing writes
    // -----------------------------------------------------------------------

    /// @notice Buy `count` shares of the currently active ticket in the drawing.
    ///         Each share costs 10_000 USDC (0.01 USDC). USDC must be pre-approved.
    ///
    /// @dev    The drawing must be in `Selling` state and have an active ticket
    ///         (i.e., not `nextTicketQueued`). Reverts if `count` would push the
    ///         active ticket past 100 shares.
    function buyShares(uint256 drawingId, uint8 count) external whenNotPaused {
        if (count == 0) revert InvalidCount();

        Drawing storage d = drawings[drawingId];
        if (d.state != DrawingState.Selling) revert WrongDrawingState(DrawingState.Selling, d.state);
        if (d.nextTicketQueued) revert NoActiveTicket(); // no active ticket selling
        if (block.timestamp >= d.drawingTime) revert PastSellingWindow();

        Ticket storage t = tickets[drawingId][d.activeTicketIdx];
        uint16 newSold = uint16(t.sold) + count;
        if (newSold > SHARES_PER_TICKET) revert InvalidCount();

        uint256 cost = uint256(count) * SHARE_PRICE;
        // Pull USDC from buyer to this contract; share proceeds replenish the reserve.
        if (!USDC.transferFrom(msg.sender, address(this), cost)) revert ApprovalFailed();
        reservePool += cost;

        t.sold = uint8(newSold);
        shares[drawingId][d.activeTicketIdx][msg.sender] += count;

        emit SharesBought(drawingId, d.activeTicketIdx, msg.sender, count, t.sold);

        if (t.sold == SHARES_PER_TICKET) {
            d.nextTicketQueued = true;
            emit TicketFilled(drawingId, d.activeTicketIdx);
        }
    }

    /// @notice Withdraw your share of winnings for a settled drawing. Iterates over
    ///         the drawing's tickets, summing your owed amount, then zeroes your
    ///         share ledger entries to prevent double-claim.
    function withdrawWinnings(uint256 drawingId) external {
        Drawing storage d = drawings[drawingId];
        if (d.state != DrawingState.Settled) revert DrawingNotSettled();

        uint256 owed;
        uint256 n = ticketCount[drawingId];
        for (uint256 i = 0; i < n; i++) {
            uint8 userShares = shares[drawingId][i][msg.sender];
            if (userShares == 0) continue;
            uint256 wps = tickets[drawingId][i].winningsPerShare;
            if (wps == 0) {
                // Losing ticket: still zero out so later iterations are cheaper.
                shares[drawingId][i][msg.sender] = 0;
                continue;
            }
            owed += uint256(userShares) * wps;
            shares[drawingId][i][msg.sender] = 0;
        }

        if (owed == 0) revert NothingToWithdraw();
        if (!USDC.transfer(msg.sender, owed)) revert ApprovalFailed();

        emit WinningsWithdrawn(msg.sender, drawingId, owed);
    }

    // -----------------------------------------------------------------------
    // Permissionless cranks
    // -----------------------------------------------------------------------

    /// @notice Buy the next Megapot ticket for the given drawing. Anyone can call.
    ///
    ///         Three valid entry conditions:
    ///           1. First-ever call for the drawing: `state == None`. Opens the drawing
    ///              by snapshotting Megapot's currentDrawing's drawingTime, and buys
    ///              ticket #0.
    ///           2. Active ticket just filled: `state == Selling && nextTicketQueued`.
    ///              Buys ticket #(activeTicketIdx + 1) and resumes selling.
    ///
    ///         Reverts if reserve can't cover the ticket price or if we're within
    ///         the MIN_SELLING_WINDOW of drawingTime.
    function buyNextTicket(uint256 drawingId) external whenNotPaused {
        Drawing storage d = drawings[drawingId];

        // Case 1: opening the drawing
        if (d.state == DrawingState.None) {
            uint256 megaCurrent = JACKPOT.currentDrawingId();
            if (drawingId != megaCurrent) revert WrongDrawingState(DrawingState.None, d.state);

            IJackpot.DrawingState memory ms = JACKPOT.getDrawingState(drawingId);
            if (ms.ticketPrice != TICKET_PRICE) revert MegapotTicketPriceMismatch(TICKET_PRICE, ms.ticketPrice);

            d.state = DrawingState.Selling;
            d.drawingTime = uint64(ms.drawingTime);
            d.activeTicketIdx = 0;
            d.nextTicketQueued = true; // signals "no active ticket bought yet"
            emit DrawingOpened(drawingId, d.drawingTime);
        } else if (d.state == DrawingState.Selling) {
            if (!d.nextTicketQueued) revert TicketNotFull();
        } else {
            revert WrongDrawingState(DrawingState.Selling, d.state);
        }

        // Enforce selling-window buffer before drawing close.
        if (block.timestamp + MIN_SELLING_WINDOW > d.drawingTime) revert PastSellingWindow();

        // Reserve fronts the ticket cost.
        if (reservePool < TICKET_PRICE) revert ReserveTooLowForTicket(reservePool, TICKET_PRICE);
        reservePool -= TICKET_PRICE;

        // Buy 1 quick-pick from Megapot. recipient = this; referrer = feeReceiver.
        IJackpot.Ticket[] memory order = new IJackpot.Ticket[](1);
        order[0] = IJackpot.Ticket({normals: new uint8[](0), bonusball: 0});

        address[] memory referrers = new address[](1);
        referrers[0] = feeReceiver;
        uint256[] memory split = new uint256[](1);
        split[0] = REFERRAL_SPLIT_FULL;

        uint256[] memory ids = JACKPOT.buyTickets(order, address(this), referrers, split, SOURCE);

        // Advance to a fresh active ticket and record the Megapot ticket id.
        uint256 idx = ticketCount[drawingId];
        ticketCount[drawingId] = idx + 1;
        tickets[drawingId][idx] = Ticket({ticketId: ids[0], sold: 0, winningsPerShare: 0});

        d.activeTicketIdx = uint32(idx);
        d.nextTicketQueued = false;

        emit TicketBought(drawingId, idx, ids[0], msg.sender);
    }

    /// @notice Close share sales for a drawing once drawingTime has passed. Transitions
    ///         the drawing from Selling -> Bought. The reserve has already paid for any
    ///         partial active ticket (when it was bought via buyNextTicket); no extra
    ///         reserve action is needed here.
    function finalizeDrawing(uint256 drawingId) external {
        Drawing storage d = drawings[drawingId];
        if (d.state != DrawingState.Selling) revert WrongDrawingState(DrawingState.Selling, d.state);
        if (block.timestamp < d.drawingTime) revert DrawingTimeNotReached();

        uint8 lastSold;
        uint256 n = ticketCount[drawingId];
        if (n > 0 && !d.nextTicketQueued) {
            // The current active ticket was bought but possibly under-sold.
            lastSold = tickets[drawingId][n - 1].sold;
        }

        d.state = DrawingState.Bought;
        emit DrawingFinalized(drawingId, n, lastSold);
    }

    /// @notice Claim winnings for every ticket in a finalized drawing and set each
    ///         ticket's winningsPerShare from the actual USDC received per claim.
    ///
    /// @dev    Claims tickets one at a time, measuring the USDC delta after each
    ///         claim to determine that specific ticket's payout. This is more
    ///         expensive than a batched claim, but avoids depending on the timing
    ///         of Megapot's per-tier payout finalization (which may lag the
    ///         `winningTicket != 0` signal). Worst case: ~50 tickets × ~80k gas
    ///         per claim = ~4M gas, well under Base's block limit.
    ///
    ///         A drawing with zero tickets is settled with a no-op.
    function claimDrawing(uint256 drawingId) external {
        Drawing storage d = drawings[drawingId];
        if (d.state != DrawingState.Bought) revert WrongDrawingState(DrawingState.Bought, d.state);

        IJackpot.DrawingState memory ms = JACKPOT.getDrawingState(drawingId);
        if (ms.winningTicket == 0) revert DrawingNotSettled();

        uint256 n = ticketCount[drawingId];
        uint256 totalReceived;

        for (uint256 i = 0; i < n; i++) {
            Ticket storage t = tickets[drawingId][i];

            uint256[] memory single = new uint256[](1);
            single[0] = t.ticketId;

            uint256 balBefore = USDC.balanceOf(address(this));
            JACKPOT.claimWinnings(single);
            uint256 ticketWin = USDC.balanceOf(address(this)) - balBefore;

            totalReceived += ticketWin;

            if (ticketWin > 0 && t.sold > 0) {
                uint256 wps = ticketWin / t.sold;
                t.winningsPerShare = wps;
                emit TicketSettled(drawingId, i, ticketWin, wps);
            }
            // Else: losing ticket, or one nobody bought shares of. winningsPerShare
            // stays 0. (USDC received from a 0-share winning ticket is forfeited to
            // the contract balance — should be rare but stays accountable via events.)
        }

        d.state = DrawingState.Settled;
        emit DrawingClaimed(drawingId, totalReceived);
    }

    // -----------------------------------------------------------------------
    // Reserve management
    // -----------------------------------------------------------------------

    /// @notice Anyone can top up the reserve. Useful for the operator (seeding 365
    ///         USDC) or for community top-ups.
    function topUpReserve(uint256 amount) external {
        if (amount == 0) revert InvalidCount();
        if (!USDC.transferFrom(msg.sender, address(this), amount)) revert ApprovalFailed();
        reservePool += amount;
        emit ReserveDeposited(msg.sender, amount, reservePool);
    }

    /// @notice Owner can pull surplus from the reserve. Capped at `reservePool` so
    ///         pending user winnings (held outside the reserve accounting) can never
    ///         be touched.
    function withdrawReserveSurplus(uint256 amount, address to) external onlyOwner {
        if (to == address(0)) revert ZeroAddress();
        if (amount > reservePool) revert InsufficientReserve();
        reservePool -= amount;
        if (!USDC.transfer(to, amount)) revert ApprovalFailed();
        emit ReserveWithdrawn(to, amount, reservePool);
    }

    // -----------------------------------------------------------------------
    // Owner functions
    // -----------------------------------------------------------------------

    function setPaused(bool _paused) external onlyOwner {
        paused = _paused;
        emit PausedSet(_paused);
    }

    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert ZeroAddress();
        pendingOwner = newOwner;
        emit OwnershipTransferStarted(owner, newOwner);
    }

    function acceptOwnership() external {
        if (msg.sender != pendingOwner) revert NotOwner();
        address old = owner;
        owner = pendingOwner;
        pendingOwner = address(0);
        emit OwnershipTransferred(old, msg.sender);
    }

    // -----------------------------------------------------------------------
    // Reads (UI helpers)
    // -----------------------------------------------------------------------

    function getDrawing(uint256 drawingId)
        external
        view
        returns (
            DrawingState state,
            uint64 drawingTime,
            uint32 activeTicketIdx,
            bool nextTicketQueued,
            uint256 ticketsBought
        )
    {
        Drawing storage d = drawings[drawingId];
        return (d.state, d.drawingTime, d.activeTicketIdx, d.nextTicketQueued, ticketCount[drawingId]);
    }

    function getTicket(uint256 drawingId, uint256 ticketIdx)
        external
        view
        returns (uint256 megapotTicketId, uint8 sold, uint256 winningsPerShare)
    {
        Ticket storage t = tickets[drawingId][ticketIdx];
        return (t.ticketId, t.sold, t.winningsPerShare);
    }

    function getMyShares(uint256 drawingId, uint256 ticketIdx, address user) external view returns (uint8) {
        return shares[drawingId][ticketIdx][user];
    }

    /// @notice Compute a user's total claimable USDC across all tickets in a drawing.
    ///         View-only mirror of withdrawWinnings's logic.
    function getPendingWinnings(uint256 drawingId, address user) external view returns (uint256 owed) {
        Drawing storage d = drawings[drawingId];
        if (d.state != DrawingState.Settled) return 0;
        uint256 n = ticketCount[drawingId];
        for (uint256 i = 0; i < n; i++) {
            uint8 s = shares[drawingId][i][user];
            if (s == 0) continue;
            uint256 wps = tickets[drawingId][i].winningsPerShare;
            if (wps == 0) continue;
            owed += uint256(s) * wps;
        }
    }
}
