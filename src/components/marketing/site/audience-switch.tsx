"use client";

import Link from "next/link";
import { useState, type ReactNode } from "react";
import { RESIDENT_BROWSE_PATH } from "@/lib/resident-public-nav";
import { DemoRouteSlice } from "@/components/marketing/site/demo-route-slice";
import { SiteIntro, SiteSection } from "@/components/marketing/site/primitives";
import { cn } from "@/lib/utils";

type AudienceId = "managers" | "residents" | "vendors";

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
    // A real slice of the manager Properties list — same seeded Seattle
    // Homes portfolio the embedded window above uses, not invented rows.
    mock: <DemoRouteSlice role="manager" section="properties" height={440} label="manager Properties" />,
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
    // A real slice of the resident Payments list — the same Alder House
    // resident and charge history the embedded window's Resident view
    // renders, not invented figures.
    mock: <DemoRouteSlice role="resident" section="payments" height={440} label="resident Payments" />,
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
    // A real slice of the vendor Jobs list (the work-orders section) —
    // Pacific Plumbing's two seeded Seattle Homes jobs, not an invented set.
    mock: <DemoRouteSlice role="vendor" section="work-orders" height={440} label="vendor Jobs" />,
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
