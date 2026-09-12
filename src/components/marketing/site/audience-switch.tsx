"use client";

import Link from "next/link";
import { useState, type ReactNode } from "react";
import { RESIDENT_BROWSE_PATH } from "@/lib/resident-public-nav";
import { MockAvatar, MockChip, MockFrame, SiteIntro, SiteSection } from "@/components/marketing/site/primitives";
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
      "List, screen, lease and collect — approval-first",
      "Co-managers with per-module access",
      "Ledger, deposits and reports your accountant will take",
    ],
    href: "/partner",
    cta: "For managers",
    dataAttr: "home-audience-managers",
    mock: (
      <MockFrame title="Manager · Properties">
        <div className="divide-y divide-border/60">
          {[
            ["Ash Flats 6", "2 rooms · 2 bd / 1 ba", "From $1,160/mo", "0 / 2 occupied"],
            ["Ballard House", "3 rooms · 3 bd / 1 ba", "From $1,050/mo", "3 / 3 occupied"],
          ].map(([n, a, b, c]) => (
            <div key={n} className="flex items-center gap-3 py-2.5">
              <MockAvatar name={n!} />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13.5px] font-semibold text-foreground">{n}</span>
                <span className="block truncate text-[12px] text-muted">{a}</span>
              </span>
              <span className="text-right">
                <span className="block text-[13px] font-semibold text-foreground">{b}</span>
                <span className="block text-[11.5px] text-muted">{c}</span>
              </span>
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
    mock: (
      <MockFrame title="Resident · Home" aside={<MockChip tone="good">Lease signed</MockChip>}>
        <p className="mb-2 px-1 text-[12.5px] text-muted">2100 Westlake Ave N · Studio</p>
        <div className="divide-y divide-border/60">
          <div className="flex items-center gap-3 py-2.5">
            <span className="grid h-8 w-8 place-items-center rounded-full bg-accent/70 text-[13px] font-bold text-foreground">$</span>
            <span className="min-w-0 flex-1">
              <span className="block text-[13.5px] font-semibold text-foreground">Rent · October</span>
              <span className="block text-[12px] text-muted">Due Oct 1 · autopay on</span>
            </span>
            <MockChip tone="info">Pay $1,800</MockChip>
          </div>
          <div className="flex items-center gap-3 py-2.5">
            <span className="grid h-8 w-8 place-items-center rounded-full bg-accent/70 text-[13px] font-bold text-primary">✦</span>
            <span className="min-w-0 flex-1">
              <span className="block text-[13.5px] font-semibold text-foreground">Move-in inspection</span>
              <span className="block text-[12px] text-muted">Photos due Sep 20</span>
            </span>
            <MockChip>Open</MockChip>
          </div>
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
    mock: (
      <MockFrame title="Vendor · Services">
        <div className="divide-y divide-border/60">
          <div className="flex items-center gap-3 py-2.5">
            <MockAvatar name="Pacific Plumbing" />
            <span className="min-w-0 flex-1">
              <span className="block text-[13.5px] font-semibold text-foreground">Faucet drip · Maple 2A</span>
              <span className="block text-[12px] text-muted">Offered by Alex · reply by Wed</span>
            </span>
            <MockChip tone="info">Bid $140</MockChip>
          </div>
          <div className="flex items-center gap-3 py-2.5">
            <span className="grid h-8 w-8 place-items-center rounded-full bg-[var(--status-confirmed-bg)] text-[13px] font-bold text-[var(--status-confirmed-fg)]">✓</span>
            <span className="min-w-0 flex-1">
              <span className="block text-[13.5px] font-semibold text-foreground">Furnace check · Birch Flats</span>
              <span className="block text-[12px] text-muted">Invoice $220 · paid</span>
            </span>
            <MockChip tone="good">Paid</MockChip>
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
      <SiteIntro eyebrow="Who it's for" id="site-audience-title" title="Three sign-ins. One home." />
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
