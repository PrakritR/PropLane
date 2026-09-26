"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { GET_STARTED_HREF } from "@/lib/marketing/public-contact";
import { SiteEyebrow, SiteSection } from "@/components/marketing/site/primitives";
import type { DemoPortalRole } from "@/lib/demo/demo-session";
import { cn } from "@/lib/utils";

/**
 * "From first tour to fixed faucet." — replaces the old "Three sign-ins. One
 * home." audience switch (captain 2026-09-25: "show every section in order
 * honestly in a nice left right system tours application leasing payments
 * maintenance. and show from each perspective vendors residents and
 * managers"). Five alternating rows, each pairing one high-ticket pain with a
 * real, interactive `/demo` deep link — the actual product, bundled with the
 * Seattle Homes sample data (see `docs/agents/demo-sandbox.md`), never a
 * hand-drawn replica.
 *
 * Autoplay rotates the active perspective tab every ~6s (never under
 * `prefers-reduced-motion`), and freezes on any manual tab/replay click,
 * matching `docs/agents/lavish-plan-standard.md`'s "Home page lifecycle
 * redesign" contract. A perspective the real feature does not involve gets no
 * tab at all — a tab that can never do anything is a dead click.
 *
 * Scope note: this row set covers the SAME real product surfaces the mock
 * plan itemized, but a few perspectives named in the original spec have no
 * clean, always-populated `/demo` equivalent today and are intentionally
 * dropped rather than shown broken or invented:
 * - Tours' prospect/resident perspective — booking a tour is a pre-account,
 *   anonymous flow `/demo` has no signed-out "prospect" mode for; the seeded
 *   `/demo` resident is already a leased tenant.
 * - Applications' resident perspective — same reason (the seeded resident
 *   already has an approved application; there is no mid-application
 *   prospect identity to sign in as).
 * Both rows show Manager only until a prospect-facing demo mode exists.
 */

type Perspective = {
  id: DemoPortalRole;
  label: string;
  role: DemoPortalRole;
  section: string;
  tab?: string;
  device: "desktop" | "phone";
  /** Shown in the desktop browser-chrome bar / used for the iframe title. */
  path: string;
};

type LifecycleStep = {
  id: string;
  kicker: string;
  headline: string;
  bullets: string[];
  linkLabel: string;
  perspectives: Perspective[];
};

const STEPS: LifecycleStep[] = [
  {
    id: "tours",
    kicker: "Tours",
    headline: "No-shows and double-booked showings cost you the lease.",
    bullets: [
      "Prospects book only open slots",
      "Reminders + one-tap confirm",
      "A missed tour re-offers the slot",
    ],
    linkLabel: "Try tour scheduling",
    perspectives: [
      { id: "manager", label: "Manager", role: "manager", section: "tours", tab: "upcoming", device: "desktop", path: "/portal/tours/upcoming" },
    ],
  },
  {
    id: "applications",
    kicker: "Applications",
    headline: "An incomplete application is a month of vacancy.",
    bullets: [
      "One application per bed, fee collected up front",
      "ID + income documents in one place",
      "Co-applicants grouped, never blocking",
    ],
    linkLabel: "See applications in PropLane",
    perspectives: [
      { id: "manager", label: "Manager", role: "manager", section: "applications", device: "desktop", path: "/portal/applications/pending" },
    ],
  },
  {
    id: "leasing",
    kicker: "Leasing",
    headline: "Leases stall waiting on one signature.",
    bullets: [
      "Generate from the approved application",
      "E-sign with initials and an audit trail",
      "Countersign and the deposit charge goes out on its own",
    ],
    linkLabel: "See leasing in PropLane",
    perspectives: [
      { id: "manager", label: "Manager", role: "manager", section: "leases", device: "desktop", path: "/portal/leases" },
      {
        id: "resident",
        label: "Resident",
        role: "resident",
        section: "lease",
        tab: "demo-lease-demo-prop-alder",
        device: "phone",
        path: "/resident/lease",
      },
    ],
  },
  {
    id: "payments",
    kicker: "Payments",
    headline: "Chasing rent is the most expensive hour of your month.",
    bullets: [
      "Autopay and reminders before the due date",
      "Late fees from the ledger, never by hand",
      "Vendors paid from the same balance",
    ],
    linkLabel: "See payments in PropLane",
    perspectives: [
      { id: "resident", label: "Resident", role: "resident", section: "payments", tab: "overdue", device: "phone", path: "/resident/payments" },
      { id: "manager", label: "Manager", role: "manager", section: "payments", tab: "overdue", device: "desktop", path: "/portal/payments/incoming/overdue" },
      { id: "vendor", label: "Vendor", role: "vendor", section: "dashboard", device: "phone", path: "/vendor/dashboard" },
    ],
  },
  {
    id: "maintenance",
    kicker: "Maintenance",
    headline: "A 2 AM leak, a no-show vendor, a surprise change order.",
    bullets: [
      "Residents report with photos, told at every step",
      "Dispatch to your vendor or compare quotes",
      "Change orders wait for your yes",
    ],
    linkLabel: "See maintenance in PropLane",
    perspectives: [
      { id: "resident", label: "Resident", role: "resident", section: "services", tab: "scheduled", device: "phone", path: "/resident/services" },
      { id: "manager", label: "Manager", role: "manager", section: "services", tab: "work-orders", device: "desktop", path: "/portal/services" },
      { id: "vendor", label: "Vendor", role: "vendor", section: "work-orders", tab: "upcoming", device: "phone", path: "/vendor/work-orders" },
    ],
  },
];

