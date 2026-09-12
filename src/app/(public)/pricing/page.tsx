import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import { MANAGER_PLAN_TIERS, type ManagerPlanTierDefinition, type PlanTierId } from "@/data/manager-plan-tiers";
import { COMMS_INCLUDED_ALLOWANCE_CENTS } from "@/lib/comms-billing/allowances";
import { COMMS_CREDIT_PACKS_CENTS } from "@/lib/comms-billing/credit-packs";
import { COMMS_BILLING_RATES_CENTS, formatCentsRate, formatUsdFromCents } from "@/lib/comms-billing/rates";
import { BUSINESS_MAX_PROPERTIES, FREE_MAX_PROPERTIES, PRO_MAX_PROPERTIES } from "@/lib/manager-access";
import { MANAGER_GET_STARTED_HREF } from "@/lib/marketing/public-contact";
import { SiteFaq, type SiteFaqItem } from "@/components/marketing/site/faq";
import { SiteFinalCta } from "@/components/marketing/site/final-cta";
import {
  SITE_BTN_PRIMARY,
  SITE_BTN_SECONDARY,
  SITE_MEASURE,
  SiteHeading,
  SiteSection,
} from "@/components/marketing/site/primitives";
import { cn } from "@/lib/utils";

export const metadata: Metadata = {
  title: "Pricing",
  description:
    "PropLane pricing: free for one home, then Pro at $20/mo or Business at $200/mo. 14-day trial, no card required.",
};

const CTA_BASE = MANAGER_GET_STARTED_HREF;

const TIER_CTA: Record<PlanTierId, { href: string; label: string }> = {
  free: { href: `${CTA_BASE}&tier=free`, label: "Start free" },
  pro: { href: `${CTA_BASE}&tier=pro`, label: "Start 14-day trial" },
  business: { href: `${CTA_BASE}&tier=business`, label: "Start 14-day trial" },
};

/** One line under each plan's name — who it is for. */
const TIER_TAGLINE: Record<PlanTierId, string> = {
  free: "Try the core flow on one home.",
  pro: "Everything to run a couple of homes with residents in them.",
  business: "Pro at portfolio scale, with a team.",
};

/**
 * What each card lists. "Everything in X, plus" — a tier repeats nothing the
 * one before it already said, so the difference between two plans is the
 * whole list, not a diff a buyer has to run in their head. Caps come from
 * `manager-access` and the credit from `allowances`, never retyped.
 */
function tierIncludes(id: PlanTierId): { heading: string; items: { text: string; included: boolean }[] } {
  const credit = (t: PlanTierId) => formatUsdFromCents(COMMS_INCLUDED_ALLOWANCE_CENTS[t]!);
  if (id === "free") {
    return {
      heading: "What's included",
      items: [
        { text: `${FREE_MAX_PROPERTIES} property listing`, included: true },
        { text: "Applications & tour scheduling", included: true },
        { text: "Rent collection & charges", included: true },
        { text: "Inbox · dedicated phone number & texting", included: true },
        { text: `${credit("free")}/mo communication credit`, included: true },
        { text: "Residents, leases & services", included: false },
        { text: "Co-managers", included: false },
      ],
    };
  }
  if (id === "pro") {
    return {
      heading: "Everything in Free, plus",
      items: [
        { text: `Up to ${PRO_MAX_PROPERTIES} property listings`, included: true },
        { text: "Residents, leases & services", included: true },
        { text: "AI drafts in the inbox", included: true },
        { text: "Up to 2 co-managers", included: true },
        { text: `${credit("pro")}/mo communication credit`, included: true },
        { text: "Manager may cover processing fees", included: true },
      ],
    };
  }
  return {
    heading: "Everything in Pro, plus",
    items: [
      { text: `Up to ${BUSINESS_MAX_PROPERTIES} property listings`, included: true },
      { text: "Up to 20 co-managers, per-module access", included: true },
      { text: `${credit("business")}/mo communication credit`, included: true },
      { text: "Priority admin support", included: true },
    ],
  };
}

const CREDIT_PACKS_TEXT = (() => {
  const packs = COMMS_CREDIT_PACKS_CENTS.map((cents) => `$${cents / 100}`);
  return `${packs[0]} to ${packs[packs.length - 1]}`;
})();

