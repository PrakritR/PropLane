import type { Metadata } from "next";
import Link from "next/link";
import {
  MANAGER_PLAN_TIERS,
  type ManagerPlanTierDefinition,
} from "@/data/manager-plan-tiers";
import {
  MarketingHero,
  MarketingPageShell,
  MarketingSection,
} from "@/components/marketing/marketing-page-shell";
import { MANAGER_GET_STARTED_HREF } from "@/lib/marketing/public-contact";

export const metadata: Metadata = {
  title: "Pricing",
  description:
    "PropLane pricing: start free, then Pro at $20/mo or Business at $200/mo. 14-day trial, no card required, and a live demo with no signup.",
};

const CTA_BASE = MANAGER_GET_STARTED_HREF;

const TIER_CTA: Record<
  ManagerPlanTierDefinition["id"],
  { href: string; label: string; solid: boolean }
> = {
  free: { href: `${CTA_BASE}&tier=free`, label: "Get started free", solid: false },
  pro: { href: `${CTA_BASE}&tier=pro`, label: "Start 14-day trial", solid: true },
  business: { href: `${CTA_BASE}&tier=business`, label: "Start 14-day trial", solid: false },
};

const FAQ: { q: string; a: string }[] = [
  {
    q: "Is the free tier actually free?",
    a: "Yes. Free is $0 with no card. You get one property listing, applications and tour scheduling, and payment collection. Residents, leases, services, inbox, and co-managers live on Pro and up.",
  },
  {
    q: "Do I need a credit card to try Pro or Business?",
    a: "No. The 14-day trial needs no card. You only add payment details if you decide to keep a paid plan after the trial.",
  },
  {
    q: "How does annual billing save about 20%?",
    a: "Paying for the year up front is roughly two months free: Pro is $192/yr instead of $240, and Business is $1,920/yr instead of $2,400.",
  },
  {
    q: "Can I change plans later?",
    a: "Yes. Upgrade or downgrade anytime. Upgrading unlocks residents, leases, the inbox, and more co-managers right away. Every tier is the same on payments: residents pay face value, you receive it in full, and PropLane covers payment processing.",
  },
];

function pillClass(active: boolean): string {
  return active
    ? "relative inline-flex items-center gap-2 rounded-full bg-[var(--lp-surface-2)] px-4 py-1.5 text-[13px] font-medium text-[var(--lp-ink)] shadow-[inset_0_0_0_1px_var(--lp-line)]"
    : "relative inline-flex items-center gap-2 rounded-full px-4 py-1.5 text-[13px] font-medium text-[var(--lp-muted)] transition-colors hover:text-[var(--lp-ink)]";
}

function CheckIcon() {
  return (
    <svg
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="h-[15px] w-[15px] shrink-0 text-[var(--lp-blue)]"
      aria-hidden
    >
      <path d="M4 10.5l3.5 3.5L16 5.5" />
    </svg>
  );
}

function DashIcon() {
  return (
    <svg
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      className="h-[15px] w-[15px] shrink-0 text-[color-mix(in_srgb,var(--lp-muted)_55%,transparent)]"
      aria-hidden
    >
      <path d="M5 10h10" />
    </svg>
  );
}

