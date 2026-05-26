"use client";

import { useEffect, useMemo, useState } from "react";
import { useAccount, useWaitForTransactionReceipt, useWriteContract } from "wagmi";
import { erc20Abi, pennypotAbi } from "@/lib/abis";
import { PENNYPOT_ADDRESS, USDC_ADDRESS } from "@/lib/addresses";
import { formatUsdc } from "@/lib/format";
import { CONSTS, useGetState, useUsdc } from "@/lib/hooks";

export function Buy() {
  const { address } = useAccount();
  const { data: state } = useGetState();
  const usdc = useUsdc(address);
  const [count, setCount] = useState(10);
  const [pendingHash, setPendingHash] = useState<`0x${string}` | undefined>();

  const ticketId = state?.[1];
  const sold = state?.[2] ?? 0;
  const canBuy = state?.[4] ?? false; // canBuyNextTicket — true means "active is closed"; we want the opposite for buying SHARES
  const paused = state?.[6] ?? false;

  // The shares-buying window: an active ticket exists, isn't full, deadline not passed.
  // We approximate by: ticketId != 0, sold < 100, and canBuyNextTicket == false
  // (since canBuyNextTicket flips true precisely when buyTicket() can roll, i.e.
  // the active ticket is "closed").
  const sellingActive =
    !paused && ticketId !== undefined && ticketId > 0n && sold < 100 && !canBuy;

  // Cap to remaining capacity.
  const remaining = Math.max(0, CONSTS.SHARES_PER_TICKET - sold);
  const cappedCount = Math.max(0, Math.min(count, remaining));
  const costUsdc = BigInt(cappedCount) * CONSTS.SHARE_PRICE_USDC;

  const usdcBalance = usdc.data?.[0]?.result as bigint | undefined;
  const allowance = usdc.data?.[1]?.result as bigint | undefined;
  const needsApprove = allowance !== undefined && allowance < costUsdc;
  const insufficientBalance =
    usdcBalance !== undefined && usdcBalance < costUsdc;

  const { writeContract, isPending, error: writeError } = useWriteContract({
    mutation: {
      onSuccess: (hash) => setPendingHash(hash),
    },
  });

  const waiting = useWaitForTransactionReceipt({ hash: pendingHash });
  useEffect(() => {
    if (waiting.isSuccess) {
      // Refresh allowance + balance after a successful tx
      usdc.refetch();
      setPendingHash(undefined);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [waiting.isSuccess]);

  // EV-amplification hook: with `count` more shares sold, the buyer's slice is
  // count / (sold + count). Show it as a percentage.
  const sliceLabel = useMemo(() => {
    const denom = sold + cappedCount;
    if (cappedCount <= 0 || denom <= 0) return null;
    const pct = (cappedCount / denom) * 100;
    return `${cappedCount}/${denom} = ${pct.toFixed(1)}%`;
  }, [cappedCount, sold]);

  function doApprove() {
    writeContract({
      address: USDC_ADDRESS,
      abi: erc20Abi,
      functionName: "approve",
      args: [PENNYPOT_ADDRESS, costUsdc],
    });
  }

  function doBuy() {
    if (!ticketId) return;
    writeContract({
      address: PENNYPOT_ADDRESS,
      abi: pennypotAbi,
      functionName: "buyTicketShares",
      args: [ticketId, cappedCount],
    });
  }

  return (
    <section className="relative z-10 mx-auto w-full max-w-3xl px-4 py-6">
      <SectionHeader title="Buy shares" />

      <div className="rounded-2xl border border-ink-500 bg-ink-700/60 p-5 sm:p-7">
        {!address ? (
          <p className="text-ink-200">Connect a wallet to buy.</p>
        ) : paused ? (
          <p className="text-accent">Contract is paused.</p>
        ) : !sellingActive ? (
          <p className="text-ink-200">
            {ticketId && ticketId > 0n && sold >= 100
              ? "Active ticket is full. Crank the next ticket below to keep buying."
              : ticketId === 0n
                ? "No active ticket yet. Crank the first ticket below."
                : "Selling is paused for this drawing window. Check back after the next ticket is fronted."}
          </p>
        ) : (
          <>
            <div className="flex flex-wrap items-end justify-between gap-4">
              <div>
                <label className="text-[10px] uppercase tracking-widest text-ink-300">
                  Shares to buy (1¢ each, max {remaining})
                </label>
                <div className="mt-2 flex items-center gap-2">
                  <button
                    type="button"
                    aria-label="-10"
                    onClick={() => setCount((c) => Math.max(1, c - 10))}
                    className="rounded-md border border-ink-500 px-2 py-1 font-mono hover:border-accent"
                  >
                    −10
                  </button>
                  <button
                    type="button"
                    aria-label="-1"
                    onClick={() => setCount((c) => Math.max(1, c - 1))}
                    className="rounded-md border border-ink-500 px-2 py-1 font-mono hover:border-accent"
                  >
                    −1
                  </button>
                  <input
                    type="number"
                    min={1}
                    max={remaining}
                    value={count}
                    onChange={(e) =>
                      setCount(
                        Math.max(1, Math.min(remaining, Number(e.target.value) || 1)),
                      )
                    }
                    className="w-24 rounded-md border border-ink-500 bg-ink-800 px-3 py-2 text-center font-mono text-lg outline-none focus:border-accent"
                  />
                  <button
                    type="button"
                    aria-label="+1"
                    onClick={() => setCount((c) => Math.min(remaining, c + 1))}
                    className="rounded-md border border-ink-500 px-2 py-1 font-mono hover:border-accent"
                  >
                    +1
                  </button>
                  <button
                    type="button"
                    aria-label="+10"
                    onClick={() => setCount((c) => Math.min(remaining, c + 10))}
                    className="rounded-md border border-ink-500 px-2 py-1 font-mono hover:border-accent"
                  >
                    +10
                  </button>
                  <button
                    type="button"
                    onClick={() => setCount(remaining)}
                    className="ml-1 rounded-md border border-accent/40 px-2 py-1 font-mono text-accent hover:border-accent"
                  >
                    max
                  </button>
                </div>
              </div>
              <div className="text-right">
                <div className="text-[10px] uppercase tracking-widest text-ink-300">
                  cost
                </div>
                <div className="font-mono text-2xl font-bold text-accent">
                  {formatUsdc(costUsdc, { dp: 2 })}
                </div>
                <div className="font-mono text-[11px] text-ink-300">
                  USDC balance: {formatUsdc(usdcBalance)}
                </div>
              </div>
            </div>

            {/* EV / undersubscription hook */}
            <div className="mt-5 rounded-lg border border-ink-500 bg-ink-800/70 p-3 font-mono text-sm">
              {sliceLabel ? (
                <>
                  <span className="text-ink-300">if ticket wins, your slice =</span>{" "}
                  <span className="text-accent">{sliceLabel}</span>{" "}
                  <span className="text-ink-300">of the prize</span>
                  <div className="mt-1 text-[11px] text-ink-300">
                    (current ticket {sold}/100 sold — undersubscription amplifies your payout per share)
                  </div>
                </>
              ) : (
                <span className="text-ink-300">enter a count above</span>
              )}
            </div>

            {/* CTA */}
            <div className="mt-5 flex flex-col gap-2 sm:flex-row sm:items-center">
              {needsApprove ? (
                <button
                  type="button"
                  onClick={doApprove}
                  disabled={isPending || waiting.isLoading || cappedCount === 0}
                  className="w-full rounded-xl bg-accent px-4 py-3 font-mono text-base font-bold text-ink-900 transition disabled:opacity-50 hover:shadow-glow sm:w-auto"
                >
                  {isPending || waiting.isLoading
                    ? "approving…"
                    : `Approve USDC ${formatUsdc(costUsdc)}`}
                </button>
              ) : (
                <button
                  type="button"
                  onClick={doBuy}
                  disabled={
                    isPending ||
                    waiting.isLoading ||
                    cappedCount === 0 ||
                    insufficientBalance
                  }
                  className="w-full rounded-xl bg-accent px-4 py-3 font-mono text-base font-bold text-ink-900 transition disabled:opacity-50 hover:shadow-glow sm:w-auto"
                >
                  {isPending || waiting.isLoading
                    ? "buying…"
                    : `Buy ${cappedCount} share${cappedCount === 1 ? "" : "s"} · ${formatUsdc(costUsdc)}`}
                </button>
              )}
              {insufficientBalance ? (
                <span className="text-sm text-accent">Not enough USDC.</span>
              ) : null}
            </div>

            {writeError ? (
              <div className="mt-2 break-all text-xs text-accent">
                {writeError.message.split("\n")[0]}
              </div>
            ) : null}
            {waiting.isSuccess ? (
              <div className="mt-2 text-xs text-accent">Confirmed ✓</div>
            ) : null}
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
