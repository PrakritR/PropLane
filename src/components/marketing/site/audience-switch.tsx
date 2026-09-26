"use client";

import { Building2, CheckCircle2, Circle, DoorOpen, Home, Users } from "lucide-react";
import Link from "next/link";
import { useState, type ReactNode } from "react";
import { RESIDENT_BROWSE_PATH } from "@/lib/resident-public-nav";
import { PortalRowFact } from "@/components/portal/portal-record-row";
import { MockChip, MockFrame, SiteIntro, SiteSection } from "@/components/marketing/site/primitives";
import { cn } from "@/lib/utils";

type AudienceId = "managers" | "residents" | "vendors";

/** A property tile — never a fabricated photo (`no-production-live-listings.mdc`
 * / the real product's own rule), so this mirrors `NoImagePlaceholder`: a
 * plain icon tile, same as the real one renders for a listing with no photo. */
function PropertyTile() {
  return (
    <span aria-hidden className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-foreground/[0.06] text-muted">
      <Home className="size-[18px]" strokeWidth={1.6} />
    </span>
  );
}

const AUDIENCES: {
  id: AudienceId;
  tab: string;
  title: string;
  points: string[];
  href: string;
  cta: string;
  dataAttr: string;
  mock: ReactNode;
}[] = [
  {
    id: "managers",
    tab: "Managers & landlords",
    title: "Run one home or twenty from one queue.",
    points: [
      "List, screen, lease and collect — the AI runs the busywork",
      "Co-managers with per-module access",
      "Ledger, deposits and reports your accountant will take",
      "Import from AppFolio, Buildium or a spreadsheet — nothing re-typed",
    ],
    href: "/partner",
    cta: "For managers",
    dataAttr: "home-audience-managers",
    // The real Properties list surface's row shape (AGENTS.md portal UI
    // system): tile · title · place line · glyph facts · figure · ⋯, never
    // a pill — populated with the same seeded Seattle Homes portfolio the
    // embedded window above uses, not invented properties.
    mock: (
      <MockFrame title="Manager · Properties">
        <div className="divide-y divide-border/60">
          {[
            { name: "Alder House", place: "412 Alder St", rooms: "1 room", occupied: "1 / 1 occupied", rent: "$3,200/mo" },
            { name: "Maple Duplex", place: "88 Maple Ave · Unit A", rooms: "1 unit", occupied: "1 / 1 occupied", rent: "$1,850/mo" },
            { name: "Fremont Studio", place: "590 N 36th St", rooms: "Studio", occupied: "1 / 1 occupied", rent: "$1,400/mo" },
          ].map((p) => (
            <div key={p.name} className="flex items-center gap-3 py-2.5">
              <PropertyTile />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13.5px] font-semibold text-foreground">{p.name}</span>
                <span className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11.5px] text-muted">
                  <PortalRowFact icon={Building2}>{p.place}</PortalRowFact>
                  <PortalRowFact icon={Users}>{p.occupied}</PortalRowFact>
                </span>
              </span>
              <span className="shrink-0 text-[13px] font-bold text-foreground">{p.rent}</span>
            </div>
          ))}
        </div>
      </MockFrame>
    ),
  },
  {
    id: "residents",
    tab: "Residents",
    title: "Apply, sign, pay and ask — from your phone.",
    points: [
      "Browse homes and book a tour in a minute",
      "One application, e-signed lease, rent by card or bank",
      "Repairs and questions answered in one inbox",
    ],
    href: RESIDENT_BROWSE_PATH,
    cta: "For residents",
    dataAttr: "home-audience-residents",
    // The real resident Payments charge-row shape: a title, a due/paid date,
    // a plain status word — never a pill — and the amount in bold on the
    // right. Same Alder House resident and charge history the embedded
    // window's Resident view renders (one overdue current charge, paid
    // history behind it), not invented figures.
    mock: (
      <MockFrame title="Resident · Payments" aside={<MockChip tone="warn">1 overdue</MockChip>}>
        <p className="mb-2 px-1 text-[12.5px] text-muted">Alder House · Test Resident</p>
        <div className="divide-y divide-border/60">
          {[
            { title: "Rent · October 2026", when: "Due Sep 20", status: "Overdue", icon: Circle, amount: "$3,200.00", danger: true },
            { title: "Rent · September 2026", when: "Paid Sep 1", status: "Paid", icon: CheckCircle2, amount: "$3,200.00" },
            { title: "Rent · August 2026", when: "Paid Aug 1", status: "Paid", icon: CheckCircle2, amount: "$3,200.00" },
          ].map((c) => (
            <div key={c.title} className="flex items-center gap-3 py-2.5">
              <span
                aria-hidden
                className={cn(
                  "grid h-9 w-9 shrink-0 place-items-center rounded-full text-[13px] font-bold",
                  c.danger ? "bg-[var(--status-danger-bg,#fdeaea)] text-[var(--status-danger-fg,#b3261e)]" : "bg-accent/70 text-foreground",
                )}
              >
                $
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-[13.5px] font-semibold text-foreground">{c.title}</span>
                <span className="mt-0.5 flex items-center gap-2 text-[11.5px] text-muted">
                  <span>{c.when}</span>
                  <PortalRowFact icon={c.icon}>{c.status}</PortalRowFact>
                </span>
              </span>
              <span className={cn("shrink-0 text-[13px] font-bold", c.danger ? "text-[var(--status-danger-fg,#b3261e)]" : "text-foreground")}>
                {c.amount}
              </span>
            </div>
          ))}
        </div>
      </MockFrame>
    ),
  },
  {
    id: "vendors",
    tab: "Vendors",
    title: "Get matched, bid, show up, get paid.",
    points: [
      "Job offers by text; bid from your phone",
      "Visits on your calendar with entry instructions",
      "Invoice once, paid by Connect",
    ],
    href: "/vendors",
    cta: "For vendors",
    dataAttr: "home-audience-vendors",
    // The real vendor Jobs tabs are Pending / Upcoming / Past
    // (vendor-work-order-tabs.ts), not an invented set — populated with
    // Pacific Plumbing's two seeded Seattle Homes jobs: Maple's open "No
    // hot water" call (needs a bid, the Pending tab) and Alder's already
    // accepted faucet repair (the Upcoming tab).
    mock: (
      <MockFrame title="Vendor · Jobs">
        <div className="mb-3 flex gap-1.5">
          {["Pending", "Upcoming", "Past"].map((t, i) => (
            <span
              key={t}
              className={cn(
                "inline-flex items-center rounded-full px-2.5 py-1 text-[11px] font-bold",
                i === 0 ? "bg-primary/10 text-primary" : "text-muted",
              )}
            >
              {t}
            </span>
          ))}
        </div>
        <div className="divide-y divide-border/60">
          <div className="flex items-center gap-3 py-2.5">
            <span aria-hidden className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-accent/70 text-[12px] font-extrabold text-foreground">
              PP
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-[13.5px] font-semibold text-foreground">No hot water · Maple Duplex</span>
              <span className="mt-0.5 flex items-center gap-2 text-[11.5px] text-muted">
                <PortalRowFact icon={DoorOpen}>WO-1043</PortalRowFact>
                <span>Needs a bid</span>
              </span>
            </span>
            <span className="shrink-0 rounded-full bg-primary px-3 py-1 text-[11.5px] font-bold text-white">Bid</span>
          </div>
          <div className="flex items-center gap-3 py-2.5">
            <span aria-hidden className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-[var(--status-confirmed-bg)] text-[13px] font-bold text-[var(--status-confirmed-fg)]">
              ✓
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-[13.5px] font-semibold text-foreground">Faucet cartridge · Alder House</span>
              <span className="mt-0.5 flex items-center gap-2 text-[11.5px] text-muted">
                <PortalRowFact icon={DoorOpen}>WO-1042</PortalRowFact>
                <span>Bid accepted</span>
              </span>
            </span>
            <span className="shrink-0 text-[13px] font-bold text-foreground">$140</span>
          </div>
        </div>
      </MockFrame>
    ),
  },
];

