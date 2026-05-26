"use client";

import { useEffect, useState } from "react";
import {
  useAccount,
  useReadContracts,
  useWaitForTransactionReceipt,
  useWriteContract,
} from "wagmi";
import { base } from "wagmi/chains";
import { pennypotAbi } from "@/lib/abis";
import { PENNYPOT_ADDRESS } from "@/lib/addresses";
import { formatUsdc } from "@/lib/format";
import { useClaimable, useUserPositions } from "@/lib/hooks";

export function Positions() {
  const { address } = useAccount();
  const claimable = useClaimable(address);
  const { positions, loading, error } = useUserPositions(address);
  const [pendingHash, setPendingHash] = useState<`0x${string}` | undefined>();

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

  const { writeContract, isPending, error: writeError } = useWriteContract({
    mutation: { onSuccess: (h) => setPendingHash(h) },
  });
  const waiting = useWaitForTransactionReceipt({ hash: pendingHash });
  useEffect(() => {
    if (waiting.isSuccess) {
      claimable.refetch();
      setPendingHash(undefined);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [waiting.isSuccess]);

  function doWithdraw() {
    writeContract({
      address: PENNYPOT_ADDRESS,
      abi: pennypotAbi,
      functionName: "withdraw",
    });
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
                <div className="mt-1 text-[11px] text-ink-300">
                  Credited automatically when your winning tickets are claimed.
                </div>
              </div>
              <button
                type="button"
                onClick={doWithdraw}
                disabled={
                  isPending ||
                  waiting.isLoading ||
                  !claimable.data ||
                  claimable.data === 0n
                }
                className="rounded-xl bg-accent px-4 py-3 font-mono text-base font-bold text-ink-900 transition disabled:opacity-50 hover:shadow-glow"
              >
                {isPending || waiting.isLoading ? "withdrawing…" : "Withdraw"}
              </button>
            </div>

            {writeError ? (
              <div className="mt-2 break-all text-xs text-accent">
                {writeError.message.split("\n")[0]}
              </div>
            ) : null}
            {waiting.isSuccess ? (
              <div className="mt-2 text-xs text-accent">Withdrawn ✓</div>
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
                  {positions.map((p, i) => {
                    const det = ticketDetail.data?.[i]?.result as
                      | readonly [number, number, bigint, boolean]
                      | undefined;
                    const drawing = ticketDrawings.data?.[i]?.result as
                      | bigint
                      | undefined;
                    const drawingIds = drawingTicketLists.data?.[i]?.result as
                      | readonly bigint[]
                      | undefined;
                    const idx = drawingIds?.findIndex((id) => id === p.ticketId);
                    const ticketNumber =
                      idx !== undefined && idx >= 0 ? idx + 1 : undefined;
                    const claimed = det?.[3] ?? false;
                    const wps = det?.[2];
                    const owed = wps !== undefined ? wps * BigInt(p.shares) : 0n;
                    const status = !claimed
                      ? "selling / pending claim"
                      : wps && wps > 0n
                        ? `won ${formatUsdc(owed)}`
                        : "lost";
                    return (
                      <li
                        key={p.ticketId.toString()}
                        className="flex items-center justify-between gap-3 px-3 py-2 text-sm"
                      >
                        <div className="min-w-0">
                          <div className="truncate font-mono">
                            <span className="text-accent">
                              ticket #{ticketNumber ?? "—"}
                            </span>
                            <span className="text-ink-300">
                              {" "}
                              · drawing {drawing?.toString() ?? "—"}
                            </span>
                          </div>
                          <div className="text-[11px] text-ink-300">
                            {p.shares} share{p.shares === 1 ? "" : "s"} ({p.shares}%
                            of ticket)
                          </div>
                        </div>
                        <div
                          className={`shrink-0 font-mono text-xs ${
                            claimed && wps && wps > 0n
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