const FAQ: SiteFaqItem[] = [
  {
    q: "Is the free tier actually free?",
    a: "Yes. $0, no card, one listing, applications, tours and rent collection. A dedicated phone number, inbox and a monthly communication credit are included.",
  },
  {
    q: "Do I need a credit card to try Pro or Business?",
    a: "No. The 14-day trial needs no card. You only add payment details if you decide to keep a paid plan after the trial.",
  },
  {
    q: "What happens at the end of the trial?",
    a: "Nothing sends and nothing is charged. Your data stays; add a card to keep Pro, or drop to Free.",
  },
  {
    q: "Can I change plans later?",
    a: "Upgrade or downgrade any time. Upgrading unlocks residents, leases and more co-managers right away.",
  },
  {
    q: "How does annual billing work?",
    a: `Paying for the year up front is two months free: Pro is ${MANAGER_PLAN_TIERS[1]!.annual.headline} a year instead of $240, and Business is ${MANAGER_PLAN_TIERS[2]!.annual.headline} instead of $2,400. Included communication credit is the same on annual plans.`,
  },
];

function Check() {
  return (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4 shrink-0 text-primary" aria-hidden>
      <path d="M4 10.5l3.5 3.5L16 5.5" />
    </svg>
  );
}

function Dash() {
  return <span aria-hidden className="inline-block h-[2px] w-3 shrink-0 rounded bg-border" />;
}

