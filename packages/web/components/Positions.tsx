"use client";

import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import {
  useAccount,
  useChainId,
  usePublicClient,
  useReadContracts,
  useWriteContract,
} from "wagmi";
import { base } from "wagmi/chains";
import { jackpotAbi, pennypotAbi } from "@/lib/abis";
import { JACKPOT_ADDRESS, PENNYPOT_ADDRESS } from "@/lib/addresses";
import { formatUsdc } from "@/lib/format";
import { useClaimable, useUserPositions } from "@/lib/hooks";

export function Positions() {
  const { address } = useAccount();
  const chainId = useChainId();
  const wrongChain = !!address && chainId !== base.id;
  const queryClient = useQueryClient();
  const claimable = useClaimable(address);
  const { positions, loading, error } = useUserPositions(address);

  // Per-ticket details for the user's positions (so we can show settlement state).
  const ticketDetail = useReadContracts({
    contracts: (positions ?? []).map((p) => ({
      chainId: base.id,
      address: PENNYPOT_ADDRESS,
      abi: pennypotAbi,
      functionName: "getTicket" as const,
      args: [p.ticketId] as const,
    })),
    query: { enabled: !!positions && positions.length > 0, refetchInterval: 30_000 },
  });

  // Also surface each ticket's drawing for grouping/display.
  const ticketDrawings = useReadContracts({
    contracts: (positions ?? []).map((p) => ({
      chainId: base.id,
      address: PENNYPOT_ADDRESS,
      abi: pennypotAbi,
      functionName: "ticketDrawingId" as const,
      args: [p.ticketId] as const,
    })),
    query: { enabled: !!positions && positions.length > 0, refetchInterval: 60_000 },
  });

  // For each position, fetch the full ticket id list of its drawing — lets us
  // show the friendly 1-based "Ticket #N of drawing M" instead of the 256-bit id.
  const drawingTicketLists = useReadContracts({
    contracts: (positions ?? []).map((_p, i) => {
      const drawing = ticketDrawings.data?.[i]?.result as bigint | undefined;
      return {
        chainId: base.id,
        address: PENNYPOT_ADDRESS,
        abi: pennypotAbi,
        functionName: "getDrawingTicketIds" as const,
        args: [drawing ?? 0n] as const,
      };
    }),
    query: {
      enabled:
        !!positions &&
        positions.length > 0 &&
        !!ticketDrawings.data &&
        ticketDrawings.data.every((r) => r?.result !== undefined),
      refetchInterval: 60_000,
    },
  });

  // Each position's drawing close time (Megapot getDrawingState.drawingTime) so
  // we can label the row with the drawing date instead of a raw drawing id.
  const drawingStates = useReadContracts({
    contracts: (positions ?? []).map((_p, i) => {
      const drawing = ticketDrawings.data?.[i]?.result as bigint | undefined;
      return {
        chainId: base.id,
        address: JACKPOT_ADDRESS,
        abi: jackpotAbi,
        functionName: "getDrawingState" as const,
        args: [drawing ?? 0n] as const,
      };
    }),
    query: {
      enabled:
        !!positions &&
        positions.length > 0 &&
        !!ticketDrawings.data &&
        ticketDrawings.data.every((r) => r?.result !== undefined),
      refetchInterval: 300_000,
    },
  });

  // Combine each position with its on-chain detail + drawing date, then sort
  // newest-drawing-first for display.
  const rows = (positions ?? [])
    .map((p, i) => {
      const det = ticketDetail.data?.[i]?.result as
        | readonly [number, number, bigint, boolean]
        | undefined;
      const drawing = ticketDrawings.data?.[i]?.result as bigint | undefined;
      const drawingIds = drawingTicketLists.data?.[i]?.result as
        | readonly bigint[]
        | undefined;
      const ds = drawingStates.data?.[i]?.result as
        | { drawingTime: bigint }
        | undefined;
      const idx = drawingIds?.findIndex((id) => id === p.ticketId);
      const ticketNumber = idx !== undefined && idx >= 0 ? idx + 1 : undefined;
      const claimed = det?.[3] ?? false;
      const wps = det?.[2];
      const owed = wps !== undefined ? wps * BigInt(p.shares) : 0n;
      return {
        ticketId: p.ticketId,
        shares: p.shares,
        drawing,
        drawingTime: ds?.drawingTime,
        ticketNumber,
        claimed,
        wps,
        owed,
      };
    })
    .sort((a, b) => {
      const da = a.drawing ?? 0n;
      const db = b.drawing ?? 0n;
      return da === db ? 0 : db > da ? 1 : -1;
    });

  const publicClient = usePublicClient({ chainId: base.id });
  const { writeContractAsync } = useWriteContract();
  const [withdrawing, setWithdrawing] = useState(false);
  const [writeError, setWriteError] = useState<string | undefined>();

  async function doWithdraw() {
    if (!publicClient || !address) return;
    const amount = claimable.data ?? 0n;
    setWriteError(undefined);
    setWithdrawing(true);
    const toastId = toast.loading(
      `Withdrawing ${formatUsdc(amount)}… (confirm in wallet)`,
    );
    try {
      const hash = await writeContractAsync({
        address: PENNYPOT_ADDRESS,
        abi: pennypotAbi,
        functionName: "withdraw",
      });
      toast.loading(`Waiting for withdrawal to confirm on-chain…`, {
        id: toastId,
      });
      const receipt = await publicClient.waitForTransactionReceipt({ hash });

      // Anchor the post-tx read to the receipt's block so RPC node lag can't
      // serve stale data — poll up to ~6s until we observe the cleared balance.
      for (let i = 0; i < 12; i++) {
        try {
          const newBalance = (await publicClient.readContract({
            address: PENNYPOT_ADDRESS,
            abi: pennypotAbi,
            functionName: "balance",
            args: [address],
            blockNumber: receipt.blockNumber,
          })) as bigint;
          if (newBalance < amount) break;
        } catch {
          // RPC behind on this block — wait and retry.
        }
        await new Promise((r) => setTimeout(r, 500));
      }

      queryClient.invalidateQueries();
      toast.success(`Withdrew ${formatUsdc(amount)}`, {
        id: toastId,
        description: `Sent to your wallet on Base.`,
        duration: 6000,
      });
    } catch (e) {
      const msg = (e as Error).message.split("\n")[0];
      const userRejected = /reject|denied|user/i.test(msg);
      toast.error(userRejected ? "Wallet rejected the request" : "Withdrawal failed", {
        id: toastId,
        description: userRejected ? undefined : msg.slice(0, 180),
      });
      setWriteError(msg);
    } finally {
      setWithdrawing(false);
    }
  }

  return (
    <section className="relative z-10 mx-auto w-full max-w-3xl px-4 py-6">
      <SectionHeader title="My positions" />

      <div className="rounded-2xl border border-ink-500 bg-ink-700/60 p-5 sm:p-7">
        {!address ? (
          <p className="text-ink-200">Connect a wallet to see your positions.</p>
        ) : (
          <>
            {/* Claimable balance + withdraw */}
            <div className="flex flex-wrap items-end justify-between gap-3">
              <div>
                <div className="text-[10px] uppercase tracking-widest text-ink-300">
                  Claimable winnings
                </div>
                <div className="mt-1 font-mono text-3xl font-bold text-accent">
                  {formatUsdc(claimable.data)}
                </div>
              </div>
              <button
                type="button"
                onClick={doWithdraw}
                disabled={
                  wrongChain ||
                  withdrawing ||
                  !claimable.data ||
                  claimable.data === 0n
                }
                className="rounded-xl bg-accent px-4 py-3 font-mono text-base font-bold text-ink-900 transition disabled:opacity-50 hover:shadow-glow"
              >
                {wrongChain
                  ? "switch to Base"
                  : withdrawing
                    ? "withdrawing…"
                    : "Withdraw"}
              </button>
            </div>

            {writeError ? (
              <div className="mt-2 break-all text-xs text-accent">
                {writeError}
              </div>
            ) : null}

            {/* Per-ticket history */}
            <div className="mt-6">
              <div className="text-[10px] uppercase tracking-widest text-ink-300">
                Tickets you hold shares in
              </div>
              {loading ? (
                <div className="mt-2 text-sm text-ink-300">loading from logs…</div>
              ) : error ? (
                <div className="mt-2 text-xs text-accent">{error}</div>
              ) : !positions || positions.length === 0 ? (
                <div className="mt-2 text-sm text-ink-300">
                  No share purchases yet.
                </div>
              ) : (
                <ul className="mt-2 divide-y divide-ink-500/60 rounded-lg border border-ink-500/60">
                  {rows.map((r) => {
                    const status = !r.claimed
                      ? "active"
                      : r.wps && r.wps > 0n
                        ? `won ${formatUsdc(r.owed)}`
                        : "lost";
                    const dateLabel =
                      r.drawingTime !== undefined
                        ? new Date(
                            Number(r.drawingTime) * 1000,
                          ).toLocaleDateString("en-US", {
                            month: "long",
                            day: "numeric",
                            year: "numeric",
                          })
                        : "—";
                    return (
                      <li
                        key={r.ticketId.toString()}
                        className="flex items-center justify-between gap-3 px-3 py-2 text-sm"
                      >
                        <div className="min-w-0">
                          <div className="truncate font-mono">
                            <span className="text-accent">{dateLabel}</span>
                            <span className="text-ink-300">
                              {" "}
                              · ticket #{r.ticketNumber ?? "—"}
                            </span>
                          </div>
                          <div className="text-[11px] text-ink-300">
                            {r.shares} share{r.shares === 1 ? "" : "s"} ({r.shares}
                            % of ticket)
                          </div>
                        </div>
                        <div
                          className={`shrink-0 font-mono text-xs ${
                            r.claimed && r.wps && r.wps > 0n
                              ? "text-accent"
                              : "text-ink-200"
                          }`}
                        >
                          {status}
                        </div>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          </>
        )}
      </div>
    </section>
  );
}

function SectionHeader({ title }: { title: string }) {
  return (
    <h2 className="mb-3 px-1 font-mono text-xs uppercase tracking-[0.25em] text-ink-300">
      ▌ {title}
    </h2>
  );
}
