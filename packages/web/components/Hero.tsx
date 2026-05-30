"use client";

import { formatUsdc } from "@/lib/format";
import { useMegapotDrawingTime } from "@/lib/hooks";

// Jackpot headline only. The active ticket + buy controls live together in the
// Buy card directly below — you can only buy shares of an active ticket, so the
// two are one card.
export function Hero() {
  const { topPrize } = useMegapotDrawingTime();

  return (
    <section className="relative z-10 mx-auto w-full max-w-3xl px-4 pt-16 pb-14 text-center sm:pt-24 sm:pb-20">
      {/* Top prize tier — Megapot PayoutCalculator.getExpectedDrawingTierPayouts[11]
          (5 normals + bonusball, i.e. the jackpot tier per-ticket payout). */}
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
    </section>
  );
}