function PlanCard({ tier, annual }: { tier: ManagerPlanTierDefinition; annual: boolean }) {
  const featured = tier.id === "pro";
  const price = annual ? tier.annual : tier.monthly;
  const cta = TIER_CTA[tier.id];
  const includes = tierIncludes(tier.id);
  const headline = tier.id === "free" ? "$0" : price.headline;
  const period = tier.id === "free" ? null : annual ? "/yr" : "/mo";
  return (
    <div
      className={cn(
        "relative flex flex-col rounded-2xl border bg-card p-6",
        featured ? "border-primary/40 ring-[3px] ring-primary/10" : "border-border",
      )}
      data-attr={`pricing-plan-${tier.id}`}
    >
      {featured ? (
        <span className="absolute -top-3 left-6 rounded-full bg-primary px-3 py-1 text-[11px] font-bold uppercase tracking-[0.07em] text-white">
          Most popular
        </span>
      ) : null}
      <p className="text-[13px] font-bold uppercase tracking-[0.07em] text-muted">{tier.label}</p>
      <p className="mt-1.5 min-h-[40px] text-[13.5px] leading-snug text-muted">{TIER_TAGLINE[tier.id]}</p>
      <p className="mt-4 flex items-end gap-1">
        <span className="text-[42px] font-bold leading-none tracking-[-0.03em] text-foreground">{headline}</span>
        {period ? <span className="pb-1 text-[14px] text-muted">{period}</span> : null}
      </p>
      <p className="mt-1.5 text-[12.5px] text-muted">
        {tier.id === "free" ? "forever · no card" : annual ? "billed yearly · two months free" : "billed monthly"}
      </p>
      <Link
        href={cta.href}
        data-attr={`pricing-plan-${tier.id}-cta`}
        className={cn("mt-5 w-full", featured ? SITE_BTN_PRIMARY : SITE_BTN_SECONDARY)}
      >
        {cta.label}
      </Link>
      <p className="mt-6 text-[11.5px] font-bold uppercase tracking-[0.08em] text-muted">{includes.heading}</p>
      <ul className="mt-3 flex flex-col gap-2.5">
        {includes.items.map((f) => (
          <li key={f.text} className="flex items-start gap-2.5 text-[13.5px] leading-snug">
            <span className="mt-[3px] grid h-4 w-4 place-items-center">{f.included ? <Check /> : <Dash />}</span>
            <span className={f.included ? "text-foreground" : "text-muted/70"}>{f.text}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/* ───────────────────── comparison table ───────────────────── */

type Cell = boolean | string;
const YES = true;
const NO = false;

const COMPARE: { group: string; rows: { label: string; cells: [Cell, Cell, Cell] }[] }[] = [
  {
    group: "Homes & team",
    rows: [
      { label: "Property listings", cells: [String(FREE_MAX_PROPERTIES), String(PRO_MAX_PROPERTIES), String(BUSINESS_MAX_PROPERTIES)] },
      { label: "Co-managers", cells: [NO, "2", "20"] },
      { label: "Per-module access for co-managers", cells: [NO, YES, YES] },
    ],
  },
  {
    group: "Leasing",
    rows: [
      { label: "Public listing, apply link, tours", cells: [YES, YES, YES] },
      { label: "Applications", cells: [YES, YES, YES] },
      { label: "Residents & services", cells: [NO, YES, YES] },
      { label: "Lease drafted from the application, e-sign", cells: [NO, YES, YES] },
    ],
  },
  {
    group: "Money",
    rows: [
      { label: "Rent by card, bank or Zelle", cells: [YES, YES, YES] },
      { label: "Ledger & reports", cells: [YES, YES, YES] },
      { label: "Who pays processing fees", cells: ["Resident", "Resident or manager", "Resident or manager"] },
    ],
  },
  {
    group: "Communication",
    rows: [
      { label: "Dedicated work number & texting", cells: [YES, YES, YES] },
      {
        label: "Included credit / month",
        cells: [
          formatUsdFromCents(COMMS_INCLUDED_ALLOWANCE_CENTS.free!),
          formatUsdFromCents(COMMS_INCLUDED_ALLOWANCE_CENTS.pro!),
          formatUsdFromCents(COMMS_INCLUDED_ALLOWANCE_CENTS.business!),
        ],
      },
      { label: "AI assistant", cells: [YES, YES, YES] },
      { label: "AI drafts in the inbox", cells: [NO, YES, YES] },
    ],
  },
  {
    group: "Support",
    rows: [{ label: "Priority admin support", cells: [NO, NO, YES] }],
  },
];

function CellValue({ value }: { value: Cell }) {
  if (value === true) return <Check />;
  if (value === false) return <Dash />;
  return <span className="text-[13.5px] font-semibold text-foreground">{value}</span>;
}

function CompareTable() {
  return (
    <details className="group mt-10 rounded-2xl border border-border bg-card" data-attr="pricing-compare">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-4 px-5 py-4 text-[15.5px] font-bold text-foreground sm:px-6 [&::-webkit-details-marker]:hidden">
        Compare every feature
        <span aria-hidden className="grid h-7 w-7 shrink-0 place-items-center rounded-full border border-border text-muted transition-transform group-open:rotate-180">
          ▾
        </span>
      </summary>
      <div className="overflow-x-auto border-t border-border px-2 pb-4 sm:px-4">
        <table className="w-full min-w-[560px] border-collapse text-left">
          <thead>
            <tr className="text-[12px] font-bold uppercase tracking-[0.07em] text-muted">
              <th scope="col" className="w-[44%] px-3 py-3" />
              {MANAGER_PLAN_TIERS.map((t) => (
                <th key={t.id} scope="col" className="px-3 py-3">
                  {t.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {COMPARE.map((g) => (
              <Group key={g.group} title={g.group}>
                {g.rows.map((r) => (
                  <tr key={r.label} className="border-t border-border/60">
                    <th scope="row" className="px-3 py-2.5 text-[13.5px] font-medium text-foreground">
                      {r.label}
                    </th>
                    {r.cells.map((c, i) => (
                      <td key={i} className="px-3 py-2.5">
                        <CellValue value={c} />
                      </td>
                    ))}
                  </tr>
                ))}
              </Group>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}

function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <>
      <tr>
        <th scope="colgroup" colSpan={4} className="px-3 pb-1.5 pt-5 text-[12px] font-bold uppercase tracking-[0.07em] text-primary">
          {title}
        </th>
      </tr>
      {children}
    </>
  );
}

function BillingToggle({ annual }: { annual: boolean }) {
  const pill = (on: boolean) =>
    cn(
      "inline-flex items-center gap-2 rounded-full px-4 py-2 text-[13.5px] font-bold transition-colors",
      on ? "bg-card text-foreground shadow-[var(--shadow-sm)]" : "text-muted hover:text-foreground",
    );
  return (
    <div className="inline-flex items-center gap-1 rounded-full border border-border bg-[var(--pl-surface-muted)] p-1 [html[data-theme=dark]_&]:bg-white/[0.04]">
      <Link href="/pricing" scroll={false} data-attr="pricing-billing-monthly" className={pill(!annual)}>
        Monthly
      </Link>
      <Link href="/pricing?billing=annual" scroll={false} data-attr="pricing-billing-annual" className={pill(annual)}>
        Annual
        <span className="rounded-full bg-[var(--status-confirmed-bg)] px-2 py-0.5 text-[11px] font-bold text-[var(--status-confirmed-fg)]">
          2 months free
        </span>
      </Link>
    </div>
  );
}

export default async function PricingPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const params = await searchParams;
  const annual = params.billing === "annual";
  const rates = COMMS_BILLING_RATES_CENTS;

  return (
    <div className="relative min-h-0 flex-1">
      <section className="border-b border-border/70 pb-12 pt-14 sm:pt-16 lg:pt-20" aria-labelledby="pricing-title">
        <div className={`${SITE_MEASURE} flex flex-col items-center text-center`}>
          <SiteHeading as="h1" id="pricing-title">
            Free for one home.
            <br />
            <span className="text-primary">Pay when the portfolio earns it.</span>
          </SiteHeading>
          <p className="mt-5 max-w-[48ch] text-[16.5px] leading-relaxed text-muted">
            No card to start. Pro and Business begin with a 14-day trial.
          </p>
          <div className="mt-8">
            <BillingToggle annual={annual} />
          </div>
        </div>
      </section>

      <section className="py-12 sm:py-14" aria-label="Plans">
        {/* Three plans stay side by side on a phone too (PRP-314): a snap scroller
            below md, a plain 3-column grid from md up. Stacking them meant only
            one plan was ever on screen, which defeats a comparison page. */}
        <div
          className={`${SITE_MEASURE} flex snap-x snap-mandatory gap-4 overflow-x-auto pb-3 pt-3 [&>*]:w-[84%] [&>*]:shrink-0 [&>*]:snap-center md:grid md:grid-cols-3 md:gap-5 md:overflow-visible md:pb-0 md:[&>*]:w-auto`}
          data-attr="pricing-plan-scroller"
        >
          {MANAGER_PLAN_TIERS.map((tier) => (
            <PlanCard key={tier.id} tier={tier} annual={annual} />
          ))}
        </div>
        <div className={SITE_MEASURE}>
          <CompareTable />
        </div>
      </section>

      <SiteSection ariaLabel="Credit and fees">
        <div className="grid gap-4 md:grid-cols-2">
          <div className="rounded-2xl border border-border bg-card p-6 sm:p-7">
            <h2 className="text-[18px] font-bold tracking-tight text-foreground">Texting, calling and AI use — what the credit covers</h2>
            <p className="mt-3 text-[14.5px] leading-relaxed text-muted">
              Every plan includes a monthly communication credit ({formatUsdFromCents(COMMS_INCLUDED_ALLOWANCE_CENTS.free!)} /{" "}
              {formatUsdFromCents(COMMS_INCLUDED_ALLOWANCE_CENTS.pro!)} / {formatUsdFromCents(COMMS_INCLUDED_ALLOWANCE_CENTS.business!)}).
              Outgoing texts cost {formatCentsRate(rates.sms_outbound_segment)} a segment, incoming{" "}
              {formatCentsRate(rates.sms_inbound_segment)}, calls {formatCentsRate(rates.voice_minute)} a minute, and an AI turn on
              your work number {formatCentsRate(rates.ai_agent_turn)}. Included credit resets monthly; credit you buy (
              {CREDIT_PACKS_TEXT}) carries forward. At zero, outgoing activity pauses — a saved card never authorizes a top-up on its
              own.
            </p>
          </div>
          <div className="rounded-2xl border border-border bg-card p-6 sm:p-7">
            <h2 className="text-[18px] font-bold tracking-tight text-foreground">Processing fees</h2>
            <p className="mt-3 text-[14.5px] leading-relaxed text-muted">
              No plan includes card or bank processing fees. Residents pay them by default. On Pro and Business a manager may choose
              to cover them instead; PropLane covers fees only for individually approved accounts.
            </p>
          </div>
        </div>
      </SiteSection>

      <SiteFaq items={FAQ} id="pricing-faq" />

      <SiteFinalCta
        title="Not sure which plan? Start free."
        lede="Upgrade when the second home arrives."
        primaryAttr="pricing-closing-start-free"
        secondaryAttr="pricing-closing-book-demo"
        primaryHref={TIER_CTA.free.href}
      />
    </div>
  );
}
