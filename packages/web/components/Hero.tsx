"use client";

import { useMemo } from "react";
import { useReadContract } from "wagmi";
import { base } from "wagmi/chains";
import { pennypotAbi } from "@/lib/abis";
import { PENNYPOT_ADDRESS } from "@/lib/addresses";
import { countdown, formatUsdc } from "@/lib/format";
import {
  useGetState,
  useMegapotDrawingTime,
  useNow,
} from "@/lib/hooks";

export function Hero() {
  const { data, isLoading } = useGetState();
  const { drawingTime: megapotDeadline, topPrize } = useMegapotDrawingTime();
  const now = useNow();

  const drawingId = data?.[0];
  const ticketId = data?.[1];
  const sold = data?.[2] ?? 0;
  const activeDeadline = data?.[3];
  const canBuy = data?.[4] ?? false;
  const reserve = data?.[5];
  const paused = data?.[6] ?? false;

  // Use the active ticket's deadline when there's a live active ticket; otherwise
  // fall back to Megapot's current drawing close.
  const liveDeadline =
    activeDeadline && activeDeadline > 0n ? activeDeadline : megapotDeadline;
  const cd = countdown(liveDeadline, now);

  // All ticket ids bought in this drawing — gives us per-drawing count AND the
  // 1-based position of the active ticket ("Ticket #3 of this drawing").
  const drawingTickets = useReadContract({
    chainId: base.id,
    address: PENNYPOT_ADDRESS,
    abi: pennypotAbi,
    functionName: "getDrawingTicketIds",
    args: drawingId !== undefined ? [drawingId] : undefined,
    query: { enabled: drawingId !== undefined, refetchInterval: 15_000 },
  });
  const ticketCount = drawingTickets.data?.length ?? 0;
  const ticketNumber = useMemo(() => {
    if (!ticketId || !drawingTickets.data) return undefined;
    const idx = drawingTickets.data.findIndex((id) => id === ticketId);
    return idx >= 0 ? idx + 1 : undefined;
  }, [ticketId, drawingTickets.data]);

  const ticketLabel =
    ticketNumber !== undefined ? `#${ticketNumber}` : "—";

  const sellingState = paused
    ? "paused"
    : ticketId && ticketId > 0n
      ? cd.ended
        ? "drawing closed, awaiting next"
        : sold === 100
          ? "ticket full — waiting for next ticket"
          : `selling ticket ${ticketLabel} (${sold}/100)`
      : canBuy
        ? "ready to front the first ticket"
        : "no live ticket";

  return (
    <section className="relative z-10 mx-auto w-full max-w-3xl px-4 py-16 sm:py-24">
      {/* Top prize tier — Megapot PayoutCalculator.getExpectedDrawingTierPayouts[11]
          (5 normals + bonusball, i.e. the jackpot tier per-ticket payout). */}
      <div className="text-center">
        <div className="font-mono text-[10px] uppercase tracking-[0.3em] text-ink-300">
          Megapot Jackpot
        </div>
        <div className="mt-1 font-mono text-5xl font-black tracking-tighter text-accent drop-shadow-[0_0_22px_rgba(255,45,136,0.55)] sm:text-7xl">
          {topPrize !== undefined ? formatUsdc(topPrize, { dp: 0 }) : "—"}
        </div>
        <p className="mt-3 text-sm text-ink-300 sm:text-base">
          Grab 1¢ shares of a Megapot ticket and ride it to the drawing.
        </p>
        <p className="mt-1 text-sm text-ink-300 sm:text-base">
          Every unsold share grows your cut of the jackpot if it hits.
        </p>
      </div>

      <div className="mt-16 rounded-2xl border border-ink-500 bg-ink-700/60 p-5 shadow-glow sm:mt-24 sm:p-7">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <div className="text-xs uppercase tracking-widest text-ink-300">
            Drawing #{drawingId?.toString() ?? "—"}
          </div>
          <div
            className={`font-mono text-xs sm:text-sm ${
              cd.ended ? "text-ink-300" : "text-accent"
            }`}
            aria-live="polite"
          >
            {cd.label}
          </div>
        </div>

        <div className="mt-2 text-lg font-medium sm:text-xl">{sellingState}</div>

        <div className="mt-5 grid grid-cols-2 gap-4 sm:grid-cols-4">
          <Stat label="Ticket" value={ticketLabel} mono />
          <Stat label="Shares sold" value={`${sold}/100`} mono pop={sold} />
          <Stat label="Tickets this drawing" value={ticketCount.toString()} mono />
          <Stat label="Reserve" value={formatUsdc(reserve)} mono accent />
        </div>

        {/* Progress bar for current ticket */}
        <div className="mt-5">
          <div className="h-2 w-full overflow-hidden rounded-full bg-ink-600">
            <div
              className="h-full bg-accent transition-[width] duration-500 ease-out"
              style={{ width: `${sold}%` }}
            />
          </div>
        </div>

        {isLoading ? (
          <div className="mt-3 text-xs text-ink-300">loading state…</div>
        ) : null}
      </div>
    </section>
  );
}

function Stat({
  label,
  value,
  mono,
  accent,
  pop,
}: {
  label: string;
  value: string;
  mono?: boolean;
  accent?: boolean;
  pop?: number | string;
}) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-widest text-ink-300">
        {label}
      </div>
      <div
        // key forces re-mount so the pop animation re-runs on value change
        key={pop !== undefined ? String(pop) : undefined}
        className={[
          "mt-1 text-lg sm:text-xl font-semibold",
          mono ? "font-mono" : "",
          accent ? "text-accent" : "text-ink-100",
          pop !== undefined ? "num-pop" : "",
        ].join(" ")}
      >
        {value}
      </div>
    </div>
  );
}