/** Who it's for: three sign-ins, one home — a tab per audience with its own screen. */
export function SiteAudienceSwitch() {
  const [active, setActive] = useState<AudienceId>("managers");
  const current = AUDIENCES.find((a) => a.id === active) ?? AUDIENCES[0]!;
  return (
    <SiteSection id="who-its-for" ariaLabelledBy="site-audience-title">
      <SiteIntro id="site-audience-title" title="Three sign-ins. One home." />
      <div role="tablist" aria-label="Audience" className="mb-8 inline-flex flex-wrap gap-1 rounded-full border border-border bg-[var(--pl-surface-muted)] p-1 [html[data-theme=dark]_&]:bg-white/[0.04]">
        {AUDIENCES.map((a) => {
          const on = a.id === active;
          return (
            <button
              key={a.id}
              type="button"
              role="tab"
              aria-selected={on}
              aria-controls={`site-audience-${a.id}`}
              data-attr={`home-audience-tab-${a.id}`}
              onClick={() => setActive(a.id)}
              className={cn(
                "rounded-full px-4 py-2 text-[13.5px] font-bold transition-colors",
                on ? "bg-card text-foreground shadow-[var(--shadow-sm)]" : "text-muted hover:text-foreground",
              )}
            >
              {a.tab}
            </button>
          );
        })}
      </div>
      <div
        id={`site-audience-${current.id}`}
        role="tabpanel"
        className="grid items-center gap-8 lg:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)] lg:gap-14"
      >
        <div className="min-w-0">
          <h3 className="text-[clamp(1.4rem,2.6vw,1.9rem)] font-bold leading-tight tracking-tight text-foreground">{current.title}</h3>
          <ul className="mt-5 space-y-3">
            {current.points.map((p) => (
              <li key={p} className="flex items-start gap-2.5 text-[15px] leading-relaxed text-foreground/90">
                <span aria-hidden className="mt-[7px] h-2 w-2 shrink-0 rounded-full bg-primary" />
                {p}
              </li>
            ))}
          </ul>
          <Link
            href={current.href}
            data-attr={current.dataAttr}
            className="mt-6 inline-flex items-center gap-1.5 text-[15px] font-bold text-primary hover:underline"
          >
            {current.cta} <span aria-hidden>→</span>
          </Link>
        </div>
        <div className="mx-auto w-full max-w-[540px] lg:mr-0">{current.mock}</div>
      </div>
    </SiteSection>
  );
}
