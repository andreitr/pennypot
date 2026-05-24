// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IJackpot} from "./interfaces/IJackpot.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";

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
 *         the reserve. While a Megapot drawing is open, tickets roll: when the active
 *         ticket fills, anyone can crank `buyNextTicket` to buy the next, until the
 *         drawing's `drawingTime` (minus a selling-window buffer).
 *
 *         Each share's payout is `ticketWinnings / sharesActuallySold` — so when a
 *         ticket is undersubscribed, every shareholder's slice grows. The pool keeps
 *         zero winnings. Revenue comes from Megapot's referral fees, accrued at an
 *         operator-owned `feeReceiver` address (set in the constructor; PennyPot
 *         lists it as the referrer on every ticket purchase).
 *
 * @dev    Drawing *lifecycle* state is intentionally NOT tracked on-chain — drawings
 *         are indexed off-chain, and Megapot itself is the source of truth for whether
 *         a ticket's drawing has settled (`claimWinnings` reverts otherwise). The
 *         contract is a thin ledger keyed by the Megapot ticket ID:
 *
 *           - buyNextTicket()                : front + buy the next Megapot ticket
 *           - buyShares(ticketId, count)     : buy 1..N shares of the active ticket
 *           - claim(ticketIds[])             : pull each ticket's winnings from Megapot
 *           - withdraw(ticketIds[])          : pull caller's share of claimed winnings
 *
 *         A drawingId -> ticketIds[] index is kept only as a read convenience
 *         (`getDrawingTicketIds`); it never gates contract logic.
 *
 *         Tightly scoped, non-upgradeable. Pause + reserve withdrawal are the only
 *         owner knobs. See README for the full spec and reasoning.
 *
 *         Ownership and pause use OpenZeppelin's Ownable2Step + Pausable.
 */
