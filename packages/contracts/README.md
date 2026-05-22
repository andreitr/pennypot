# PennyPot

Buy 1¢ shares of Megapot lottery tickets. 1 share = 1% of that ticket's prize.
The pool keeps zero winnings. Operator revenue comes from Megapot's referral fees.

This repo contains two files:

- `src/PennyPot.sol` — the main contract
- `src/IJackpot.sol` — minimal interface to Megapot's Jackpot contract on Base

Tests are in `test/`, with a `MockJackpot` and `MockUSDC` for unit testing.

## Mechanic in one diagram

```
For each Megapot drawing (~24h):

  Reserve (seeded 365 USDC by operator)
      │
      │ −$1 (fronts ticket)
      ▼
  buyNextTicket() ──► Jackpot.buyTickets(recipient=PennyPot, referrer=feeReceiver)
                                          │
                                          │ mints ticket NFT to PennyPot
                                          │ accrues 10¢ to feeReceiver
                                          ▼
                              Ticket #N selling shares
                                          │
                                          │ 100 × buyShares(...) at 1¢ each
                                          │ each +1¢ → reserve
                                          ▼
                              Ticket #N full → nextTicketQueued = true
                                          │
                                          │ anyone can crank buyNextTicket again
                                          ▼
                                  Ticket #N+1 sells shares
                                          ⋮ (repeats until drawingTime)
                                          │
At drawingTime:                            │
  finalizeDrawing()  ◄──────────────────────┘
                    state: Selling → Bought

Megapot settles (jackpotLock → false, winningTicket != 0):
  claimDrawing()
    1. Reads getTicketTierIds for our tickets
    2. Reads getDrawingTierPayouts for the drawing
    3. Sets each ticket's winningsPerShare = tierPayout / sharesSold
       (undersubscribed tickets amplify per-share payout)
    4. Calls Jackpot.claimWinnings, pulling USDC into the contract

Users:
  withdrawWinnings(drawingId)
    Sums their shares × winningsPerShare across all tickets in the drawing.
    Zeroes the share ledger to prevent double-claim. Single USDC transfer.
```

## Key design decisions (locked in)

| Choice | Decision |
|---|---|
| Share price | 1¢ (10_000 USDC szabo) |
| Shares per ticket | 100 |
| Reserve seed | 365 USDC, by operator |
| Reserve withdrawable | Yes, by owner |
| Reserve drained behavior | `buyNextTicket` reverts; drawing halts gracefully |
| Per-wallet share cap | None (whales welcome) |
| Win payout rule | `tierPayout / sharesActuallySold` per ticket (undersubscription amplifies) |
| Pool's cut of winnings | Zero |
| Revenue model | Megapot's 10% referral fee, accrued at `feeReceiver` |
| `recipient` ≠ `referrer` enforced by Megapot | Solved by passing operator wallet as `feeReceiver` |
| Crank when ticket fills | Lazy — separate `buyNextTicket()` call, anyone can crank |
| Settlement crank | `finalizeDrawing()` + `claimDrawing()`, both permissionless |
| MIN_SELLING_WINDOW | 1 hour before drawing close |
| Claim pattern | Permissionless crank + user-pulled `withdrawWinnings(drawingId)` |
| Upgradeability | None — redeploy if needed |
| Multiple drawings tracked | Yes (separate state per `drawingId`) |

## Functions

### Users

- `buyShares(uint256 drawingId, uint8 count)` — buy 1..N shares (N capped to remaining capacity on active ticket)
- `withdrawWinnings(uint256 drawingId)` — claim all owed USDC for one drawing

### Permissionless cranks

- `buyNextTicket(uint256 drawingId)` — opens drawing on first call, or buys next ticket once active is full
- `finalizeDrawing(uint256 drawingId)` — closes share sales after drawingTime
- `claimDrawing(uint256 drawingId)` — claims all winnings, sets winningsPerShare per ticket
- `topUpReserve(uint256 amount)` — anyone can contribute USDC

### Owner

