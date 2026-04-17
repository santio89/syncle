import dynamic from "next/dynamic";
import Link from "next/link";

// Game uses browser-only APIs (AudioContext, Canvas), so render client-side.
const Game = dynamic(() => import("@/components/Game"), { ssr: false });

export default function PlayPage() {
  return (
    <main className="relative flex h-screen w-screen flex-col overflow-hidden bg-ink-900">
      {/* Slim top bar */}
      <header className="z-30 flex items-center justify-between border-b-2 border-bone-50/20 px-4 py-2">
        <Link
          href="/"
          className="font-mono text-xs uppercase tracking-widest text-bone-50/70 hover:text-accent"
        >
          ← Syncle
        </Link>
        <span className="font-mono text-[10px] uppercase tracking-[0.3em] text-bone-50/40">
          Single player · v0.2
        </span>
      </header>

      <div className="relative flex-1">
        <Game />
      </div>
    </main>
  );
}