contract PennyPot is Ownable2Step, Pausable {
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

    /// @notice The Megapot ticket currently selling shares. 0 = none active.
    uint256 public activeTicketId;

    /// @notice drawingTime of the active ticket's drawing; share sales close at it.
    uint64 public activeDeadline;

    /// @notice Shares sold per Megapot ticket (0..100).
    mapping(uint256 => uint8) public soldOf;

    /// @notice Per-share winnings for a ticket, set by `claim`. 0 = losing or unclaimed.
    mapping(uint256 => uint256) public winningsPerShareOf;

    /// @notice Whether `claim` has already settled a ticket against Megapot. Needed to
    ///         distinguish a claimed-losing ticket (wps 0) from an unclaimed one.
    mapping(uint256 => bool) public claimedOf;

    /// @notice shares[ticketId][user] => count of shares this user owns on that ticket.
    ///         Zeroed in `withdraw` once the ticket is claimed.
    mapping(uint256 => mapping(address => uint8)) internal shares;

    /// @notice drawingId => Megapot ticket ids bought under it. Read convenience only;
    ///         lets a caller enumerate a drawing's tickets without an off-chain index.
    mapping(uint256 => uint256[]) internal drawingTickets;

    /// @notice USDC owned by the reserve. Fronts every ticket; replenished by share
    ///         purchases. Decreases only on buyNextTicket and owner withdrawals.
    uint256 public reservePool;

    // -----------------------------------------------------------------------
    // Events
    // -----------------------------------------------------------------------

    event TicketBought(uint256 indexed drawingId, uint256 indexed ticketId, address caller);
    event SharesBought(uint256 indexed ticketId, address indexed buyer, uint8 count, uint8 newSold);
    event TicketFilled(uint256 indexed ticketId);
    event TicketSettled(uint256 indexed ticketId, uint256 totalWin, uint256 winningsPerShare);
    event WinningsWithdrawn(address indexed user, uint256 amount);
    event ReserveDeposited(address indexed from, uint256 amount, uint256 newReserve);
    event ReserveWithdrawn(address indexed to, uint256 amount, uint256 newReserve);

    // -----------------------------------------------------------------------
    // Errors
    // -----------------------------------------------------------------------

    error ZeroAddress();
    error FeeReceiverEqualsContract();
    error InvalidCount();
    error NoActiveTicket();
    error UnexpectedTicket(uint256 active, uint256 expected);
    error TicketStillSelling();
    error PastSellingWindow();
    error MegapotTicketPriceMismatch(uint256 expected, uint256 actual);
    error ReserveTooLowForTicket(uint256 reserve, uint256 needed);
    error NothingToWithdraw();
    error InsufficientReserve();
    error ApprovalFailed();

    // -----------------------------------------------------------------------
    // Constructor
    // -----------------------------------------------------------------------

    /// @param _usdc        Base mainnet USDC address.
    /// @param _jackpot     Megapot Jackpot contract address.
    /// @param _feeReceiver Address listed as the referrer on every ticket buy.
    ///                     MUST be different from address(this).
    /// @param _owner       Operator address with admin powers (reserve mgmt, pause).
    ///                     Zero reverts via OZ Ownable's OwnableInvalidOwner.
    constructor(address _usdc, address _jackpot, address _feeReceiver, address _owner) Ownable(_owner) {
        if (_usdc == address(0) || _jackpot == address(0) || _feeReceiver == address(0)) {
            revert ZeroAddress();
        }
        if (_feeReceiver == address(this)) revert FeeReceiverEqualsContract();

        USDC = IERC20(_usdc);
        JACKPOT = IJackpot(_jackpot);
        feeReceiver = _feeReceiver;

        // One-time max approval. Re-approval would be needed only if USDC ever upgrades
        // to a "race-condition-safe" approve pattern; current USDC on Base is fine.
        if (!IERC20(_usdc).approve(_jackpot, type(uint256).max)) revert ApprovalFailed();
    }

    // -----------------------------------------------------------------------
    // User-facing writes
    // -----------------------------------------------------------------------

    /// @notice Buy `count` shares of the active ticket. Each share costs 10_000 USDC
    ///         (0.01 USDC); USDC must be pre-approved.
    ///
    /// @param  expectedTicketId The Megapot ticket the caller intends to buy into.
    ///         Reverts if the active ticket has rolled over (filled / drawing closed
    ///         and a new one was cranked) so a buyer never lands on the wrong ticket.
    /// @param  count            Shares to buy; reverts if it would push the ticket
    ///         past 100 shares.
    function buyShares(uint256 expectedTicketId, uint8 count) external whenNotPaused {
        if (count == 0) revert InvalidCount();

        uint256 active = activeTicketId;
        if (active == 0) revert NoActiveTicket();
        if (active != expectedTicketId) revert UnexpectedTicket(active, expectedTicketId);
        if (block.timestamp >= activeDeadline) revert PastSellingWindow();

        uint16 newSold = uint16(soldOf[active]) + count;
        if (newSold > SHARES_PER_TICKET) revert InvalidCount();

        uint256 cost = uint256(count) * SHARE_PRICE;
        // Pull USDC from buyer to this contract; share proceeds replenish the reserve.
        if (!USDC.transferFrom(msg.sender, address(this), cost)) revert ApprovalFailed();
        reservePool += cost;

        soldOf[active] = uint8(newSold);
        shares[active][msg.sender] += count;

        emit SharesBought(active, msg.sender, count, uint8(newSold));
        if (newSold == SHARES_PER_TICKET) emit TicketFilled(active);
    }

    /// @notice Withdraw the caller's winnings across the given (claimed) tickets.
    ///         Tickets not yet claimed are skipped and left intact for a later call;
    ///         claimed tickets are consumed (shares zeroed) whether winning or losing.
    function withdraw(uint256[] calldata ticketIds) external {
        uint256 owed;
        for (uint256 i = 0; i < ticketIds.length; i++) {
            uint256 id = ticketIds[i];
            uint8 userShares = shares[id][msg.sender];
            if (userShares == 0) continue;
            if (!claimedOf[id]) continue; // not settled yet; keep shares for later

            shares[id][msg.sender] = 0; // settled (win or lose) -> consume
            uint256 wps = winningsPerShareOf[id];
            if (wps > 0) owed += uint256(userShares) * wps;
        }

        if (owed == 0) revert NothingToWithdraw();
        if (!USDC.transfer(msg.sender, owed)) revert ApprovalFailed();

        emit WinningsWithdrawn(msg.sender, owed);
    }

    // -----------------------------------------------------------------------
    // Permissionless cranks
    // -----------------------------------------------------------------------

    /// @notice Front and buy the next Megapot ticket, making it the active ticket.
    ///         Anyone can call. Buys into Megapot's *current* drawing.
    ///
    /// @dev    Allowed only when the active ticket is "closed": none yet, full, or its
    ///         drawing's selling window has ended. Reverts if the reserve can't cover
    ///         the ticket price or if we're within MIN_SELLING_WINDOW of drawingTime.
    function buyNextTicket() external whenNotPaused {
        uint256 active = activeTicketId;
        bool activeClosed = active == 0 || soldOf[active] == SHARES_PER_TICKET || block.timestamp >= activeDeadline;
        if (!activeClosed) revert TicketStillSelling();

        uint256 drawingId = JACKPOT.currentDrawingId();
        IJackpot.DrawingState memory ms = JACKPOT.getDrawingState(drawingId);
        if (ms.ticketPrice != TICKET_PRICE) revert MegapotTicketPriceMismatch(TICKET_PRICE, ms.ticketPrice);
        if (block.timestamp + MIN_SELLING_WINDOW > ms.drawingTime) revert PastSellingWindow();

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
        uint256 newId = ids[0];

        activeTicketId = newId;
        activeDeadline = uint64(ms.drawingTime);
        drawingTickets[drawingId].push(newId);

        emit TicketBought(drawingId, newId, msg.sender);
    }

    /// @notice Claim each ticket's winnings from Megapot and record its winningsPerShare.
    ///         Permissionless. Already-claimed tickets are skipped; tickets whose drawing
    ///         has not settled cause Megapot's claimWinnings to revert.
    ///
    /// @dev    Claims one ticket at a time, measuring the USDC delta to attribute that
    ///         ticket's payout. Winnings from a 0-share ticket stay in the contract
    ///         balance (winningsPerShare can't be computed); rare by construction.
    function claim(uint256[] calldata ticketIds) external {
        for (uint256 i = 0; i < ticketIds.length; i++) {
            uint256 id = ticketIds[i];
            if (claimedOf[id]) continue;

            uint256[] memory single = new uint256[](1);
            single[0] = id;

            uint256 balBefore = USDC.balanceOf(address(this));
            JACKPOT.claimWinnings(single);
            uint256 ticketWin = USDC.balanceOf(address(this)) - balBefore;

            claimedOf[id] = true;

            uint8 sold = soldOf[id];
            if (ticketWin > 0 && sold > 0) {
                uint256 wps = ticketWin / sold;
                winningsPerShareOf[id] = wps;
                emit TicketSettled(id, ticketWin, wps);
            } else {
                emit TicketSettled(id, ticketWin, 0);
            }
        }
    }

    // -----------------------------------------------------------------------
    // Reserve management
    // -----------------------------------------------------------------------

    /// @notice Anyone can top up the reserve. Useful for the operator (seeding the
    ///         reserve) or for community top-ups.
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
    //
    // Ownership (two-step) comes from OZ Ownable2Step: owner(), pendingOwner(),
    // transferOwnership(newOwner), acceptOwnership(), renounceOwnership().

    /// @notice Emergency stop: blocks buyShares and buyNextTicket.
    function pause() external onlyOwner {
        _pause();
    }

    /// @notice Resume after a pause.
    function unpause() external onlyOwner {
        _unpause();
    }

    // -----------------------------------------------------------------------
    // Reads (UI helpers)
    // -----------------------------------------------------------------------

    /// @notice Megapot ticket ids bought under a drawing, in purchase order.
    function getDrawingTicketIds(uint256 drawingId) external view returns (uint256[] memory) {
        return drawingTickets[drawingId];
    }

    /// @notice Number of tickets PennyPot bought under a drawing.
    function getDrawingTicketCount(uint256 drawingId) external view returns (uint256) {
        return drawingTickets[drawingId].length;
    }

    function getTicket(uint256 ticketId) external view returns (uint8 sold, uint256 winningsPerShare, bool claimed) {
        return (soldOf[ticketId], winningsPerShareOf[ticketId], claimedOf[ticketId]);
    }

    function getTicketShares(uint256 ticketId, address user) external view returns (uint8) {
        return shares[ticketId][user];
    }

    /// @notice Compute a user's total claimable USDC across the given tickets.
    ///         View-only mirror of withdraw's logic (counts only claimed winners).
    function getPendingWinnings(address user, uint256[] calldata ticketIds) public view returns (uint256 owed) {
        for (uint256 i = 0; i < ticketIds.length; i++) {
            uint256 id = ticketIds[i];
            uint256 wps = winningsPerShareOf[id];
            if (wps == 0) continue;
            owed += uint256(shares[id][user]) * wps;
        }
    }

    /// @notice Convenience: a user's claimable USDC across every ticket in a drawing.
    function getPendingWinningsForDrawing(uint256 drawingId, address user) external view returns (uint256 owed) {
        uint256[] storage ids = drawingTickets[drawingId];
        for (uint256 i = 0; i < ids.length; i++) {
            uint256 id = ids[i];
            uint256 wps = winningsPerShareOf[id];
            if (wps == 0) continue;
            owed += uint256(shares[id][user]) * wps;
        }
    }
}
