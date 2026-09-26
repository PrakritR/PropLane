"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import {
  LIFECYCLE_BEAT_MESSAGE_SOURCE,
  type LifecycleBeatMessage,
} from "@/lib/demo/demo-lifecycle-scenarios";
import { GET_STARTED_HREF } from "@/lib/marketing/public-contact";
import { demoOnlyBrowseCardPlaceholderImage } from "@/lib/room-listings-catalog";
import { SiteEyebrow, SiteSection } from "@/components/marketing/site/primitives";
import { isDemoModeActive, type DemoPortalRole } from "@/lib/demo/demo-session";
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
 * Scope note: Tours and Applications' "Prospect" perspective is NOT a live
 * `/demo` iframe. Booking a tour or applying is a pre-account, anonymous
 * flow — `/demo`'s one resident identity is already a leased tenant, so
 * there is no signed-in session to deep-link into for Jamie P.'s side of
 * either story. Both render a small static, token-accurate phone frame
 * (real Tailwind tokens/primitives, no PL.state.db, no network) that steps
 * through the same 4 beats the postMessage-scripted perspectives use, kept
 * in sync with `demo-lifecycle-scenarios.ts`'s copy for the same rows.
 */

type IframePerspective = {
  kind: "iframe";
  id: DemoPortalRole;
  label: string;
  role: DemoPortalRole;
  section: string;
  tab?: string;
  device: "desktop" | "phone";
  /** Shown in the desktop browser-chrome bar / used for the iframe title. */
  path: string;
};

type StaticPerspective = {
  kind: "static";
  id: "prospect";
  label: string;
  device: "phone";
  /** One JSX frame per beat (0-3) — the phone-bezel body only, no chrome. */
  beats: ReactNode[];
};

type Perspective = IframePerspective | StaticPerspective;

type LifecycleStep = {
  id: string;
  kicker: string;
  headline: string;
  bullets: string[];
  linkLabel: string;
  perspectives: Perspective[];
};

/** A slot chip for the prospect tour-booking beats. */
function SlotChip({ label, state }: { label: string; state: "open" | "selected" | "taken" }) {
  return (
    <span
      className={cn(
        "rounded-lg border px-2 py-1.5 text-center text-[10.5px] font-bold",
        state === "selected" && "border-primary bg-primary text-white",
        state === "open" && "border-border bg-card text-foreground",
        state === "taken" && "border-transparent bg-[var(--pl-surface-muted)] text-muted/60 line-through",
      )}
    >
      {label}
    </span>
  );
}

/** The Fremont Studio listing header every tour beat keeps on screen — a real
 * screen keeps its context, it doesn't blank out between steps. Photo is the
 * demo-only stock placeholder (`isDemoModeActive()`-gated per its own doc
 * comment) — never a fabricated photo of a real listing. */
function ProspectListingHeader() {
  // `isDemoModeActive()` reads `window.location`, which doesn't exist during
  // SSR — reading it directly here disagreed between the server's render
  // (always false) and the client's first paint (true on the home page),
  // a real hydration mismatch. Same fix the codebase's own demo hooks use:
  // resolve it only after mount, so the server and first client paint agree.
  const [photo, setPhoto] = useState<string | null>(null);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- window.location is only readable after mount
    if (isDemoModeActive()) setPhoto(demoOnlyBrowseCardPlaceholderImage("demo-prop-fremont"));
  }, []);
  return (
    <div className="mb-2.5 shrink-0 overflow-hidden rounded-xl border border-border">
      {photo ? (
        // eslint-disable-next-line @next/next/no-img-element -- a tiny decorative demo-only mock photo, not a real listing asset worth Next/Image's pipeline
        <img src={photo} alt="" className="h-16 w-full object-cover" />
      ) : (
        <div className="flex h-16 items-center justify-center bg-[var(--pl-surface-muted)] text-muted">Fremont Studio</div>
      )}
      <div className="px-2.5 py-2">
        <p className="text-[11.5px] font-bold text-foreground">Fremont Studio</p>
        <p className="text-[10px] text-muted">$1,400/mo · Studio · 1 bath</p>
      </div>
    </div>
  );
}

