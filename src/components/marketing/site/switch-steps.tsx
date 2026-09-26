"use client";

// `PortalRowFact` (portal-record-row.tsx) is a client component whose `icon`
// prop is a lucide component reference, not a rendered element — the exact
// pattern review-step.tsx uses it with, and the reason THAT file is also
// "use client" — a Server Component can't pass a bare function reference
// across the RSC boundary into a Client Component's props.
import {
  AlertCircle,
  Calendar,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  DoorOpen,
  EyeOff,
  Hash,
  MoreHorizontal,
} from "lucide-react";
import { PortalRowFact } from "@/components/portal/portal-record-row";
import { MockFrame, SiteCtaPair, SiteEyebrow, SiteIntro, SiteSection } from "@/components/marketing/site/primitives";
import { cn } from "@/lib/utils";

type SwitchStep = { eyebrow: string; title: string; body: string };

const STEPS: SwitchStep[] = [
  {
    eyebrow: "Step 1",
    title: "Import your portfolio",
    body: "Drop a rent roll, an AppFolio or Buildium export, or lease PDFs. One read returns properties, rooms, residents, leases and open balances together.",
  },
  {
    eyebrow: "Step 2",
    title: "Review what the agent found",
    body: "One card per property, one row per resident, each citing the row or page it came from. Anything the file didn't say clearly is flagged, not guessed.",
  },
  {
    eyebrow: "Step 3",
    title: "Create it, invite when you're ready",
    body: "Properties, residents, leases, charges and tasks are created through the same paths every other create in PropLane uses. Nothing is emailed until you say so.",
  },
];

/**
 * A faithful, static replica of `/portal/properties/import`'s Review step —
 * the real three-step flow is Upload → Review → Create (never the 5-step
 * "match columns" wizard this section used to invent). Same summary-line
 * shape, same property-card / resident-row anatomy — avatar, room, lease
 * dates, source citation, plain status word (never a pill, matching the
 * real `review-step.tsx`), rent right-aligned, one row expanded to show its
 * gap inline, one empty room with its own Skip — down to reusing
 * `PortalRowFact`, the same icon-fact atom the real row renders with.
 * See `docs/agents/portfolio-import.md`.
 */
