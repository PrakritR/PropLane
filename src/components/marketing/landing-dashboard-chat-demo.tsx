"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import "./landing-proplane.css";

/** Semantic status dots — same tokens as manager-dashboard.tsx */
const DOT_OVERDUE = "var(--status-overdue-fg)";
const DOT_PENDING = "var(--status-pending-fg)";
const DOT_CONFIRMED = "var(--status-confirmed-fg)";
const DOT_INFO = "var(--status-approved-fg)";

type PillTone = "pending" | "success" | "danger" | "info";

type DemoPhase =
  | "idle"
  | "userTyping"
  | "assistantTyping"
  | "dashboardUpdate"
  | "hold";

const USER_MSG = "Chase overdue rent on Maple 2A and queue a reminder for my approval.";
const ASSISTANT_MSG =
  "Drafted a rent reminder for Jordan Lee · Maple 2A ($1,240). It's under Needs attention. Nothing sends until you approve.";

/**
 * Presentational 1:1 manager dashboard + PropLane Assistant side panel.
 * Scripted client demo: chat types → dashboard “Needs attention” updates.
 */
function usePrefersReducedMotion() {
  const [reduced, setReduced] = useState(false);

  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const sync = () => setReduced(mq.matches);
    sync();
    mq.addEventListener("change", sync);
    return () => mq.removeEventListener("change", sync);
  }, []);

  return reduced;
}

export function LandingDashboardChatDemo() {
  const rootRef = useRef<HTMLElement>(null);
  const announcedRef = useRef(false);
  const [active, setActive] = useState(false);
  const [phase, setPhase] = useState<DemoPhase>("idle");
  const [userTyped, setUserTyped] = useState("");
  const [assistantTyped, setAssistantTyped] = useState("");
  const [dashLive, setDashLive] = useState(false);
  /** Completed messages only — announced via aria-live, not per-character typing. */
  const [liveAnnouncement, setLiveAnnouncement] = useState("");
  const reducedMotion = usePrefersReducedMotion();

  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const io = new IntersectionObserver(
      ([entry]) => {
        if (entry?.isIntersecting) {
          setActive(true);
          io.disconnect();
        }
      },
      { threshold: 0.28, rootMargin: "0px 0px -8% 0px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  useEffect(() => {
    if (!active) return;

    // Static final snapshot — no typing loop or caret blink.
    if (reducedMotion) {
      setPhase("hold");
      setUserTyped(USER_MSG);
      setAssistantTyped(ASSISTANT_MSG);
      setDashLive(true);
      setLiveAnnouncement(`You: ${USER_MSG}. PropLane: ${ASSISTANT_MSG}`);
      return;
    }

    let cancelled = false;
    const timers: number[] = [];
    const wait = (ms: number) =>
      new Promise<void>((resolve) => {
        timers.push(window.setTimeout(resolve, ms));
      });

    const typeText = async (
      full: string,
      set: (v: string) => void,
      charMs = 18,
    ) => {
      set("");
      for (let i = 1; i <= full.length; i++) {
        if (cancelled) return;
        set(full.slice(0, i));
        await wait(charMs);
      }
    };

    const runOnce = async (isFirst: boolean) => {
      setPhase("idle");
      setUserTyped("");
      setAssistantTyped("");
      setDashLive(false);
      await wait(600);
      if (cancelled) return;

      setPhase("userTyping");
      await typeText(USER_MSG, setUserTyped, 16);
      if (cancelled) return;
      await wait(420);

      setPhase("assistantTyping");
      await typeText(ASSISTANT_MSG, setAssistantTyped, 14);
      if (cancelled) return;
      if (isFirst && !announcedRef.current) {
        setLiveAnnouncement(`You: ${USER_MSG}. PropLane: ${ASSISTANT_MSG}`);
        announcedRef.current = true;
      }
      await wait(380);

      setPhase("dashboardUpdate");
      setDashLive(true);
      await wait(2800);
      if (cancelled) return;

      setPhase("hold");
      await wait(2200);
    };

    void (async () => {
      await runOnce(true);
      // Soft loop so the interaction stays intentional without feeling frantic.
      while (!cancelled) {
        await wait(1600);
        if (cancelled) break;
        await runOnce(false);
      }
    })();

    return () => {
      cancelled = true;
      for (const t of timers) window.clearTimeout(t);
    };
  }, [active, reducedMotion]);

  const overdueAccent = !dashLive;
  const openCount = dashLive ? 5 : 4;
  const overdueSub = dashLive ? "1 overdue · AI draft ready" : "1 overdue charge";
  const paymentPill: PillTone = dashLive ? "info" : "danger";
  const paymentPillLabel = dashLive ? "AI draft" : "Overdue";
  const paymentDot = dashLive ? DOT_INFO : DOT_OVERDUE;
  const isTyping = phase === "userTyping" || phase === "assistantTyping";

  return (
    <section
      ref={rootRef}
      id="product"
      className="lp-dash-demo scroll-mt-20"
      aria-label="Manager dashboard and PropLane Assistant demo"
    >
      <div className="lp-w-wide">
        <header className="lp-dash-demo-intro">
          <h2>Ask PropLane. Watch the dashboard move.</h2>
          <p>
            The same manager home you use in the portal (KPIs, Needs attention, and approvals) with the
            assistant drafting beside it.
          </p>
        </header>

        <div className="lp-dash-demo-stage" data-attr="home-dashboard-chat-demo">
          <div className="lp-dash-demo-chrome">
            <i />
            <i />
            <i />
            <span style={{ marginLeft: 8 }}>Dashboard · Manager</span>
            <span className="lp-ml">{dashLive ? "AI draft ready" : "Live preview"}</span>
          </div>

          <div className="lp-dash-demo-split">
            <div className={`lp-dash-pane${dashLive ? " lp-dash-pane--live" : ""}`}>
              <DemoDashboardShell
                overdueAccent={overdueAccent}
                overdueSub={overdueSub}
                openCount={openCount}
                paymentPill={paymentPill}
                paymentPillLabel={paymentPillLabel}
                paymentDot={paymentDot}
                dashLive={dashLive}
              />
            </div>

            <aside className="lp-assistant-pane" aria-busy={isTyping || undefined}>
              <div className="lp-assistant-head">
                <span className="lp-assistant-mark" aria-hidden>
                  ✦
                </span>
                <div className="min-w-0">
                  <p className="lp-assistant-title">PropLane Assistant</p>
                  <p className="lp-assistant-sub">Ask about your portfolio in plain language</p>
                </div>
              </div>

              {/* Visually hidden: announce completed turns only, not per-character typing. */}
              <div className="sr-only" aria-live="polite" aria-atomic="true">
                {liveAnnouncement}
              </div>

              <div className="lp-assistant-thread" aria-hidden>
                {(phase !== "idle" || userTyped) && (
                  <div className="lp-assistant-bubble lp-assistant-bubble--user">
                    {userTyped}
                    {phase === "userTyping" ? <span className="lp-caret" aria-hidden /> : null}
                  </div>
                )}
                {(phase === "assistantTyping" ||
                  phase === "dashboardUpdate" ||
                  phase === "hold" ||
                  assistantTyped) && (
                  <div className="lp-assistant-bubble lp-assistant-bubble--bot">
                    <div className="lp-assistant-who">
                      <span className="lp-av">P</span> PropLane
                    </div>
                    {assistantTyped}
                    {phase === "assistantTyping" ? <span className="lp-caret" aria-hidden /> : null}
                  </div>
                )}
                {phase === "idle" && !userTyped ? (
                  <div className="lp-assistant-empty">
                    <p>What should we look at first?</p>
                    <span className="lp-assistant-hint">Rent reminders · Tours · Approvals</span>
                  </div>
                ) : null}
              </div>

              <div className="lp-assistant-input" aria-hidden>
                <span>Ask PropLane about your portfolio…</span>
                <div className="lp-send">↑</div>
              </div>
            </aside>
          </div>
        </div>
      </div>
    </section>
  );
}