- `withdrawReserveSurplus(uint256 amount, address to)` — pull surplus from reserve
- `setPaused(bool)` — emergency stop on writes
- `transferOwnership(address) / acceptOwnership()` — two-step handoff

### Reads (for UI)

- `getDrawing(drawingId)`, `getTicket(drawingId, idx)`, `getMyShares(drawingId, idx, addr)`
- `getPendingWinnings(drawingId, addr)` — view-only mirror of `withdrawWinnings`'s sum

## Reserve economics

Per ticket:

| Subscription | Reserve out | Reserve in | Net reserve | Fee receiver |
|---|---|---|---|---|
| 100% (full) | −$1.00 | +$1.00 | $0 | +$0.10 |
| 50% (half) | −$1.00 | +$0.50 | −$0.50 | +$0.10 |
| 0% (empty) | −$1.00 | $0 | −$1.00 | +$0.10 |

In one drawing, only the **last partially-sold ticket** can be undersubscribed
(all prior tickets were 100% sold to trigger the next purchase). So the reserve's
worst-case loss per drawing is bounded by **$0.90** (one ticket, 0% sold, no win),
giving the 365 USDC seed ~13 months of life in the pathological case.

With wins, winnings flow to shareholders (not the reserve), but the fee receiver's
10¢-per-ticket keeps the operator whole.

## Deployment

1. Pick a fee-receiver wallet (NOT the PennyPot contract address). This wallet will
   accrue referral fees and can pull them anytime via `Jackpot.claimReferralFees()`.
2. Deploy `PennyPot.sol` with constructor args:
   - `_usdc` = `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` (USDC on Base)
   - `_jackpot` = `0x3bAe643002069dBCbcd62B1A4eb4C4A397d042a2` (Megapot Jackpot)
   - `_feeReceiver` = your operator wallet (see step 1)
   - `_owner` = your admin wallet (can be same as fee receiver, or different)
3. Seed the reserve:
   - `USDC.approve(pennyPot, 365_000_000)` from your operator wallet
   - `pennyPot.topUpReserve(365_000_000)`
4. Run a keeper that polls every ~30 minutes:
   - If `getDrawing(current).state == None` OR `nextTicketQueued == true`: call `buyNextTicket`
   - If `block.timestamp >= drawingTime` and `state == Selling`: call `finalizeDrawing`
   - If `state == Bought` and Megapot's `winningTicket != 0`: call `claimDrawing`

## Testing

```bash
# Install Foundry: https://book.getfoundry.sh
forge install foundry-rs/forge-std
forge test -vv
```

## Known limitations

- **A drawing always has ≥1 ticket.** `buyNextTicket` is the only path to open a
  drawing, and it always buys a ticket. If you want a drawing with zero tickets
  (e.g., emergency case where reserve was drained), there's no way to settle it
  cleanly in v1. Acceptable trade-off for the experiment.
- **`ticketPrice` change on Megapot bricks the contract.** `buyNextTicket` reverts
  if `Jackpot.ticketPrice() != 1 USDC`. If Megapot governance changes this,
  redeploy a fresh v2 against the new price.
- **No on-chain way to query "drawings I've participated in".** The UI must
  reconstruct user history from `SharesBought` events (indexed by `buyer`).

## Security notes

- `feeReceiver` is immutable. If the operator wallet is lost, referral fees still
  accumulate in Megapot but can't be claimed by anyone else. Choose carefully.
- `owner` can pause writes and pull reserve surplus, but **cannot** touch user
  winnings — `withdrawReserveSurplus` is bounded by `reservePool`, which only
  tracks reserve funds (not pending payouts).
- `claimDrawing` is permissionless. Anyone can crank it. If griefed by a bot that
  always wins the race, the keeper just pays slightly less gas.
- `transferOwnership` is two-step (start + accept) to prevent typo-bricking.
- No reentrancy guards — every state change happens before external USDC and
  Megapot calls, OR after them but only on safe internal arithmetic. USDC on
  Base is a non-reentrant token. Cross-check this assumption if forking.