export function SiteSwitchSteps() {
  return (
    <SiteSection tone="muted" ariaLabelledBy="site-switch-heading">
      <SiteIntro
        eyebrow="Switching"
        id="site-switch-heading"
        title="Up and running without starting over."
        lede="Your properties, units and residents come with you. Here's what switching to PropLane looks like."
      />
      <div className="grid grid-cols-[minmax(0,1fr)] gap-10 lg:grid-cols-2 lg:items-start">
        <div className="min-w-0">
          <div className="space-y-8">
            {STEPS.map((step) => (
              <div key={step.title} className="border-t border-border pt-5">
                <SiteEyebrow className="mb-2">{step.eyebrow}</SiteEyebrow>
                <h3 className="text-[19px] font-bold leading-snug tracking-tight text-foreground">{step.title}</h3>
                <p className="mt-2 text-[14.5px] leading-relaxed text-muted">{step.body}</p>
              </div>
            ))}
          </div>
          <SiteCtaPair primaryAttr="home-switch-get-started" secondaryAttr="home-switch-book-demo" className="mt-8" />
        </div>
        <div className="mx-auto w-full min-w-0 max-w-[540px] lg:mr-0">
          <MockFrame title="Manager · Review what the agent found">
            <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px] text-muted">
              <span className="font-medium text-foreground">rent-roll.xlsx</span>
              <span aria-hidden>·</span>
              <span>2 properties</span>
              <span aria-hidden>·</span>
              <span>7 rooms</span>
              <span aria-hidden>·</span>
              <span>4 residents</span>
              <span aria-hidden>·</span>
              <span>1 open item</span>
            </p>

            {/* Maple Court — one ready resident, one needing an end date, expanded. */}
            <div className="mt-3 rounded-2xl border border-border">
              <div className="px-3.5 py-2.5">
                <p className="text-[13.5px] font-bold text-foreground">Maple Court · 220 Maple Ave</p>
                <p className="text-[11.5px] text-muted">4 rooms</p>
              </div>
              <div className="border-t border-border">
                <div className="flex items-center gap-2.5 px-3.5 py-2">
                  <div
                    aria-hidden
                    className="grid size-8 shrink-0 place-items-center rounded-[9px] bg-primary/[0.08] text-[11px] font-extrabold text-primary"
                  >
                    DR
                  </div>
                  <div className="min-w-0 flex-1">
                    <span className="block truncate text-[13px] font-semibold text-foreground">Dana Reyes</span>
                    <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-muted">
                      <PortalRowFact icon={DoorOpen}>Room 1</PortalRowFact>
                      <PortalRowFact icon={Calendar}>Mar 1, 2025 – Feb 28, 2026</PortalRowFact>
                      <PortalRowFact icon={Hash}>row 4</PortalRowFact>
                      <PortalRowFact icon={CheckCircle2}>Ready</PortalRowFact>
                    </span>
                  </div>
                  <span className="shrink-0 text-[13px] font-bold text-foreground">$1,850/mo</span>
                  <MoreHorizontal className="size-4 shrink-0 text-muted" aria-hidden />
                </div>
                <div className="border-t border-border">
                  <div className="flex items-center gap-2.5 px-3.5 py-2">
                    <div
                      aria-hidden
                      className="grid size-8 shrink-0 place-items-center rounded-[9px] bg-primary/[0.08] text-[11px] font-extrabold text-primary"
                    >
                      LO
                    </div>
                    <div className="min-w-0 flex-1">
                      <span className="flex items-center gap-1 text-[13px] font-semibold text-foreground">
                        <ChevronDown className="size-3.5 shrink-0 text-muted" aria-hidden />
                        Luis Ortega
                      </span>
                      <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-muted">
                        <PortalRowFact icon={DoorOpen}>Room 3</PortalRowFact>
                        <PortalRowFact icon={Calendar}>Jun 1, 2025 – —</PortalRowFact>
                        <PortalRowFact icon={Hash}>row 6</PortalRowFact>
                        <PortalRowFact icon={AlertCircle}>Needs end date</PortalRowFact>
                      </span>
                    </div>
                    <span className="shrink-0 text-[13px] font-bold text-foreground">$1,400/mo</span>
                    <MoreHorizontal className="size-4 shrink-0 text-muted" aria-hidden />
                  </div>
                  <div className="border-t border-border bg-foreground/[0.02] px-3.5 py-2.5 pl-12">
                    <label className="mb-1 block text-[11px] font-semibold text-foreground">When does the lease end?</label>
                    <div className="flex h-8 w-40 items-center rounded-lg border border-border bg-card px-2 text-[12px] text-muted">
                      mm/dd/yyyy
                    </div>
                  </div>
                </div>
                <div className="flex items-center gap-2.5 border-t border-border px-3.5 py-2">
                  <div aria-hidden className="grid size-8 shrink-0 place-items-center rounded-[9px] bg-foreground/[0.06] text-muted">
                    <DoorOpen className="size-3.5" strokeWidth={1.6} />
                  </div>
                  <span className="min-w-0 flex-1 truncate text-[13px] text-foreground/70">Room 4 · Leave empty</span>
                  <span className="text-[11.5px] font-bold text-muted">Skip</span>
                </div>
              </div>
            </div>

            {/* 1412 Pine St — everyone ready. */}
            <div className="mt-3 rounded-2xl border border-border">
              <div className="px-3.5 py-2.5">
                <p className="text-[13.5px] font-bold text-foreground">1412 Pine St</p>
                <p className="text-[11.5px] text-muted">3 rooms</p>
              </div>
              <div className="border-t border-border">
                <div className="flex items-center gap-2.5 px-3.5 py-2">
                  <div
                    aria-hidden
                    className="grid size-8 shrink-0 place-items-center rounded-[9px] bg-primary/[0.08] text-[11px] font-extrabold text-primary"
                  >
                    SC
                  </div>
                  <div className="min-w-0 flex-1">
                    <span className="flex items-center gap-1 text-[13px] font-semibold text-foreground">
                      <ChevronRight className="size-3.5 shrink-0 text-transparent" aria-hidden />
                      Sam Chen
                    </span>
                    <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-muted">
                      <PortalRowFact icon={DoorOpen}>Room 1</PortalRowFact>
                      <PortalRowFact icon={Calendar}>Jan 1, 2025 – Dec 31, 2025</PortalRowFact>
                      <PortalRowFact icon={Hash}>row 11</PortalRowFact>
                      <PortalRowFact icon={CheckCircle2}>Ready</PortalRowFact>
                    </span>
                  </div>
                  <span className="shrink-0 text-[13px] font-bold text-foreground">$1,100/mo</span>
                  <MoreHorizontal className="size-4 shrink-0 text-muted" aria-hidden />
                </div>
                <div className="flex items-center gap-2.5 border-t border-border px-3.5 py-2">
                  <div
                    aria-hidden
                    className="grid size-8 shrink-0 place-items-center rounded-[9px] bg-primary/[0.08] text-[11px] font-extrabold text-primary"
                  >
                    JW
                  </div>
                  <div className="min-w-0 flex-1">
                    <span className="flex items-center gap-1 text-[13px] font-semibold text-foreground">
                      <ChevronRight className="size-3.5 shrink-0 text-transparent" aria-hidden />
                      Jordan Wu
                    </span>
                    <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-muted">
                      <PortalRowFact icon={DoorOpen}>Room 2</PortalRowFact>
                      <PortalRowFact icon={Calendar}>Feb 1, 2025 – Jan 31, 2026</PortalRowFact>
                      <PortalRowFact icon={Hash}>row 12</PortalRowFact>
                      <PortalRowFact icon={CheckCircle2}>Ready</PortalRowFact>
                    </span>
                  </div>
                  <span className="shrink-0 text-[13px] font-bold text-foreground">$1,050/mo</span>
                  <MoreHorizontal className="size-4 shrink-0 text-muted" aria-hidden />
                </div>
                <div className="flex items-center gap-2.5 border-t border-border px-3.5 py-2">
                  <div aria-hidden className="grid size-8 shrink-0 place-items-center rounded-[9px] bg-foreground/[0.06] text-muted">
                    <EyeOff className="size-3.5" strokeWidth={1.6} />
                  </div>
                  <span className="min-w-0 flex-1 truncate text-[13px] text-foreground/70">Room 3 · Leave empty</span>
                  <span className="text-[11.5px] font-bold text-muted">Skip</span>
                </div>
              </div>
            </div>

            <div className={cn("mt-4 flex items-center justify-between gap-2")}>
              <span className="text-[11.5px] text-muted">Nothing is emailed until you say so</span>
              <span className="inline-flex h-8 shrink-0 items-center rounded-full bg-primary px-4 text-[12.5px] font-bold text-white">
                Create 4…
              </span>
            </div>
          </MockFrame>
        </div>
      </div>
    </SiteSection>
  );
}