function StatusPill({ tone, children }: { tone: PillTone; children: ReactNode }) {
  return (
    <span
      className={`inline-flex items-center whitespace-nowrap rounded-full px-2 py-0.5 text-[10px] font-semibold portal-badge-${tone}`}
    >
      {children}
    </span>
  );
}

function KpiTile({
  label,
  value,
  sub,
  accent,
}: {
  label: string;
  value: string | number;
  sub?: string;
  accent?: boolean;
}) {
  return (
    <div className="flex min-w-[7.5rem] flex-1 flex-col rounded-lg border border-border bg-card px-3.5 py-3">
      <span
        className={`text-[1.45rem] font-semibold leading-none tabular-nums tracking-[-0.02em] ${
          accent ? "text-[var(--status-overdue-fg)]" : "text-foreground"
        }`}
      >
        {value}
      </span>
      <span className="mt-1.5 text-[10px] font-semibold uppercase tracking-[0.1em] text-muted">{label}</span>
      {sub ? <span className="mt-0.5 text-[11px] text-muted/80">{sub}</span> : null}
    </div>
  );
}

function IssueRow({
  dot,
  title,
  subtitle,
  meta,
  pill,
  highlight,
}: {
  dot?: string;
  title: string;
  subtitle?: string;
  meta?: string | null;
  pill?: ReactNode;
  highlight?: boolean;
}) {
  return (
    <div
      className={`group flex items-center gap-3 px-3.5 py-2.5 transition-[background,box-shadow] duration-500 ${
        highlight ? "lp-issue-flash bg-[color-mix(in_srgb,var(--primary)_8%,transparent)]" : ""
      }`}
    >
      {dot ? (
        <span aria-hidden className="size-2 shrink-0 rounded-full" style={{ background: dot }} />
      ) : null}
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-semibold text-foreground">{title}</span>
        {subtitle ? <span className="mt-0.5 block truncate text-xs text-muted">{subtitle}</span> : null}
      </span>
      {meta ? (
        <span className="hidden shrink-0 whitespace-nowrap text-xs tabular-nums text-muted sm:block">{meta}</span>
      ) : null}
      {pill ? <span className="shrink-0">{pill}</span> : null}
      <span aria-hidden className="shrink-0 text-sm text-muted/40">
        ›
      </span>
    </div>
  );
}