function StickyButton({ label, active }: { label: string; active: boolean }) {
  return (
    <div className="mt-auto shrink-0 pt-2">
      <div
        className={cn(
          "grid h-8 place-items-center rounded-full text-[11.5px] font-bold",
          active ? "bg-primary text-white" : "bg-[var(--pl-surface-muted)] text-muted",
        )}
      >
        {label}
      </div>
    </div>
  );
}

const TOUR_DAYS = ["Sat 27", "Sun 28", "Mon 29"];
const TOUR_SLOTS_BY_DAY: Record<string, { label: string; state: "open" | "taken" }[]> = {
  "Sat 27": [
    { label: "10:00 AM", state: "taken" },
    { label: "2:00 PM", state: "open" },
    { label: "4:00 PM", state: "open" },
  ],
  "Sun 28": [
    { label: "11:00 AM", state: "open" },
    { label: "1:00 PM", state: "taken" },
  ],
  "Mon 29": [{ label: "5:30 PM", state: "open" }],
};

/** Prospect (Jamie P.) tour-booking beats — no /demo equivalent exists for an
 * anonymous, pre-account visitor; see the file's own scope note. The listing
 * header stays on screen every beat — only the picker/confirmation below it
 * changes, like a real screen a visitor is scrolling through, not a slideshow. */
function toursProspectBeats(): ReactNode[] {
  /** The full week, every day's slots at once — a real booking screen scrolls
   * through the week, it doesn't hide five sixths of it behind a day filter. */
  function weekList(activeDay: string, selected: string | null) {
    return (
      <div className="space-y-2">
        {TOUR_DAYS.map((d) => (
          <div key={d}>
            <p className={cn("mb-1 text-[10px] font-bold", d === activeDay ? "text-primary" : "text-muted")}>{d}</p>
            <div className="grid grid-cols-3 gap-1.5">
              {TOUR_SLOTS_BY_DAY[d]!.map((s) => (
                <SlotChip key={s.label} label={s.label} state={d === activeDay && s.label === selected ? "selected" : s.state} />
              ))}
            </div>
          </div>
        ))}
      </div>
    );
  }
  const picker = (activeDay: string, selected: string | null, buttonActive: boolean) => (
    <div className="flex h-full flex-col">
      <ProspectListingHeader />
      <p className="mb-2 shrink-0 text-[11px] font-bold text-foreground">Book a tour</p>
      {weekList(activeDay, selected)}
      <StickyButton label={selected ? `Request ${selected}` : "Pick a time"} active={buttonActive} />
    </div>
  );
  const confirmation = (title: string, tone: "pending" | "done", statusLine: string) => (
    <div className="flex h-full flex-col">
      <ProspectListingHeader />
      <div className="flex flex-col items-center pt-2 text-center">
        <div
          className={cn(
            "mb-2 grid h-10 w-10 place-items-center rounded-full",
            tone === "done" ? "bg-[#e8f7ee] text-[#15803d]" : "bg-primary/10 text-primary",
          )}
        >
          ✓
        </div>
        <p className="text-[12px] font-bold text-foreground">{title}</p>
        <p className="mt-1 text-[10.5px] text-muted">{statusLine}</p>
      </div>
      <div className="mt-3 space-y-1.5 rounded-lg border border-border p-2.5">
        <div className="flex items-center justify-between text-[10.5px]"><span className="text-muted">Date</span><span className="font-semibold text-foreground">Sat, Sep 27</span></div>
        <div className="flex items-center justify-between text-[10.5px]"><span className="text-muted">Time</span><span className="font-semibold text-foreground">2:00 PM</span></div>
        <div className="flex items-center justify-between text-[10.5px]"><span className="text-muted">Address</span><span className="font-semibold text-foreground">3301 Fremont Ave N</span></div>
        <div className="flex items-center justify-between text-[10.5px]"><span className="text-muted">Host</span><span className="font-semibold text-foreground">Seattle Homes</span></div>
      </div>
      <div className="mt-2.5 flex items-center gap-2 rounded-lg bg-[var(--pl-surface-muted)] px-2.5 py-2">
        <span className="grid h-5 w-5 shrink-0 place-items-center rounded-full bg-primary/15 text-[9px] text-primary">✦</span>
        <p className="text-[10px] text-muted">{tone === "done" ? "A reminder text goes out the morning of your tour." : "The manager confirms within a few hours."}</p>
      </div>
      <StickyButton label={tone === "done" ? "Add to calendar" : "Message the manager"} active={tone === "done"} />
    </div>
  );
  return [
    picker("Sat 27", null, false),
    picker("Sat 27", "2:00 PM", true),
    confirmation("Tour requested", "pending", "Sat, Sep 27 · 2:00 PM · Waiting on Seattle Homes"),
    confirmation("Tour confirmed", "done", "Sat, Sep 27 · 2:00 PM · Reminder set for Friday"),
  ];
}

