# PennyPot

Buy 1¢ shares of Megapot lottery tickets. 1 share = 1% of that ticket's prize.
The pool keeps zero winnings. Operator revenue comes from Megapot's referral fees.

This package contains:

- `src/PennyPot.sol` — the main contract
- `src/interfaces/IJackpot.sol` — minimal interface to Megapot's Jackpot contract on Base

Tests are in `test/`, with a `MockJackpot` and `MockUSDC` for unit testing, and a
deploy script in `script/Deploy.s.sol`.

## Design: ticket-keyed, drawing-agnostic

PennyPot does **not** track drawing lifecycle on-chain. Drawings are indexed
off-chain, and Megapot itself is the source of truth for settlement — its
`claimWinnings` reverts until a ticket's drawing has settled. The contract is a
thin ledger keyed by the **Megapot ticket ID**:

- `soldOf[ticketId]` — shares sold (0..100)
- `shares[ticketId][user]` — share ownership
- `winningsPerShareOf[ticketId]` — set on claim; `tierPayout / sharesSold`
- `claimedOf[ticketId]` — settled-against-Megapot flag

A single active-ticket pointer (`activeTicketId` + `activeDeadline`) drives selling.
A `drawingId => ticketId[]` index is kept **only** as a read convenience
(`getDrawingTicketIds`); it never gates contract logic.

## Mechanic in one diagram

```
Reserve (seeded by operator)
    │
    │ −$1 (fronts ticket)
    ▼
buyNextTicket() ──► Jackpot.buyTickets(recipient=PennyPot, referrer=feeReceiver,
                                       split=[1e18], source=keccak256("pennypot"))
                                        │
                                        │ mints ticket NFT to PennyPot
                                        │ accrues referral fee to feeReceiver
                                        ▼
                            activeTicketId = #N (selling shares until activeDeadline)
                                        │
                                        │ 100 × buyShares(#N, ...) at 1¢ each
                                        │ each +1¢ → reserve
                                        ▼
                            #N full → anyone cranks buyNextTicket() again
                                        ⋮ (rolls within the drawing, then into the next)

Megapot settles (winningTicket != 0):
  claim([ticketIds])
    For each ticket: Jackpot.claimWinnings([id]), measure USDC delta,
    set winningsPerShare = ticketWin / sharesSold
    (undersubscribed tickets amplify per-share payout)

Users:
  withdraw([ticketIds])
    Sums their shares × winningsPerShare across the given (claimed) tickets,
    zeroes those entries, single USDC transfer.
```

## Key design decisions (locked in)