function AttentionGroup({
  title,
  linkLabel,
  badge,
  children,
}: {
  title: string;
  linkLabel: string;
  badge?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="space-y-2">
      <div className="flex items-start justify-between gap-2 sm:items-center sm:gap-3">
        <h3 className="min-w-0 text-xs font-bold uppercase tracking-[0.12em] text-muted">{title}</h3>
        <div className="flex shrink-0 items-center gap-2">
          {badge ?? null}
          <span className="whitespace-nowrap text-xs font-semibold text-primary">{linkLabel}</span>
        </div>
      </div>
      <div className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-card">{children}</div>
    </div>
  );
}

function DemoDashboardShell({
  overdueAccent,
  overdueSub,
  openCount,
  paymentPill,
  paymentPillLabel,
  paymentDot,
  dashLive,
}: {
  overdueAccent: boolean;
  overdueSub: string;
  openCount: number;
  paymentPill: PillTone;
  paymentPillLabel: string;
  paymentDot: string;
  dashLive: boolean;
}) {
  return (
    <div className="lp-dash-inner space-y-5" tabIndex={0} role="region" aria-label="Dashboard preview">
      <div>
        <h2 className="text-[1.35rem] font-bold tracking-[-0.02em] text-foreground sm:text-[1.5rem]">
          Dashboard
        </h2>
        <p className="mt-0.5 text-sm text-muted">Welcome, Alex</p>
      </div>

      <div
        className="-mx-1 overflow-x-auto px-1 pb-1 [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        tabIndex={0}
        role="region"
        aria-label="Key metrics"
      >
        <div className="flex gap-2.5">
          <KpiTile label="Rooms vacant" value={1} sub="listed & available" accent />
          <KpiTile label="Applicants to review" value={2} sub="pending review" />
          <KpiTile label="Leases to sign" value={1} sub="1 need your signature" accent />
          <KpiTile
            label="Overdue balance"
            value="$1,240"
            sub={overdueSub}
            accent={overdueAccent}
          />
        </div>
      </div>

      <div className="space-y-4">
        <div className="flex items-center gap-2">
          <span aria-hidden className="text-primary">
            ✦
          </span>
          <h3 className="text-sm font-semibold tracking-[-0.01em] text-foreground">Needs attention</h3>
          <span className="ml-auto inline-flex items-center gap-1.5 rounded-full border border-border bg-[var(--secondary)] px-2.5 py-0.5 text-[11px] font-medium text-muted">
            <span aria-hidden className="size-1.5 rounded-full" style={{ background: DOT_CONFIRMED }} />
            {openCount} open
          </span>
        </div>

        <AttentionGroup title="Tour requests" linkLabel="Calendar →">
          <IssueRow
            dot={DOT_PENDING}
            title="Cascade 4B · Sat 11:00a"
            subtitle="Priya N. · Cascade Court"
            meta="Sat"
            pill={<StatusPill tone="pending">Pending</StatusPill>}
          />
        </AttentionGroup>

        <AttentionGroup title="Applications" linkLabel="Applications →">
          <IssueRow
            dot={DOT_PENDING}
            title="Maya Chen"
            subtitle="Cascade 4B"
            pill={<StatusPill tone="pending">Pending</StatusPill>}
          />
        </AttentionGroup>

        <AttentionGroup
          title="Pending & overdue payments"
          linkLabel="Payments →"
          badge={
            <span className="inline-flex items-center gap-1.5 text-[11px] font-semibold tabular-nums text-[var(--status-overdue-fg)]">
              <span aria-hidden className="size-1.5 rounded-full bg-current" />
              1 overdue
            </span>
          }
        >
          <IssueRow
            dot={paymentDot}
            title="Jordan Lee"
            subtitle="Rent · Maple 2A · due Apr 1"
            meta="$1,240"
            pill={<StatusPill tone={paymentPill}>{paymentPillLabel}</StatusPill>}
            highlight={dashLive}
          />
        </AttentionGroup>

        <AttentionGroup title="Communication" linkLabel="Communication →">
          {dashLive ? (
            <IssueRow
              dot={DOT_INFO}
              title="PropLane · Rent reminder draft"
              subtitle="Jordan Lee · Maple 2A · ready to approve"
              pill={<StatusPill tone="info">AI draft</StatusPill>}
              highlight
            />
          ) : (
            <IssueRow
              dot={DOT_INFO}
              title="Vendor bid · WO #142"
              subtitle="Pacific Plumbing submitted a bid"
              pill={<StatusPill tone="info">Unread</StatusPill>}
            />
          )}
        </AttentionGroup>
      </div>
    </div>
  );
}
