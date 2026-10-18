import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import { MANAGER_PLAN_TIERS } from "@/data/manager-plan-tiers";
import { PLAN_ADDONS, formatAddonPrice } from "@/lib/plan-addons";
import { RATE_CARD, formatRateCardUsd } from "@/lib/billing/rate-card";
import { COMMS_INCLUDED_ALLOWANCE_CENTS } from "@/lib/comms-billing/allowances";
import { COMMS_CREDIT_PACKS_CENTS } from "@/lib/comms-billing/credit-packs";
import { COMMS_BILLING_RATES_CENTS, formatCentsRate, formatUsdFromCents } from "@/lib/comms-billing/rates";
import { MANAGED_FAQ } from "@/lib/marketing/managed-service";
import { TrackOnMount } from "@/components/analytics/track-on-mount";
import { SiteFaq,type SiteFaqItem } from "@/components/marketing/site/faq";
import { SiteFinalCta } from "@/components/marketing/site/final-cta";
import { CellValue, COMPARE } from "@/components/marketing/site/pricing-compare-data";
import {
  SITE_BTN_PRIMARY,
  SITE_MEASURE,
  SitePageHero,
  SiteSection,
} from "@/components/marketing/site/primitives";
import { ManagedTalkSection, PricingTabs } from "@/components/marketing/site/managed-service-sections";
import { ServicePricingCard, SoftwarePricingCards, TIER_CTA } from "@/components/marketing/site/pricing-cards";
import { SitePage } from "@/components/marketing/site/site-page";
import "@/components/marketing/site/page-polish.css";
import { cn } from "@/lib/utils";

export const metadata: Metadata = {
  title: "Pricing",
  description: `PropLane pricing: free for ${RATE_CARD.free.includedDoors} residents, then Pro at ${formatRateCardUsd(RATE_CARD.pro.floorMonthlyCents)}/mo (${RATE_CARD.pro.includedDoors} residents included) or Business at ${formatRateCardUsd(RATE_CARD.business.floorMonthlyCents)}/mo (${RATE_CARD.business.includedDoors} residents included). 14-day trial, no card required. Or let us run your home for you with PropLane Managed.`,
};

const CREDIT_PACKS_TEXT = (() => {
  const packs = COMMS_CREDIT_PACKS_CENTS.map((cents) => `$${cents / 100}`);
  return `${packs[0]} to ${packs[packs.length - 1]}`;
})();

const FAQ: SiteFaqItem[] = [
  {
    q: "Is the free tier actually free?",
    a: `Yes. $0, no card, ${RATE_CARD.free.includedDoors} residents, applications, tours and rent collection, with the in-app inbox and email. A work number for texting and calls, and the monthly communication credit, start on a paid Pro plan.`,
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
    q: "Can I message residents during the trial?",
    a: "Not yet — Communication starts when the plan is paid (a promo-code plan counts). The trial unlocks every other Pro feature, but the inbox, work email, texting and the work number stay locked until you subscribe — anything sent to you is kept and appears there the moment you do. The Free plan keeps the in-app inbox and email.",
  },
  {
    q: "What if I need more than my plan includes?",
    a: "Add it one at a time from Settings → Billing & plan: an extra listing is $8/mo on Pro and $6/mo on Business, an extra work number $5/mo, an extra workspace $15/mo on Pro (up to three) or $30/mo on Business, and an extra co-manager seat $5/mo. Free upgrades to Pro instead.",
  },
  {
    q: "Can I change plans later?",
    a: "Upgrade or downgrade any time. Upgrading unlocks residents, leases and more co-managers right away.",
  },
  {
    q: "How does annual billing work?",
    a: `Paying for the year up front is two months free: Pro is ${MANAGER_PLAN_TIERS[1]!.annual.headline} a year instead of ${formatRateCardUsd(RATE_CARD.pro.floorMonthlyCents * 12)}, and Business is ${MANAGER_PLAN_TIERS[2]!.annual.headline} instead of ${formatRateCardUsd(RATE_CARD.business.floorMonthlyCents * 12)}. Included communication credit is the same on annual plans.`,
  },
];

/* ───────────────────── comparison table ─────────────────────
   COMPARE, Check, Dash, and CellValue now live in
   `pricing-compare-data.tsx`, shared with the home page teaser's
   condensed grid so the two surfaces can never list different features. */

