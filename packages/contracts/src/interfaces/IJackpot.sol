// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @notice Minimal interface to Megapot's Jackpot contract on Base.
 * @dev Only the functions PennyPot needs are listed.
 *      Source of truth: https://llms.megapot.io/abi/Jackpot.json
 *      Deployed at 0x3bAe643002069dBCbcd62B1A4eb4C4A397d042a2 (Base mainnet).
 */
interface IJackpot {
    struct Ticket {
        uint8[] normals;
        uint8 bonusball;
    }

    struct DrawingState {
        uint256 prizePool;
        uint256 ticketPrice;
        uint256 edgePerTicket;
        uint256 referralWinShare;
        uint256 referralFee;
        uint256 globalTicketsBought;
        uint256 lpEarnings;
        uint256 drawingTime;
        uint256 winningTicket;
        uint8 ballMax;
        uint8 bonusballMax;
        address payoutCalculator;
        bool jackpotLock;
    }

    /// @notice Buy 1..10 tickets in one call. For quick-picks, pass `Ticket(normals: [], bonusball: 0)`.
    /// @param _tickets       Array of ticket specs; ≤ 10 entries.
    /// @param _recipient     Address that receives the ticket NFTs and can later claim winnings.
    /// @param _referrers     Up to `maxReferrers` addresses earning the referral fee + win share.
    /// @param _referralSplit Weights matching `_referrers`, in 1e18 scale, summing to exactly 1e18.
    /// @param _source        Analytics tag; Megapot convention is keccak256 of the app name, e.g. keccak256("pennypot").
    /// @return ticketIds     The user-facing ticket IDs (one per entry in _tickets).
    function buyTickets(
        Ticket[] calldata _tickets,
        address _recipient,
        address[] calldata _referrers,
        uint256[] calldata _referralSplit,
        bytes32 _source
    ) external returns (uint256[] memory ticketIds);

    /// @notice Claim winnings for one or more owned tickets in the most recently settled drawing.
    ///         Burns the NFTs and transfers USDC to msg.sender.
    /// @param _userTicketIds The ticket IDs to claim against.
    function claimWinnings(uint256[] calldata _userTicketIds) external;

    /// @notice Withdraw accrued referral fees to msg.sender.
    function claimReferralFees() external;

    /// @notice Returns the active drawing ID. The most recent settled drawing is `currentDrawingId() - 1`.
    function currentDrawingId() external view returns (uint256);

    /// @notice Returns the full state of a drawing. After settlement, `winningTicket != 0`.
    function getDrawingState(uint256 _drawingId) external view returns (DrawingState memory);

    /// @notice Returns the prize-tier-id (0..11) each ticket landed in. Only valid for settled drawings.
    function getTicketTierIds(uint256[] calldata _ticketIds) external view returns (uint256[] memory tierIds);

    /// @notice Returns the per-ticket payout for each of the 12 prize tiers in a settled drawing.
    function getDrawingTierPayouts(uint256 _drawingId) external view returns (uint256[12] memory);
}