function PlanCard({
  tier,
  annual,
}: {
  tier: ManagerPlanTierDefinition;
  annual: boolean;
}) {
  const featured = tier.id === "pro";
  const price = annual ? tier.annual : tier.monthly;
  const cta = TIER_CTA[tier.id];

  return (
    <div
      className={
        "lp-page-card relative flex flex-col p-6 " +
        (featured
          ? "border-[color-mix(in_srgb,var(--lp-blue)_40%,transparent)] bg-[color-mix(in_srgb,var(--lp-blue)_5%,var(--lp-card))]"
          : "")
      }
    >
      {featured ? (
        <span className="absolute -top-3 left-6 inline-flex items-center gap-1.5 rounded-full border border-[color-mix(in_srgb,var(--lp-blue)_40%,transparent)] bg-[var(--lp-surface-2)] px-3 py-1 text-[11px] font-medium uppercase tracking-[0.07em] text-[var(--lp-blue)]">
          <span className="h-1.5 w-1.5 rounded-full bg-[var(--lp-blue)]" />
          Popular
        </span>
      ) : null}

      <div className="text-[13px] font-medium uppercase tracking-[0.07em] text-[var(--lp-muted)]">
        {tier.label}
      </div>

      <div className="mt-4 flex items-end gap-1.5">
        <span className="text-[2.6rem] font-semibold leading-none tracking-[-0.03em] text-[var(--lp-ink)]">
          {price.headline}
        </span>
        {price.period ? (
          <span className="pb-1 text-[14px] text-[var(--lp-muted)]">{price.period}</span>
        ) : null}
      </div>
      <div className="mt-1.5 h-4 text-[12px] text-[color-mix(in_srgb,var(--lp-muted)_70%,transparent)]">
        {price.period ? (annual ? "billed annually" : "billed monthly") : "no card required"}
      </div>

      <p className="mt-4 min-h-[60px] text-[13.5px] leading-relaxed text-[var(--lp-muted)]">
        {price.sub}
      </p>

      <Link
        href={cta.href}
        data-attr={`pricing-plan-${tier.id}-cta`}
        className={
          "mt-5 " +
          (cta.solid ? "lp-btn lp-btn-blue w-full" : "lp-btn lp-btn-ghost w-full")
        }
      >
        {cta.label}
      </Link>

      <div className="mt-6 h-px w-full bg-[var(--lp-line)]" />

      <ul className="mt-5 flex flex-col gap-3">
        {tier.features.map((feature) => (
          <li key={feature.text} className="flex items-start gap-2.5">
            {feature.included ? <CheckIcon /> : <DashIcon />}
            <span
              className={
                "text-[13.5px] leading-snug " +
                (feature.included
                  ? "text-[var(--lp-ink)]"
                  : "text-[color-mix(in_srgb,var(--lp-muted)_60%,transparent)]")
              }
            >
              {feature.text}
            </span>
          </li>
        ))}
      </ul>
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

  return (
    <MarketingPageShell>
      <MarketingHero
        title={
          <>
            Simple pricing.
            <br />
            <span className="text-[color-mix(in_srgb,var(--lp-muted)_75%,transparent)]">
              Free to start.
            </span>
          </>
        }
      >
        <p className="mt-4 text-[12.5px] text-[color-mix(in_srgb,var(--lp-muted)_75%,transparent)]">
          14-day trial · no card required · book a demo anytime
        </p>
        <div className="mt-8 inline-flex items-center gap-1 rounded-full border border-[var(--lp-line)] bg-[var(--lp-card)] p-1">
          <Link href="/pricing" scroll={false} data-attr="pricing-billing-monthly" className={pillClass(!annual)}>
            Monthly
          </Link>
          <Link
            href="/pricing?billing=annual"
            scroll={false}
            data-attr="pricing-billing-annual"
            className={pillClass(annual)}
          >
            Annual
            <span className="rounded-full bg-[var(--status-confirmed-fg)]/10 px-2 py-0.5 text-[11px] font-medium text-[var(--status-confirmed-fg)]">
              Save 20%
            </span>
          </Link>
        </div>
      </MarketingHero>

      <section className="pb-4">
        <div className="lp-w-wide grid gap-5 md:grid-cols-3">
          {MANAGER_PLAN_TIERS.map((tier) => (
            <PlanCard key={tier.id} tier={tier} annual={annual} />
          ))}
        </div>
      </section>

      <MarketingSection narrow>
        <h2>Questions, answered</h2>
        <div className="lp-page-card mt-6 divide-y divide-[var(--lp-line)] overflow-hidden">
          {FAQ.map((item) => (
            <div key={item.q} className="px-6 py-5">
              <div className="text-[15px] font-medium tracking-[-0.01em] text-[var(--lp-ink)]">
                {item.q}
              </div>
              <p className="mt-2 text-[13.5px] leading-relaxed text-[var(--lp-muted)]">{item.a}</p>
            </div>
          ))}
        </div>
      </MarketingSection>

    </MarketingPageShell>
  );
}
