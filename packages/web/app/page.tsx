"use client";

import { ConnectKitButton } from "connectkit";
import { Buy } from "@/components/Buy";
import { Hero } from "@/components/Hero";
import { Positions } from "@/components/Positions";

export default function Page() {
  return (
    <main className="relative z-10">
      <header className="mx-auto flex w-full max-w-3xl items-center justify-between px-4 pt-4">
        <div className="font-mono text-[10px] uppercase tracking-[0.3em] text-ink-300">
          PennyPot · Base
        </div>
        <ConnectKitButton showBalance={false} />
      </header>

      <Hero />
      <Buy />
      <Positions />

      <footer className="mx-auto w-full max-w-3xl px-4 pb-12 pt-4 text-center font-mono text-[10px] uppercase tracking-[0.25em] text-ink-300">
        <a
          href="https://basescan.org/address/0xdCc075040Cf5888dBa26E9871427949BAb7591ba"
          target="_blank"
          rel="noopener noreferrer"
          className="hover:text-accent"
        >
          contract on Basescan ↗
        </a>
        <span className="mx-2">·</span>
        <a
          href="https://megapot.io"
          target="_blank"
          rel="noopener noreferrer"
          className="hover:text-accent"
        >
          built on Megapot
        </a>
      </footer>
    </main>
  );
}
