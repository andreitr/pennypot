"use client";

import { useMemo } from "react";
import { useReadContracts } from "wagmi";
import { base } from "wagmi/chains";
import { pennypotAbi } from "@/lib/abis";
import { PENNYPOT_ADDRESS } from "@/lib/addresses";
import {
  useDrawingTicketIds,
  useGetState,
  useMegapotContractTickets,
} from "@/lib/hooks";

// Tickets PennyPot has bought in the current Megapot round. Hybrid data:
//  - on-chain getDrawingTicketIds + getTicket  → authoritative list + fill/holders
//  - Data API (via useMegapotContractTickets)  → lottery picks (not on-chain)
export function CurrentRound() {
  const { data: state } = useGetState();
  const drawingId = state?.[0];
  const activeTicketId = state?.[1];

  const idsQ = useDrawingTicketIds(drawingId);
  const ticketIds = (idsQ.data ?? []) as readonly bigint[];

  const details = useReadContracts({
    contracts: ticketIds.map((id) => ({
      chainId: base.id,
      address: PENNYPOT_ADDRESS,
      abi: pennypotAbi,
      functionName: "getTicket" as const,
      args: [id] as const,
    })),
    query: { enabled: ticketIds.length > 0, refetchInterval: 15_000 },
  });

  const picksQ = useMegapotContractTickets();
  const picksMap = useMemo(() => {
    const m = new Map<string, { normals: number[]; bonusball: number }>();
    for (const t of picksQ.data ?? []) {
      m.set(t.user_ticket_id, { normals: t.normals, bonusball: t.bonusball });
    }
    return m;
  }, [picksQ.data]);

  // Newest first; ticket number is the 1-based purchase index within the round.
  const rows = ticketIds
    .map((id, i) => {
      const det = details.data?.[i]?.result as
        | readonly [number, number, bigint, boolean]
        | undefined;
      return {
        id,
        number: i + 1,
        sold: det?.[0] ?? 0,
        holders: det?.[1] ?? 0,
        picks: picksMap.get(id.toString()),
        isActive: activeTicketId !== undefined && id === activeTicketId,
      };
    })
    .reverse();

  return (
    <section className="relative z-10 mx-auto w-full max-w-3xl px-4 py-6">
      <SectionHeader title="Tickets in the current round" />

      <div className="rounded-2xl border border-ink-500 bg-ink-700/60 p-2 sm:p-3">
        {idsQ.isLoading ? (
          <div className="p-6 text-center text-sm text-ink-300">loading…</div>
        ) : rows.length === 0 ? (
          <div className="p-6 text-center text-sm text-ink-300">
            No tickets in this round yet.
          </div>
        ) : (
          <ul className="divide-y divide-ink-500/60">
            {rows.map((r) => (
              <li
                key={r.id.toString()}
                className="flex items-center justify-between gap-3 px-3 py-3 sm:px-4"
              >
                <div className="min-w-0">
                  <div className="flex items-baseline gap-2 font-mono text-sm">
                    <span className="text-accent">ticket #{r.number}</span>
                    {r.isActive ? (
                      <span className="rounded bg-accent/15 px-1.5 py-0.5 text-[10px] uppercase tracking-widest text-accent">
                        selling
                      </span>
                    ) : null}
                  </div>
                  {r.picks ? (
                    <Picks
                      normals={r.picks.normals}
                      bonusball={r.picks.bonusball}
                    />
                  ) : (
                    <div className="mt-1.5 font-mono text-[11px] text-ink-300">
                      picks loading…
                    </div>
                  )}
                </div>
                <div className="shrink-0 text-right font-mono text-sm">
                  <div className="text-ink-100">{r.sold}/100</div>
                  <div className="text-[11px] text-ink-300">
                    {r.holders} holder{r.holders === 1 ? "" : "s"}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

function Picks({
  normals,
  bonusball,
}: {
  normals: number[];
  bonusball: number;
}) {
  const pad = (n: number) => n.toString().padStart(2, "0");
  return (
    <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
      {normals.map((n, i) => (
        <span
          key={`${i}-${n}`}
          className="flex h-7 w-7 items-center justify-center rounded-full border border-ink-500 bg-ink-800/70 font-mono text-xs font-bold text-ink-100"
        >
          {pad(n)}
        </span>
      ))}
      <span
        className="flex h-7 w-7 items-center justify-center rounded-full bg-accent font-mono text-xs font-bold text-ink-900 shadow-glow"
        title="Bonusball"
      >
        {pad(bonusball)}
      </span>
    </div>
  );
}

function SectionHeader({ title }: { title: string }) {
  return (
    <h2 className="mb-3 px-1 font-mono text-xs uppercase tracking-[0.25em] text-ink-300">
      ▌ {title}
    </h2>
  );
}