| Choice | Decision |
|---|---|
| Share price | 1¢ (10_000 USDC, 6-decimal) |
| Shares per ticket | 100 |
| Reserve seed | by operator via `topUpReserve` |
| Reserve withdrawable | Yes, by owner (capped at `reservePool`) |
| Reserve drained behavior | `buyNextTicket` reverts; selling halts gracefully |
| Per-wallet share cap | None (whales welcome) |
| Win payout rule | `tierPayout / sharesActuallySold` per ticket (undersubscription amplifies) |
| Pool's cut of winnings | Zero |
| Revenue model | Megapot referral fee, accrued at `feeReceiver` |
| Referral split | single 100% referrer, `[1e18]` (Megapot's 1e18 scale) |
| Source tag | `keccak256("pennypot")` |
| `recipient` ≠ `referrer` enforced by Megapot | operator wallet passed as `feeReceiver` |
| Drawing lifecycle on-chain | **None** — keyed off Megapot ticket IDs; drawings indexed off-chain |
| Settlement crank | `claim([ticketIds])`, permissionless; gated by Megapot, not internal state |
| MIN_SELLING_WINDOW | 1 hour before drawing close |
| Claim pattern | Permissionless `claim` + user-pulled `withdraw([ticketIds])` |
| Upgradeability | None — redeploy if needed |

## Functions

### Users

- `buyShares(uint256 expectedTicketId, uint8 count)` — buy 1..N shares of the active
  ticket. `expectedTicketId` guards against the active ticket rolling over between
  submit and execution.
- `withdraw(uint256[] ticketIds)` — pull owed USDC across the given claimed tickets.

### Permissionless cranks

- `buyNextTicket()` — front + buy the next Megapot ticket (into the current drawing);
  allowed only when the active ticket is full or its drawing's window has ended.
- `claim(uint256[] ticketIds)` — claim each ticket's winnings from Megapot and set its
  `winningsPerShare`. Idempotent (already-claimed tickets skipped).
- `topUpReserve(uint256 amount)` — anyone can contribute USDC.

### Owner

- `withdrawReserveSurplus(uint256 amount, address to)` — pull surplus from reserve.
- `setPaused(bool)` — emergency stop on writes.
- `transferOwnership(address) / acceptOwnership()` — two-step handoff.

### Reads (for UI)

- `activeTicketId()`, `activeDeadline()` — what's selling and until when.
- `getTicket(ticketId)` → `(sold, winningsPerShare, claimed)`.
- `getMyShares(ticketId, addr)`.
- `getDrawingTicketIds(drawingId)`, `getDrawingTicketCount(drawingId)` — enumerate a
  drawing's tickets without an off-chain index.
- `getPendingWinnings(addr, ticketIds[])` — claimable USDC across explicit tickets.
- `getPendingWinningsForDrawing(drawingId, addr)` — same, across a whole drawing.

## Reserve economics

Per ticket:

| Subscription | Reserve out | Reserve in | Net reserve | Fee receiver |
|---|---|---|---|---|
| 100% (full) | −$1.00 | +$1.00 | $0 | + referral fee |
| 50% (half) | −$1.00 | +$0.50 | −$0.50 | + referral fee |
| 0% (empty) | −$1.00 | $0 | −$1.00 | + referral fee |

Within one drawing only the **last partially-sold ticket** can be undersubscribed
(all prior tickets were 100% sold to trigger the next purchase). So the reserve's
worst-case loss per drawing is bounded by **$0.90** (one ticket, ≤10% sold, no win).

With wins, winnings flow to shareholders (not the reserve); the referral fee keeps
the operator whole.

## Deployment

The deploy script defaults to Base mainnet and PennyPot's referral address; override
any value via env vars.

```bash
# from packages/contracts
forge script script/Deploy.s.sol:Deploy --rpc-url $RPC_URL --broadcast --verify
```

Constructor args (`PennyPot(_usdc, _jackpot, _feeReceiver, _owner)`):

- `_usdc` = `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` (USDC on Base)
- `_jackpot` = `0x3bAe643002069dBCbcd62B1A4eb4C4A397d042a2` (Megapot Jackpot)
- `_feeReceiver` = referrer wallet, **not** the PennyPot address (default
  `0xDAdA5bAd8cdcB9e323d0606d081E6Dc5D3a577a1`); accrues referral fees, claimable via
  `Jackpot.claimReferralFees()`
- `_owner` = admin wallet (reserve mgmt + pause)

Then seed the reserve: `USDC.approve(pennyPot, amount)` then `pennyPot.topUpReserve(amount)`.

### Keeper loop (poll ~every 30 min)

- If there's no active ticket, or the active ticket is full, or its drawing window has
  ended (and reserve ≥ $1, and we're > MIN_SELLING_WINDOW from close): call `buyNextTicket()`.
- After a drawing settles on Megapot (`winningTicket != 0`): call
  `claim(getDrawingTicketIds(drawingId))` to settle that drawing's tickets.

## Testing

```bash
# Install Foundry: https://book.getfoundry.sh
git submodule update --init --recursive   # forge-std
forge test -vv
```

## Known limitations

- **`ticketPrice` change on Megapot bricks the contract.** `buyNextTicket` reverts if
  `Jackpot.ticketPrice() != 1 USDC`. If Megapot governance changes this, redeploy.
- **Winnings from a 0-share ticket stay in the contract balance.** If the reserve
  fronts a ticket nobody buys shares of and it wins, `winningsPerShare` can't be
  computed; the USDC remains in the balance (rare by construction).
- **No on-chain "drawings I've participated in".** By design — reconstruct user history
  off-chain from `SharesBought` / `TicketBought` events (indexed).

## Security notes

- `feeReceiver` is immutable. If the operator wallet is lost, referral fees still
  accumulate in Megapot but can't be claimed by anyone else. Choose carefully.
- `owner` can pause writes and pull reserve surplus, but **cannot** touch user
  winnings — `withdrawReserveSurplus` is bounded by `reservePool`, which only tracks
  reserve funds (not pending payouts).
- `claim` is permissionless and idempotent. Anyone can crank it.
- `transferOwnership` is two-step (start + accept) to prevent typo-bricking.
- No reentrancy guards — state changes precede external USDC/Megapot calls (or follow
  them on safe internal arithmetic). USDC on Base is non-reentrant; re-check if forking.
```
