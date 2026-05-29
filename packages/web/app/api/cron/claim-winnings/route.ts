import { ethers } from "ethers";
import type { NextRequest } from "next/server";
import { JACKPOT_ADDRESS, PENNYPOT_ADDRESS } from "@/lib/addresses";

// Keeper cron: at :10 past every hour, settle PennyPot's tickets for recently
// SETTLED Megapot rounds by calling PennyPot.claimWinnings(). That call is what
// credits each shareholder's withdrawable `claimable` balance — without it, a
// winning round's prize sits unclaimed on Megapot and never reaches users.
//
// We pass ALL unclaimed tickets of each settled round (not just winners):
//   - The contract already restricts the expensive Megapot claim to actual
//     winners; losers are a cheap tier-read + mark-settled (no external call).
//   - Settling losers transitions them to "lost" in the Positions UI (otherwise
//     they'd read "pending claim" forever).
// claimWinnings is permissionless and idempotent: already-claimed tickets are
// skipped and unsettled drawings revert, so re-runs are safe.
//
// Gas policy: unlike buy-ticket (no gas fields), claim flows have variable gas,
// so we estimate and apply a +30% buffer to gasLimit. EIP-1559 fees are left
// unset (ethers fills them from getFeeData()).

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const BASE_CHAIN_ID = 8453;
const ROUND_LOOKBACK = 3; // scan the last N rounds so late/missed settlements still get swept
const MAX_CLAIM_BATCH = 40; // cap ids per tx to stay well under block gas
const GAS_BUFFER_BPS = 130n; // +30% over the estimate

const PENNYPOT_CLAIM_ABI = [
  "function getDrawingTicketIds(uint256 drawingId) view returns (uint256[])",
  "function getTicket(uint256 ticketId) view returns (uint8 shares, uint8 holders, uint256 winningsPerShare, bool claimed)",
  "function claimWinnings(uint256[] ticketIds)",
];

const JACKPOT_ABI = [
  "function currentDrawingId() view returns (uint256)",
  "function getDrawingState(uint256 _drawingId) view returns (tuple(uint256 prizePool, uint256 ticketPrice, uint256 edgePerTicket, uint256 referralWinShare, uint256 referralFee, uint256 globalTicketsBought, uint256 lpEarnings, uint256 drawingTime, uint256 winningTicket, uint8 ballMax, uint8 bonusballMax, address payoutCalculator, bool jackpotLock))",
];

function resolveRpcUrl(): string | undefined {
  const explicit =
    process.env.BASE_RPC_URL || process.env.NEXT_PUBLIC_BASE_RPC_URL;
  if (explicit) return explicit;
  const key =
    process.env.ALCHEMY_API_KEY || process.env.NEXT_PUBLIC_ALCHEMY_API_KEY;
  return key ? `https://base-mainnet.g.alchemy.com/v2/${key}` : undefined;
}

export async function GET(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (secret) {
    if (req.headers.get("authorization") !== `Bearer ${secret}`) {
      return Response.json({ error: "unauthorized" }, { status: 401 });
    }
  }

  const rpcUrl = resolveRpcUrl();
  if (!rpcUrl) {
    return Response.json(
      { error: "no RPC configured (set ALCHEMY_API_KEY or BASE_RPC_URL)" },
      { status: 500 },
    );
  }
  const pk = process.env.KEEPER_PK;
  if (!pk) {
    return Response.json({ error: "KEEPER_PK not set" }, { status: 500 });
  }

  const provider = new ethers.JsonRpcProvider(rpcUrl, BASE_CHAIN_ID);
  const wallet = new ethers.Wallet(pk, provider);
  const pennypot = new ethers.Contract(
    PENNYPOT_ADDRESS,
    PENNYPOT_CLAIM_ABI,
    wallet,
  );
  const jackpot = new ethers.Contract(JACKPOT_ADDRESS, JACKPOT_ABI, provider);

  // currentDrawingId is the OPEN (unsettled) round; settled rounds are below it.
  let currentId: bigint;
  try {
    currentId = (await jackpot.currentDrawingId()) as bigint;
  } catch (e) {
    return Response.json(
      { error: `currentDrawingId failed: ${(e as Error).message}` },
      { status: 502 },
    );
  }

  const rounds: Array<{
    round: string;
    settled: boolean;
    tickets: number;
    pending: number;
  }> = [];
  const unclaimed: bigint[] = [];

  for (let k = 1; k <= ROUND_LOOKBACK; k++) {
    const round = currentId - BigInt(k);
    if (round <= 0n) break;

    let settled = false;
    try {
      const ds = await jackpot.getDrawingState(round);
      settled = (ds.winningTicket as bigint) !== 0n;
    } catch {
      // treat an unreadable drawing as not-yet-settled
    }
    if (!settled) {
      rounds.push({ round: round.toString(), settled: false, tickets: 0, pending: 0 });
      continue;
    }

    const ids = (await pennypot.getDrawingTicketIds(round)) as bigint[];
    if (ids.length === 0) {
      rounds.push({ round: round.toString(), settled: true, tickets: 0, pending: 0 });
      continue;
    }
    const claimedFlags = await Promise.all(
      ids.map((id) => pennypot.getTicket(id).then((t) => t.claimed as boolean)),
    );
    const pendingIds = ids.filter((_, i) => !claimedFlags[i]);
    unclaimed.push(...pendingIds);
    rounds.push({
      round: round.toString(),
      settled: true,
      tickets: ids.length,
      pending: pendingIds.length,
    });
  }

  if (unclaimed.length === 0) {
    return Response.json({
      action: "skip",
      reason: "nothing to settle",
      currentDrawingId: currentId.toString(),
      rounds,
    });
  }

  const batch = unclaimed.slice(0, MAX_CLAIM_BATCH);

  // Gas-buffered estimate: claim gas scales with the number of winners, so a
  // bare estimate can under-provision. Apply +30% to gasLimit; leave fees to
  // ethers (getFeeData).
  let gasLimit: bigint;
  try {
    const est = (await pennypot.claimWinnings.estimateGas(batch)) as bigint;
    gasLimit = (est * GAS_BUFFER_BPS) / 100n;
  } catch (e) {
    return Response.json(
      {
        action: "error",
        error: `estimateGas failed: ${(e as Error).message.split("\n")[0]}`,
        rounds,
      },
      { status: 500 },
    );
  }

  try {
    const tx = await pennypot.claimWinnings(batch, { gasLimit });
    const receipt = await tx.wait(1);
    return Response.json({
      action: "claimed",
      txHash: tx.hash,
      claimed: batch.length,
      remaining: unclaimed.length - batch.length,
      blockNumber: receipt?.blockNumber ?? null,
      gasUsed: receipt?.gasUsed?.toString() ?? null,
      currentDrawingId: currentId.toString(),
      rounds,
    });
  } catch (e) {
    return Response.json(
      { action: "error", error: (e as Error).message, rounds },
      { status: 500 },
    );
  }
}
