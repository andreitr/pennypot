import { ethers } from "ethers";
import type { NextRequest } from "next/server";
import { PENNYPOT_ADDRESS } from "@/lib/addresses";

// Keeper cron: once a minute, check whether PennyPot can front the next Megapot
// ticket and, if so, crank PennyPot.buyTicket(). Triggered by Vercel Cron (see
// vercel.json). buyTicket() pulls the ticket cost from the contract's reserve
// and buys a quick-pick via Megapot's RandomTicketBuyer — the keeper wallet only
// needs ETH on Base for gas.
//
// Gas policy: we set NO gas fields. ethers populates gasLimit from
// eth_estimateGas and the EIP-1559 fees from provider.getFeeData(). A single
// buyTicket() should land well under ~1.3M gas; we run a pre-flight
// estimateGas purely as a sanity guard and refuse to send if it blows past that
// budget (which would signal something is wrong on-chain).

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

const BASE_CHAIN_ID = 8453;

// Safe upper bound for a single-ticket crank on Base. Informational guard only —
// not applied as a gasLimit override on the transaction.
const GAS_BUDGET = 1_300_000n;

// Minimal human-readable ABI for the two calls the keeper makes.
const PENNYPOT_KEEPER_ABI = [
  "function getState() view returns (uint256 currentDrawingId, uint256 currentTicketId, uint8 sold, uint64 deadline, bool canBuyNextTicket, uint256 reserve, bool isPaused)",
  "function buyTicket()",
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
  // Vercel Cron attaches `Authorization: Bearer <CRON_SECRET>` when CRON_SECRET
  // is configured. Reject anything that doesn't match so the endpoint can't be
  // triggered by arbitrary callers.
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
    PENNYPOT_KEEPER_ABI,
    wallet,
  );

  // 1) Can we buy? getState().canBuyNextTicket already simulates buyTicket()'s
  //    full guard set (pause, active-ticket-closed, price match, selling window,
  //    reserve), so it's the single source of truth.
  let state: ethers.Result;
  try {
    state = (await pennypot.getState()) as ethers.Result;
  } catch (e) {
    return Response.json(
      { error: `getState failed: ${(e as Error).message}` },
      { status: 502 },
    );
  }
  const canBuy = state.canBuyNextTicket as boolean;
  const paused = state.isPaused as boolean;
  const meta = {
    drawingId: (state.currentDrawingId as bigint).toString(),
    activeTicketId: (state.currentTicketId as bigint).toString(),
    sold: Number(state.sold as bigint),
    reserve: (state.reserve as bigint).toString(),
  };

  if (paused || !canBuy) {
    return Response.json({
      action: "skip",
      reason: paused ? "paused" : "cannot buy next ticket yet",
      ...meta,
    });
  }

  // 2) Pre-flight gas sanity guard (still send with NO gas overrides). A revert
  //    here means buyTicket() would revert this minute — treat as a soft skip.
  try {
    const est = await pennypot.buyTicket.estimateGas();
    if (est > GAS_BUDGET) {
      return Response.json(
        {
          action: "abort",
          reason: `gas estimate ${est.toString()} exceeds budget ${GAS_BUDGET.toString()}`,
          ...meta,
        },
        { status: 500 },
      );
    }
  } catch (e) {
    return Response.json({
      action: "skip",
      reason: `buyTicket would revert: ${(e as Error).message.split("\n")[0]}`,
      ...meta,
    });
  }

  // 3) Crank it. No gas fields set: ethers fills gasLimit (eth_estimateGas) and
  //    EIP-1559 maxFeePerGas/maxPriorityFeePerGas (getFeeData).
  try {
    const tx = await pennypot.buyTicket();
    const receipt = await tx.wait(1);
    return Response.json({
      action: "bought",
      txHash: tx.hash,
      blockNumber: receipt?.blockNumber ?? null,
      gasUsed: receipt?.gasUsed?.toString() ?? null,
      ...meta,
    });
  } catch (e) {
    return Response.json(
      { action: "error", error: (e as Error).message, ...meta },
      { status: 500 },
    );
  }
}