/** Prospect (Jamie P.) application beats — same scope note as tours above.
 * The applicant header and step progress stay on screen every beat. */
function applicationsProspectBeats(): ReactNode[] {
  function header(idx: number) {
    return (
      <div className="mb-2.5 shrink-0">
        <div className="mb-2 flex items-center gap-2">
          <span className="grid h-7 w-7 place-items-center rounded-full bg-primary/10 text-[11px] font-bold text-primary">JP</span>
          <div className="min-w-0">
            <p className="truncate text-[11.5px] font-bold text-foreground">Jamie P.</p>
            <p className="truncate text-[10px] text-muted">Fremont Studio · $1,400/mo</p>
          </div>
        </div>
        <div className="flex items-center gap-1">
          {["Profile", "Documents", "Fee", "Submit"].map((s, i) => (
            <span key={s} className={cn("h-1.5 flex-1 rounded-full", i <= idx ? "bg-primary" : "bg-border")} />
          ))}
        </div>
        <div className="mt-1 flex justify-between text-[8.5px] font-bold uppercase tracking-[0.04em] text-muted">
          {["Profile", "Documents", "Fee", "Submit"].map((s) => (
            <span key={s}>{s}</span>
          ))}
        </div>
      </div>
    );
  }
  function docRow(label: string, state: "done" | "pending" | "todo") {
    return (
      <div key={label} className="mb-1.5 flex items-center gap-2 rounded-lg border border-border px-2 py-1.5">
        <span
          className={cn(
            "grid h-5 w-5 shrink-0 place-items-center rounded-md text-[10px]",
            state === "done" ? "bg-[#e8f7ee] text-[#15803d]" : "bg-[var(--pl-surface-muted)] text-muted",
          )}
        >
          {state === "done" ? "✓" : "…"}
        </span>
        <span className="text-[11px] font-semibold text-foreground">{label}</span>
        <span className="ml-auto text-[9.5px] font-bold uppercase text-muted">{state === "done" ? "Uploaded" : "Pending"}</span>
      </div>
    );
  }
  const docsBeat = (incomeDone: boolean, referencesDone: boolean) => (
    <div className="flex h-full flex-col">
      {header(1)}
      {docRow("Photo ID", "done")}
      {docRow("Proof of income", incomeDone ? "done" : "pending")}
      {docRow("References", referencesDone ? "done" : "todo")}
      <StickyButton label="Continue" active={incomeDone && referencesDone} />
    </div>
  );
  return [
    docsBeat(false, false),
    docsBeat(true, true),
    <div key={2} className="flex h-full flex-col">
      {header(2)}
      <p className="mb-1.5 text-[10px] font-bold uppercase tracking-[0.04em] text-muted">Application fee</p>
      <div className="space-y-1.5 rounded-lg border border-border p-2.5">
        <div className="flex items-center justify-between text-[10.5px]"><span className="text-muted">Screening & background check</span><span className="font-semibold text-foreground">$45.00</span></div>
        <div className="flex items-center justify-between border-t border-border pt-1.5 text-[11px] font-bold"><span className="text-foreground">Total due now</span><span className="text-foreground">$45.00</span></div>
      </div>
      <div className="mt-2 flex items-center justify-between rounded-lg border border-dashed border-border px-2.5 py-2">
        <span className="text-[10.5px] font-semibold text-muted">Card ending 4242</span>
        <span className="text-[9.5px] font-bold text-primary">Change</span>
      </div>
      <p className="mt-2 text-[9.5px] leading-relaxed text-muted">Charged once, only after Seattle Homes reviews your documents.</p>
      <StickyButton label="Pay $45 & submit" active />
    </div>,
    <div key={3} className="flex h-full flex-col">
      {header(3)}
      <div className="flex flex-col items-center pt-1 text-center">
        <div className="mb-2 grid h-10 w-10 place-items-center rounded-full bg-[#e8f7ee] text-[#15803d]">✓</div>
        <p className="text-[12px] font-bold text-foreground">Application submitted</p>
        <p className="mt-1 text-[10.5px] text-muted">Fremont Studio · $45 paid</p>
      </div>
      <div className="mt-3 space-y-1.5 rounded-lg border border-border p-2.5">
        <div className="flex items-center justify-between text-[10.5px]"><span className="text-muted">Applicant</span><span className="font-semibold text-foreground">Jamie P.</span></div>
        <div className="flex items-center justify-between text-[10.5px]"><span className="text-muted">Property</span><span className="font-semibold text-foreground">Fremont Studio</span></div>
        <div className="flex items-center justify-between text-[10.5px]"><span className="text-muted">Documents</span><span className="font-semibold text-[#15803d]">Complete</span></div>
        <div className="flex items-center justify-between text-[10.5px]"><span className="text-muted">Status</span><span className="font-semibold text-foreground">Under review</span></div>
      </div>
      <div className="mt-2.5 flex items-center gap-2 rounded-lg bg-[var(--pl-surface-muted)] px-2.5 py-2">
        <span className="grid h-5 w-5 shrink-0 place-items-center rounded-full bg-primary/15 text-[9px] text-primary">✦</span>
        <p className="text-[10px] text-muted">Seattle Homes usually decides within a day.</p>
      </div>
      <StickyButton label="View application" active={false} />
    </div>,
  ];
}

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
      { kind: "static", id: "prospect", label: "Prospect", device: "phone", beats: toursProspectBeats() },
      { kind: "iframe", id: "manager", label: "Manager", role: "manager", section: "tours", tab: "upcoming", device: "desktop", path: "/portal/tours/upcoming" },
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
      { kind: "static", id: "prospect", label: "Prospect", device: "phone", beats: applicationsProspectBeats() },
      { kind: "iframe", id: "manager", label: "Manager", role: "manager", section: "applications", device: "desktop", path: "/portal/applications/pending" },
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
      { kind: "iframe", id: "manager", label: "Manager", role: "manager", section: "leases", device: "desktop", path: "/portal/leases" },
      {
        kind: "iframe",
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
      { kind: "iframe", id: "resident", label: "Resident", role: "resident", section: "payments", tab: "overdue", device: "phone", path: "/resident/payments" },
      { kind: "iframe", id: "manager", label: "Manager", role: "manager", section: "payments", tab: "overdue", device: "desktop", path: "/portal/payments/incoming/overdue" },
      { kind: "iframe", id: "vendor", label: "Vendor", role: "vendor", section: "dashboard", device: "phone", path: "/vendor/dashboard" },
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
      { kind: "iframe", id: "resident", label: "Resident", role: "resident", section: "services", tab: "scheduled", device: "phone", path: "/resident/services" },
      { kind: "iframe", id: "manager", label: "Manager", role: "manager", section: "services", tab: "work-orders", device: "desktop", path: "/portal/services" },
      { kind: "iframe", id: "vendor", label: "Vendor", role: "vendor", section: "work-orders", tab: "upcoming", device: "phone", path: "/vendor/work-orders" },
    ],
  },
];