function CompareTable() {
  return (
    <details id="compare" className="pricing-compare group mt-12 scroll-mt-24 rounded-3xl border border-border bg-card" data-attr="pricing-compare" open>
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

/**
 * C178: phone-only per-plan accordion, a deliberate reversal of PRP-314's
 * horizontal scroller — each plan expands to its own full feature list
 * instead of a table that scrolls sideways. Reads the SAME `COMPARE` rows as
 * `CompareTable`, just transposed to one plan's column per panel, so the two
 * renderings can never list different features. Pro (the featured tier)
 * opens by default; desktop is unchanged (`CompareTable`'s single table).
 */
function ComparePlanAccordion() {
  return (
    <div className="mt-10 flex flex-col gap-3" data-attr="pricing-compare-phone">
      {MANAGER_PLAN_TIERS.map((tier, i) => (
        <details
          key={tier.id}
          className="group overflow-hidden rounded-2xl border border-border bg-card"
          open={tier.id === "pro"}
          data-attr={`pricing-compare-phone-${tier.id}`}
        >
          <summary className="flex cursor-pointer list-none items-center justify-between gap-4 px-5 py-4 text-[14px] font-bold text-foreground [&::-webkit-details-marker]:hidden">
            {tier.label} — every feature
            <span
              aria-hidden
              className="grid h-7 w-7 shrink-0 place-items-center rounded-full border border-border text-muted transition-transform group-open:rotate-180"
            >
              ▾
            </span>
          </summary>
          <div className="border-t border-border px-5 pb-4">
            {COMPARE.map((g) => (
              <div key={g.group}>
                <p className="pt-3 text-[11px] font-bold uppercase tracking-[0.07em] text-primary">{g.group}</p>
                {g.rows.map((r) => (
                  <div
                    key={r.label}
                    className="flex items-center justify-between gap-3 border-t border-border/60 py-2 text-[13px]"
                  >
                    <span className="text-foreground">{r.label}</span>
                    <CellValue value={r.cells[i]!} />
                  </div>
                ))}
              </div>
            ))}
          </div>
        </details>
      ))}
    </div>
  );
}

/**
 * C178: a fixed bottom bar on phone so the CTA is always one tap away while
 * scrolling the plan cards or the comparison accordion, instead of scrolling
 * back to the top. `md:hidden` — desktop keeps its inline card CTAs only.
 */
function MobileStickyCta() {
  return (
    <div
      className="fixed inset-x-0 bottom-0 z-40 flex items-center gap-3 border-t border-border bg-card/95 px-4 py-2.5 backdrop-blur-md md:hidden [html[data-native]_&]:pb-[max(0.625rem,env(safe-area-inset-bottom))]"
      data-attr="pricing-sticky-cta"
    >
      <p className="flex-1 text-[12.5px] text-muted">Free for {RATE_CARD.free.includedDoors} residents, no card.</p>
      <Link href={TIER_CTA.free.href} data-attr="pricing-sticky-cta-link" className={cn(SITE_BTN_PRIMARY, "shrink-0")}>
        Get started
      </Link>
    </div>
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

/**
 * `/pricing?view=service`: the Managed service tab. The short version of
 * `/pricing/service` - the price card (what is included, how it works), the
 * form, and the questions - with a door to the long page.
 */
function ManagedServiceTab() {
  return (
    <SitePage>
      <TrackOnMount event="pricing_viewed" properties={{ billing: "service" }} />
      <SitePageHero
        id="pricing-title"
        wide
        eyebrow="Pricing"
        title={
          <>
            Prefer not to run it yourself?
            <span className="site-accent">We will run it for you.</span>
          </>
        }
        lede="PropLane Managed: our team manages your home using our own software. Tell us about the home and we will quote it."
        actions={<PricingTabs active="service" />}
      />
      <section className="py-10 sm:py-12" aria-label="PropLane Managed">
        <div className={SITE_MEASURE}>
          <ServicePricingCard />
        </div>
      </section>
      <ManagedTalkSection showFullPageLink />
      <SiteFaq items={[...MANAGED_FAQ]} id="managed-faq" />
    </SitePage>
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

  if (params.view === "service") return <ManagedServiceTab />;

  return (
    <SitePage className="pb-16 md:pb-0">
      <TrackOnMount event="pricing_viewed" properties={{ billing: annual ? "annual" : "monthly" }} />
      <SitePageHero
        id="pricing-title"
        wide
        title={
          <>
            Free for {RATE_CARD.free.includedDoors} residents.
            <span className="site-accent">Pay when the portfolio earns it.</span>
          </>
        }
        actions={
          <div className="flex flex-col items-center gap-4">
            <PricingTabs active="software" />
            <BillingToggle annual={annual} />
          </div>
        }
      />

      <section className="py-12 sm:py-14" aria-label="Plans">
        {/* C178 (captain-requested reversal of PRP-314's side-by-side snap
            scroller): phone stacks full-width cards in one column; md+ keeps
            the unchanged 3-column grid. */}
        <div className={SITE_MEASURE}>
          <SoftwarePricingCards annual={annual} />
        </div>
        <div className={SITE_MEASURE}>
          {/* C178: phone gets a per-plan accordion instead of the sideways-
              scrolling table; desktop's <CompareTable> is unchanged. */}
          <div className="md:hidden">
            <ComparePlanAccordion />
          </div>
          <div className="hidden md:block">
            <CompareTable />
          </div>
        </div>
      </section>
      <MobileStickyCta />

      <SiteSection ariaLabel="Managed service">
        <ServicePricingCard attrPrefix="pricing-software-service" showSteps={false} />
      </SiteSection>

      <SiteSection ariaLabel="Credit and fees">
        <div className="grid gap-4 md:grid-cols-2">
          <div className="rounded-3xl border border-border bg-card p-6 sm:p-8">
            <h2 className="text-[18px] font-bold tracking-tight text-foreground">Texting, calling and AI use — what the credit covers</h2>
            <p className="mt-3 text-[14.5px] leading-relaxed text-muted">
              Pro includes {formatUsdFromCents(COMMS_INCLUDED_ALLOWANCE_CENTS.pro!)} and Business{" "}
              {formatUsdFromCents(COMMS_INCLUDED_ALLOWANCE_CENTS.business!)} of communication credit a month; Free includes none.
              Outgoing texts cost {formatCentsRate(rates.sms_outbound_segment)} a segment, incoming{" "}
              {formatCentsRate(rates.sms_inbound_segment)}, calls {formatCentsRate(rates.voice_minute)} a minute, and an AI turn on
              your work number {formatCentsRate(rates.ai_agent_turn)}. Included credit resets monthly; credit you buy (
              {CREDIT_PACKS_TEXT}) carries forward. At zero, outgoing activity pauses — a saved card never authorizes a top-up on its
              own.
            </p>
          </div>
          <div className="rounded-3xl border border-border bg-card p-6 sm:p-8">
            <h2 className="text-[18px] font-bold tracking-tight text-foreground">Processing fees</h2>
            <p className="mt-3 text-[14.5px] leading-relaxed text-muted">
              No plan includes card or bank processing fees. Residents pay them by default. On Pro and Business a manager may choose
              to cover them instead; PropLane covers fees only for individually approved accounts.
            </p>
          </div>
        </div>
      </SiteSection>

      <SiteSection ariaLabel="Add-ons">
        <div className="rounded-3xl border border-border bg-card p-6 sm:p-8">
          <h2 className="text-[18px] font-bold tracking-tight text-foreground">Add-ons — a price for everything past the bundle</h2>
          <p className="mt-2 text-[14.5px] leading-relaxed text-muted">
            One at a time, from Settings → Billing & plan, billed with your subscription. Free upgrades to Pro instead.
          </p>
          <div className="pricing-addons mt-5">
            <table className="w-full text-[14px]">
              <thead>
                <tr className="text-left text-[12px] font-bold uppercase tracking-[0.08em] text-muted">
                  <th className="py-2 pr-4 font-bold">Add-on</th>
                  <th className="py-2 pr-4 font-bold">Pro</th>
                  <th className="py-2 pr-4 font-bold">Business</th>
                </tr>
              </thead>
              <tbody>
                {PLAN_ADDONS.map((a) => (
                  <tr key={a.id} className="border-t border-border/60">
                    <td className="py-2.5 pr-4">
                      <span className="font-semibold text-foreground">{a.label}</span>
                      <span className="block text-[12.5px] text-muted">{a.description}</span>
                    </td>
                    <td data-label="Pro" className="py-2.5 pr-4 tabular-nums text-foreground">
                      {formatAddonPrice(a.monthlyCents.pro)}/mo{a.maxQuantity.pro !== null ? ` · up to ${a.maxQuantity.pro}` : ""}
                    </td>
                    <td data-label="Business" className="py-2.5 pr-4 tabular-nums text-foreground">{formatAddonPrice(a.monthlyCents.business)}/mo</td>
                  </tr>
                ))}
                <tr className="border-t border-border/60">
                  <td className="py-2.5 pr-4">
                    <span className="font-semibold text-foreground">Communication credit packs</span>
                    <span className="block text-[12.5px] text-muted">Carry forward; spent after included credit.</span>
                  </td>
                  <td data-label="Pro" className="py-2.5 pr-4 tabular-nums text-foreground">{CREDIT_PACKS_TEXT}</td>
                  <td data-label="Business" className="py-2.5 pr-4 tabular-nums text-foreground">{CREDIT_PACKS_TEXT}</td>
                </tr>
              </tbody>
            </table>
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
    </SitePage>
  );
}
