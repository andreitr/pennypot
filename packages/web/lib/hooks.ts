"use client";

import { useEffect, useMemo, useState } from "react";
import type { Address } from "viem";
import {
  useAccount,
  useChainId,
  usePublicClient,
  useReadContract,
  useReadContracts,
} from "wagmi";
import { base } from "wagmi/chains";
import { erc20Abi, jackpotAbi, pennypotAbi } from "./abis";
import {
  JACKPOT_ADDRESS,
  PENNYPOT_ADDRESS,
  PENNYPOT_DEPLOY_BLOCK,
  USDC_ADDRESS,
} from "./addresses";

// Single live-state read used by Hero / Buy / Cranks.
export function useGetState() {
  return useReadContract({
    chainId: base.id,
    address: PENNYPOT_ADDRESS,
    abi: pennypotAbi,
    functionName: "getState",
    query: { refetchInterval: 15_000 },
  });
}

// Megapot drawing close (canonical "time to drawing close" — handles rollover
// edges where the active ticket belongs to a just-closed drawing).
export function useMegapotDrawingTime() {
  const id = useReadContract({
    chainId: base.id,
    address: JACKPOT_ADDRESS,
    abi: jackpotAbi,
    functionName: "currentDrawingId",
    query: { refetchInterval: 30_000 },
  });
  const state = useReadContract({
    chainId: base.id,
    address: JACKPOT_ADDRESS,
    abi: jackpotAbi,
    functionName: "getDrawingState",
    args: id.data !== undefined ? [id.data] : undefined,
    query: { enabled: id.data !== undefined, refetchInterval: 30_000 },
  });
  return {
    drawingId: id.data,
    drawingTime: state.data?.drawingTime,
    raw: state.data,
  };
}

// User USDC balance + allowance for PennyPot (Buy section).
export function useUsdc(user?: Address) {
  return useReadContracts({
    contracts: [
      {
        chainId: base.id,
        address: USDC_ADDRESS,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [user ?? "0x0000000000000000000000000000000000000000"],
      },
      {
        chainId: base.id,
        address: USDC_ADDRESS,
        abi: erc20Abi,
        functionName: "allowance",
        args: [user ?? "0x0000000000000000000000000000000000000000", PENNYPOT_ADDRESS],
      },
    ],
    query: { enabled: Boolean(user), refetchInterval: 15_000 },
  });
}

// Per-user PennyPot claimable balance (Positions "withdraw" amount).
export function useClaimable(user?: Address) {
  return useReadContract({
    chainId: base.id,
    address: PENNYPOT_ADDRESS,
    abi: pennypotAbi,
    functionName: "balance",
    args: user ? [user] : undefined,
    query: { enabled: Boolean(user), refetchInterval: 15_000 },
  });
}

// User's per-ticket history — derived from SharesBought logs filtered by buyer.
// (No on-chain "tickets I've ever bought into" enumeration; this is the canonical
// off-chain replay path.)
export type Position = {
  ticketId: bigint;
  shares: number; // sum of buyer's share count across all SharesBought events
};

export function useUserPositions(user?: Address) {
  const publicClient = usePublicClient({ chainId: base.id });
  const chainId = useChainId();
  const [positions, setPositions] = useState<Position[] | undefined>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [nonce, setNonce] = useState(0);

  // Poll every 15s; re-fetch on user/chain change.
  useEffect(() => {
    if (!user || !publicClient) {
      setPositions(undefined);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(undefined);
    (async () => {
      try {
        const logs = await publicClient.getLogs({
          address: PENNYPOT_ADDRESS,
          event: {
            type: "event",
            name: "SharesBought",
            inputs: [
              { name: "ticketId", type: "uint256", indexed: true },
              { name: "buyer", type: "address", indexed: true },
              { name: "count", type: "uint8", indexed: false },
              { name: "newSold", type: "uint8", indexed: false },
            ],
          },
          args: { buyer: user },
          fromBlock: PENNYPOT_DEPLOY_BLOCK,
          toBlock: "latest",
        });
        if (cancelled) return;
        const byTicket = new Map<bigint, number>();
        for (const l of logs) {
          const tid = l.args.ticketId as bigint;
          const cnt = Number(l.args.count as number);
          byTicket.set(tid, (byTicket.get(tid) ?? 0) + cnt);
        }
        const out: Position[] = Array.from(byTicket.entries())
          .map(([ticketId, shares]) => ({ ticketId, shares }))
          .sort((a, b) => (a.ticketId < b.ticketId ? 1 : -1)); // newest first
        setPositions(out);
      } catch (e) {
        if (!cancelled) setError((e as Error).message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [user, publicClient, chainId, nonce]);

  useEffect(() => {
    const t = setInterval(() => setNonce((n) => n + 1), 15_000);
    return () => clearInterval(t);
  }, []);

  return { positions, loading, error };
}

// Per-ticket detail: (shares, holders, winningsPerShare, claimed).
export function useTicket(ticketId?: bigint) {
  return useReadContract({
    chainId: base.id,
    address: PENNYPOT_ADDRESS,
    abi: pennypotAbi,
    functionName: "getTicket",
    args: ticketId !== undefined ? [ticketId] : undefined,
    query: { enabled: ticketId !== undefined, refetchInterval: 15_000 },
  });
}

// Tickets in a drawing — used by the Cranks section to assemble claimWinnings args.
export function useDrawingTicketIds(drawingId?: bigint) {
  return useReadContract({
    chainId: base.id,
    address: PENNYPOT_ADDRESS,
    abi: pennypotAbi,
    functionName: "getDrawingTicketIds",
    args: drawingId !== undefined ? [drawingId] : undefined,
    query: { enabled: drawingId !== undefined, refetchInterval: 30_000 },
  });
}

// "Now" tick for countdowns. Re-renders every second.
export function useNow() {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  return now;
}

export function useConnected(): Address | undefined {
  const { address } = useAccount();
  return address;
}

// Re-export some constants for component use.
export const CONSTS = {
  TICKET_PRICE_USDC: 1_000_000n, // 1 USDC = 1e6
  SHARE_PRICE_USDC: 10_000n, // 0.01 USDC = 1e4
  SHARES_PER_TICKET: 100,
  MIN_SELLING_WINDOW_SEC: 3600,
} as const;

// Memo-stable helpers.
export function useDerived() {
  return useMemo(
    () => ({
      sharePriceUsdc: CONSTS.SHARE_PRICE_USDC,
      ticketPriceUsdc: CONSTS.TICKET_PRICE_USDC,
      sharesPerTicket: CONSTS.SHARES_PER_TICKET,
    }),
    [],
  );
}