function demoSrc(p: IframePerspective): string {
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

/** Desktop app window (browser-chrome-lite bar) or phone bezel — around the
 * real, interactive `/demo` iframe for an "iframe" perspective, or a small
 * static, token-accurate body for a "static" one (see the file's scope note). */
function DeviceFrame({
  perspective,
  label,
  kicker,
  beat,
  iframeRef,
}: {
  perspective: Perspective;
  label: string;
  kicker: string;
  beat: number;
  iframeRef: (el: HTMLIFrameElement | null) => void;
}) {
  if (perspective.kind === "static") {
    return (
      <div className="mx-auto w-[236px] shrink-0 rounded-[2.1rem] border-[7px] border-foreground/90 bg-foreground/90 shadow-[0_22px_46px_-16px_rgba(15,23,42,0.4)]">
        <div className="flex h-[478px] w-full flex-col overflow-hidden rounded-[1.5rem] bg-background">
          <div className="flex items-center gap-1.5 border-b border-border px-3 py-2.5">
            <span className="text-[9.5px] font-bold text-muted">‹</span>
            <span className="truncate text-[9.5px] font-semibold text-muted">proplane.ai/listings/fremont-studio</span>
          </div>
          <div className="flex-1 overflow-hidden p-3">{perspective.beats[beat % perspective.beats.length]}</div>
        </div>
      </div>
    );
  }
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
            proplane.ai{perspective.path}
          </span>
        </div>
        <iframe
          key={src}
          ref={iframeRef}
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
        <iframe key={src} ref={iframeRef} src={src} title={title} loading="lazy" className="block h-full w-full border-0" />
      </div>
    </div>
  );
}