function demoSrc(p: Perspective): string {
  const params = new URLSearchParams({ role: p.role, section: p.section });
  if (p.tab) params.set("tab", p.tab);
  return `/demo?${params.toString()}`;
}

function ReplayIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M21 12a9 9 0 1 1-3-6.7" />
      <path d="M21 3v6h-6" />
    </svg>
  );
}

function useReducedMotion(): boolean {
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

/** Desktop app window (browser-chrome-lite bar) or phone bezel around the real, interactive `/demo` iframe. */
function DeviceFrame({ perspective, label, kicker }: { perspective: Perspective; label: string; kicker: string }) {
  const src = demoSrc(perspective);
  const title = `PropLane ${label} — ${kicker}`;
  if (perspective.device === "desktop") {
    return (
      <div className="w-full overflow-hidden rounded-2xl border border-border bg-card shadow-[0_26px_54px_-24px_rgba(15,23,42,0.35)]">
        <div className="flex items-center gap-1.5 border-b border-border bg-[var(--pl-surface-muted)] px-3 py-2">
          <i className="h-2.5 w-2.5 rounded-full bg-border" aria-hidden />
          <i className="h-2.5 w-2.5 rounded-full bg-border" aria-hidden />
          <i className="h-2.5 w-2.5 rounded-full bg-border" aria-hidden />
          <span className="ml-2 truncate rounded-md bg-card px-2 py-0.5 text-[10.5px] text-muted">
            prop-lane.space{perspective.path}
          </span>
        </div>
        <iframe
          key={src}
          src={src}
          title={title}
          loading="lazy"
          className="block h-[420px] w-full border-0 bg-background sm:h-[460px]"
        />
      </div>
    );
  }
  return (
    <div className="mx-auto w-[236px] shrink-0 rounded-[2.1rem] border-[7px] border-foreground/90 bg-foreground/90 shadow-[0_22px_46px_-16px_rgba(15,23,42,0.4)]">
      <div className="h-[478px] w-full overflow-hidden rounded-[1.5rem] bg-background">
        <iframe key={src} src={src} title={title} loading="lazy" className="block h-full w-full border-0" />
      </div>
    </div>
  );
}

function LifecycleRow({ step, flip }: { step: LifecycleStep; flip: boolean }) {
  const reducedMotion = useReducedMotion();
  const [activeIdx, setActiveIdx] = useState(0);
  const [paused, setPaused] = useState(false);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const multiplePerspectives = step.perspectives.length > 1;

  useEffect(() => {
    if (timerRef.current) clearInterval(timerRef.current);
    timerRef.current = null;
    if (reducedMotion || paused || !multiplePerspectives) return;
    timerRef.current = setInterval(() => {
      setActiveIdx((i) => (i + 1) % step.perspectives.length);
    }, 6000);
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [reducedMotion, paused, multiplePerspectives, step.perspectives.length]);

  const active = step.perspectives[activeIdx] ?? step.perspectives[0]!;

  const copyCell = (
    <div>
      <div className="flex items-center gap-2 text-[11px] font-bold uppercase tracking-[0.08em] text-primary">
        <span className="h-2 w-2 rounded-full bg-primary" aria-hidden />
        {step.kicker}
      </div>
      <h3 className="mt-2.5 text-[clamp(1.3rem,2.4vw,1.7rem)] font-bold leading-[1.2] tracking-tight text-foreground">
        {step.headline}
      </h3>
      <ul className="mt-4 space-y-2.5">
        {step.bullets.map((b) => (
          <li key={b} className="flex items-start gap-2.5 text-[14.5px] leading-relaxed text-foreground/90">
            <span aria-hidden className="mt-[7px] h-[5px] w-[5px] shrink-0 rounded-full bg-primary" />
            {b}
          </li>
        ))}
      </ul>
      <Link
        href={GET_STARTED_HREF}
        data-attr={`home-lifecycle-${step.id}`}
        className="mt-5 inline-flex items-center gap-1.5 text-[14.5px] font-bold text-primary hover:underline"
      >
        {step.linkLabel} <span aria-hidden>→</span>
      </Link>
    </div>
  );

  const demoCell = (
    <div className="flex min-h-0 flex-col justify-center">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
        <span className="text-[10.5px] font-bold uppercase tracking-[0.08em] text-muted">Sample data</span>
        {multiplePerspectives ? (
          <div className="flex items-center gap-2">
            <div
              role="tablist"
              aria-label={`${step.kicker} perspective`}
              className="flex gap-0.5 rounded-full border border-border bg-[var(--pl-surface-muted)] p-0.5"
            >
              {step.perspectives.map((p, i) => {
                const on = i === activeIdx;
                return (
                  <button
                    key={p.id}
                    type="button"
                    role="tab"
                    aria-selected={on}
                    data-attr={`home-lifecycle-${step.id}-${p.id}`}
                    onClick={() => {
                      setActiveIdx(i);
                      setPaused(true);
                    }}
                    className={cn(
                      "rounded-full px-3 py-1 text-[11.5px] font-bold transition-colors",
                      on ? "bg-card text-foreground shadow-[var(--shadow-sm)]" : "text-muted hover:text-foreground",
                    )}
                  >
                    {p.label}
                  </button>
                );
              })}
            </div>
            <button
              type="button"
              aria-label={`Replay the ${step.kicker.toLowerCase()} demo`}
              title="Replay"
              data-attr={`home-lifecycle-${step.id}-replay`}
              onClick={() => setPaused(false)}
              className="grid h-6 w-6 shrink-0 place-items-center rounded-full border border-border bg-card text-muted hover:text-foreground"
            >
              <ReplayIcon />
            </button>
          </div>
        ) : null}
      </div>
      <DeviceFrame perspective={active} label={active.label} kicker={step.kicker} />
    </div>
  );

  return (
    <div
      data-lifecycle-row={step.id}
      className={cn(
        "grid items-start gap-6 border-t border-border py-9 sm:gap-8 lg:py-11",
        "grid-cols-1 lg:grid-cols-[minmax(0,0.86fr)_minmax(0,1.14fr)]",
      )}
    >
      {flip ? (
        <>
          <div className="order-2 lg:order-2">{demoCell}</div>
          <div className="order-1 lg:order-1">{copyCell}</div>
        </>
      ) : (
        <>
          <div className="order-1">{copyCell}</div>
          <div className="order-2">{demoCell}</div>
        </>
      )}
    </div>
  );
}

/** "From first tour to fixed faucet." — the five lifecycle rows (see file docstring). */
export function SiteLifecycleRows() {
  return (
    <SiteSection id="lifecycle" ariaLabelledBy="site-lifecycle-title">
      <div className="mx-auto mb-2 max-w-[640px] text-center">
        <SiteEyebrow>The lifecycle</SiteEyebrow>
        <h2 id="site-lifecycle-title" className="mt-2 text-[clamp(1.75rem,3.4vw,2.5rem)] font-bold leading-[1.08] tracking-[-0.03em] text-foreground">
          From first tour to fixed faucet.
        </h2>
        <p className="mt-3 text-[15px] text-muted">Every stage, from every seat — manager, resident, vendor.</p>
      </div>
      {/* idx % 2 === 1 flips demo/copy on odd rows (row 1 stays copy-left); phone always stacks copy above the demo (grid-cols-1 above). */}
      {STEPS.map((step, i) => (
        <LifecycleRow key={step.id} step={step} flip={i % 2 === 1} />
      ))}
    </SiteSection>
  );
}
