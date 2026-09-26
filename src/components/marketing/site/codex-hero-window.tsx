"use client";

import { useEffect, useState } from "react";
import { DashboardPanel } from "@/components/marketing/site/product-mock/panels";

function CloseIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" aria-hidden>
      <path d="M18 6 6 18M6 6l12 12" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/**
 * One event in the hero's activity stream — the same Seattle Homes story the
 * static dashboard panel beside it renders (Jamie P., Pacific Plumbing, Dana
 * Reyes; see `product-mock/fixtures.ts`), never invented, so the two never
 * disagree.
 */
type HeroActivityEvent = { title: string; detail: string; tag: string };

const HERO_ACTIVITY_EVENTS: HeroActivityEvent[] = [
  { title: "Pacific Plumbing dispatched to Maple Duplex", detail: "No hot water · Thu 10–12 · resident notified", tag: "Done" },
  { title: "Tour booked with Jamie P.", detail: "Fremont Studio · Sat 2:00 PM", tag: "Confirmed" },
  { title: "Rent paid — $3,200", detail: "Test Resident · Alder House · autopay", tag: "Paid" },
  { title: "Application approved", detail: "Dana Reyes · Alder House", tag: "Approved" },
];

const HERO_ACTIVITY_INTERVAL_MS = 4200;

function useReducedMotionPreference(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    // eslint-disable-next-line react-hooks/set-state-in-effect -- matchMedia is only readable after mount
    setReduced(mq.matches);
    const onChange = () => setReduced(mq.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);
  return reduced;
}

/**
 * The small "Needs attention"-style activity card overlapping the hero
 * window's left edge — a static cycling stream (never rotates under
 * `prefers-reduced-motion`), dismissible with its own ✕.
 */
function CodexHeroActivityCard({ onDismiss }: { onDismiss: () => void }) {
  const reducedMotion = useReducedMotionPreference();
  const [index, setIndex] = useState(0);

  useEffect(() => {
    if (reducedMotion) return;
    const id = window.setInterval(() => {
      setIndex((i) => (i + 1) % HERO_ACTIVITY_EVENTS.length);
    }, HERO_ACTIVITY_INTERVAL_MS);
    return () => window.clearInterval(id);
  }, [reducedMotion]);

  const event = HERO_ACTIVITY_EVENTS[index]!;

  return (
    <div className="codex-hero-activity-card" data-attr="home-hero-activity-card" aria-live="polite">
      <button
        type="button"
        onClick={onDismiss}
        aria-label="Dismiss"
        className="absolute right-1.5 top-1.5 flex h-6 w-6 items-center justify-center rounded-full text-muted transition hover:bg-foreground/5 hover:text-foreground"
      >
        <CloseIcon className="h-3.5 w-3.5" />
      </button>
      <p className="mb-1.5 flex items-center gap-2 pr-5 text-[11px] font-bold text-primary">
        Activity
        <span className="rounded-full bg-[#e8f7ee] px-2 py-0.5 text-[10px] font-bold text-[#15803d]">{event.tag}</span>
      </p>
      <p className="text-[12.5px] font-semibold leading-snug text-[#17181a]">PropLane · {event.title}</p>
      <p className="text-[11px] text-[#4a4e56]">{event.detail}</p>
      <p className="mt-2 text-[10.5px] font-bold uppercase tracking-[0.06em] text-muted">Sample data</p>
    </div>
  );
}

/**
 * The Codex-style hero window (openai.com/codex reference): a big rounded
 * white app frame holding the STATIC manager Dashboard panel (captain
 * 2026-09-26 — "remove live demo no need"; Occupancy 67%, rent collected
 * $3,250 of $6,450, three properties, Needs attention, Upcoming). Built from
 * the real presentational dashboard components (`DashboardPanel`,
 * `product-mock/panels.tsx`), never a live `<iframe src="/demo">` — it is
 * genuinely clickable (tabs/rows open the real fixture sheet), just never
 * fetches or persists. See `docs/agents/demo-sandbox.md`.
 */
export function CodexHeroWindow() {
  const [cardVisible, setCardVisible] = useState(true);

  return (
    <div className="relative mx-auto w-full">
      <div className="codex-hero-window relative h-[560px] w-full overflow-hidden rounded-[24px] border border-black/[0.06] bg-white shadow-[0_60px_140px_-40px_rgba(15,23,42,0.35)] sm:h-[760px]">
        <DashboardPanel />
      </div>

      {cardVisible ? <CodexHeroActivityCard onDismiss={() => setCardVisible(false)} /> : null}
    </div>
  );
}