const BEATS_PER_PERSPECTIVE = 4;
const BEAT_INTERVAL_MS = 1800;

function LifecycleRow({ step, flip }: { step: LifecycleStep; flip: boolean }) {
  const reducedMotion = useReducedMotion();
  const [activeIdx, setActiveIdx] = useState(0);
  const [beat, setBeat] = useState(0);
  const [paused, setPaused] = useState(false);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const multiplePerspectives = step.perspectives.length > 1;

  const active = step.perspectives[activeIdx] ?? step.perspectives[0]!;
  const postBeat = useCallback((nextBeat: number) => {
    if (active.kind !== "iframe") return;
    const win = iframeRef.current?.contentWindow;
    if (!win) return;
    const message: LifecycleBeatMessage = { source: LIFECYCLE_BEAT_MESSAGE_SOURCE, scenario: step.id, beat: nextBeat };
    try {
      win.postMessage(message, window.location.origin);
    } catch {
      /* the iframe hasn't finished loading yet — the next tick retries */
    }
  }, [step.id, active]);

  // Scripted beats: advance every ~1.8s (never under reduced motion or while
  // paused); after BEATS_PER_PERSPECTIVE beats, rotate to the next
  // perspective and start that one's beats from 0.
  useEffect(() => {
    if (timerRef.current) clearInterval(timerRef.current);
    timerRef.current = null;
    if (reducedMotion || paused) return;
    timerRef.current = setInterval(() => {
      setBeat((b) => {
        const next = (b + 1) % BEATS_PER_PERSPECTIVE;
        if (next === 0 && multiplePerspectives) {
          setActiveIdx((i) => (i + 1) % step.perspectives.length);
        }
        return next;
      });
    }, BEAT_INTERVAL_MS);
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [reducedMotion, paused, multiplePerspectives, step.perspectives.length]);

  // Post the current beat whenever it (or the active perspective/iframe)
  // changes — covers the scripted tick above AND a manual tab/replay switch.
  useEffect(() => {
    const id = window.setTimeout(() => postBeat(beat), 150);
    return () => window.clearTimeout(id);
  }, [beat, activeIdx, postBeat]);

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
        <div className="flex items-center gap-2">
          {multiplePerspectives ? (
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
                      setBeat(0);
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
          ) : null}
          <button
            type="button"
            aria-label={`Replay the ${step.kicker.toLowerCase()} demo`}
            title="Replay"
            data-attr={`home-lifecycle-${step.id}-replay`}
            onClick={() => {
              setBeat(0);
              setPaused(false);
            }}
            className="grid h-6 w-6 shrink-0 place-items-center rounded-full border border-border bg-card text-muted hover:text-foreground"
          >
            <ReplayIcon />
          </button>
        </div>
      </div>
      <DeviceFrame
        perspective={active}
        label={active.label}
        kicker={step.kicker}
        beat={beat}
        iframeRef={(el) => {
          iframeRef.current = el;
        }}
      />
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
