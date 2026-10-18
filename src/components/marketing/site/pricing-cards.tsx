import Link from "next/link";
import {
  MANAGER_PLAN_TIERS,
  managerPlanFeatureSummary,
  type ManagerPlanTierDefinition,
  type PlanTierId,
} from "@/data/manager-plan-tiers";
import { RATE_CARD, formatRateCardUsd } from "@/lib/billing/rate-card";
import { MANAGER_GET_STARTED_HREF } from "@/lib/marketing/public-contact";
import {
  MANAGED_CONTACT_HREF,
  MANAGED_INCLUDES,
  MANAGED_PRICE_HEADLINE,
  MANAGED_PRICE_NOTE,
  MANAGED_SERVICE_HREF,
  MANAGED_STEPS,
} from "@/lib/marketing/managed-service";
import { Check, Dash } from "@/components/marketing/site/pricing-compare-data";
import {
  SITE_BTN_PRIMARY,
  SITE_BTN_SECONDARY,
} from "@/components/marketing/site/primitives";
import { cn } from "@/lib/utils";

/**
 * The shared pricing cards: `/pricing`, `/pricing/service` and the
 * home page's pricing band all import from here, so the plans and the managed
 * service can never be listed differently on two surfaces. Every dollar figure
 * is read from `RATE_CARD`; the managed service has no price until the captain
 * gives one (`MANAGED_PRICE_HEADLINE`).
 */

const CTA_BASE = MANAGER_GET_STARTED_HREF;

export const TIER_CTA: Record<PlanTierId, { href: string; label: string }> = {
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

/** All feature copy comes from the canonical advertised plan definitions. */
export function tierIncludes(id: PlanTierId) {
  const tier = MANAGER_PLAN_TIERS.find((plan) => plan.id === id)!;
  return {
    heading:
      id === "free"
        ? "What’s included"
        : id === "pro"
          ? "Everything in Free, plus"
          : "Everything in Pro, plus",
    items: tier.features,
  };
}

export function PlanCard({
  tier,
  annual,
  compact = false,
}: {
  tier: ManagerPlanTierDefinition;
  annual: boolean;
  compact?: boolean;
}) {
  const featured = tier.id === "pro";
  const price = annual ? tier.annual : tier.monthly;
  const cta = TIER_CTA[tier.id];
  const includes = tierIncludes(tier.id);
  const headline =
    tier.id === "free"
      ? formatRateCardUsd(RATE_CARD.free.floorMonthlyCents)
      : price.headline;
  const period = tier.id === "free" ? null : annual ? "/yr" : "/mo";
  if (compact)
    return (
      <article
        className={cn(
          "pl-pricing-card pl-pricing-compact",
          featured && "pl-pricing-featured",
        )}
        aria-label={tier.label}
        data-attr={`pricing-plan-${tier.id}`}
      >
        <span className="pl-pricing-index" aria-hidden="true">
          {String(
            MANAGER_PLAN_TIERS.findIndex((plan) => plan.id === tier.id) + 1,
          ).padStart(2, "0")}
        </span>
        <h3>{tier.label}</h3>
        <p className="pl-pricing-includes-heading">{includes.heading}</p>
        <ul className="pl-pricing-short-list">
          {managerPlanFeatureSummary(tier).map((item) => (
            <li key={item.text}>
              <Check />
              <span>{item.text}</span>
            </li>
          ))}
        </ul>
        <p className="pl-pricing-price">
          <strong>{headline}</strong>
          {period && <span>{period}</span>}
        </p>
        <p className="pl-pricing-billing">
          {tier.id === "free"
            ? "No card required"
            : annual
              ? "Billed yearly"
              : "Billed monthly"}
        </p>
        <Link
          href={cta.href}
          data-attr={`pricing-plan-${tier.id}-cta`}
          className="pl-pricing-cta"
        >
          {cta.label}
        </Link>
      </article>
    );
  return (
    <article
      aria-label={tier.label}
      className={cn(
        "pricing-card relative flex flex-col rounded-3xl border bg-card p-6 sm:p-7",
        featured
          ? "pricing-card-featured border-foreground border-2"
          : "border-border",
      )}
      data-attr={`pricing-plan-${tier.id}`}
    >
      <h3 className="text-[13px] font-bold uppercase tracking-[0.07em] text-muted">
        {tier.label}
      </h3>
      <p className="mt-2 min-h-[40px] text-[14px] leading-snug text-muted">
        {TIER_TAGLINE[tier.id]}
      </p>
      <p className="mt-5 flex items-end gap-1.5">
        <span className="site-display text-[52px] font-bold leading-none tracking-[-0.04em] text-foreground">
          {headline}
        </span>
        {period ? (
          <span className="pb-1 text-[14px] text-muted">{period}</span>
        ) : null}
      </p>
      <p className="mt-1.5 text-[12.5px] text-muted">
        {tier.id === "free"
          ? "forever · no card"
          : annual
            ? "billed yearly · two months free"
            : "billed monthly"}
      </p>
      <Link
        href={cta.href}
        data-attr={`pricing-plan-${tier.id}-cta`}
        className={cn(
          "mt-6 w-full",
          featured ? SITE_BTN_PRIMARY : SITE_BTN_SECONDARY,
        )}
      >
        {cta.label}
      </Link>
      <p className="mt-7 border-t border-border/70 pt-6 text-[12px] font-bold uppercase tracking-[0.08em] text-foreground">
        {includes.heading}
      </p>
      <ul className="mt-4 flex flex-col gap-3">
        {includes.items.map((f) => (
          <li
            key={f.text}
            className="flex items-start gap-2.5 text-[13.5px] leading-snug"
          >
            <span className="mt-[2px] grid h-[18px] w-[18px] shrink-0 place-items-center">
              {f.included ? <Check /> : <Dash />}
            </span>
            <span className={f.included ? "text-foreground" : "text-muted/70"}>
              {f.text}
            </span>
          </li>
        ))}
      </ul>
    </article>
  );
}

/**
 * PropLane Managed as a price card: the same shape as a plan (name, price,
 * what is included, one button) so an owner can compare "run it myself" and
 * "run it for me" side by side. The price is "Custom" until the captain sets one.
 */
export function ServicePricingCard({
  className,
  attrPrefix = "pricing-service",
  showSteps = true,
}: {
  className?: string;
  attrPrefix?: string;
  showSteps?: boolean;
}) {
  return (
    <div
      className={cn(
        "relative grid gap-8 overflow-hidden rounded-3xl border border-primary/40 bg-card p-6 sm:p-8 lg:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)] lg:gap-12 lg:p-10",
        className,
      )}
      data-attr={attrPrefix}
    >
      <div className="flex flex-col">
        <p className="text-[13px] font-bold uppercase tracking-[0.07em] text-muted">
          Managed service
        </p>
        <p className="mt-2 text-[14px] leading-snug text-muted">
          We run your home on PropLane, so you do not have to.
        </p>
        <p className="mt-5 flex items-end gap-1.5">
          <span className="site-display text-[52px] font-bold leading-none tracking-[-0.04em] text-foreground">
            {MANAGED_PRICE_HEADLINE}
          </span>
        </p>
        <p className="mt-1.5 text-[12.5px] text-muted">{MANAGED_PRICE_NOTE}</p>
        <div className="mt-6 flex flex-wrap gap-3">
          <Link
            href={MANAGED_CONTACT_HREF}
            data-attr={`${attrPrefix}-talk`}
            className={SITE_BTN_PRIMARY}
          >
            Talk to us
          </Link>
          <Link
            href={MANAGED_SERVICE_HREF}
            data-attr={`${attrPrefix}-details`}
            className={SITE_BTN_SECONDARY}
          >
            See how it works
          </Link>
        </div>
        {showSteps ? (
          <ol className="mt-8 space-y-3 border-t border-border/70 pt-6">
            {MANAGED_STEPS.map((s, i) => (
              <li
                key={s.id}
                className="flex items-start gap-3 text-[13.5px] leading-snug"
              >
                <span className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-primary/10 text-[12px] font-bold text-primary">
                  {i + 1}
                </span>
                <span>
                  <span className="font-bold text-foreground">{s.title}.</span>{" "}
                  <span className="text-muted">{s.copy}</span>
                </span>
              </li>
            ))}
          </ol>
        ) : null}
      </div>
      <div>
        <p className="text-[12px] font-bold uppercase tracking-[0.08em] text-foreground">
          What is included
        </p>
        <ul className="mt-4 flex flex-col gap-3.5">
          {MANAGED_INCLUDES.map((f) => (
            <li
              key={f.id}
              className="flex items-start gap-2.5 text-[14px] leading-snug"
            >
              <span className="mt-[2px] grid h-[18px] w-[18px] shrink-0 place-items-center">
                <Check />
              </span>
              <span>
                <span className="font-semibold text-foreground">
                  {f.title}.
                </span>{" "}
                <span className="text-muted">{f.copy}</span>
              </span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

/** A fourth plan in the same comparison row; the full service detail card above stays on /pricing/service. */
function ManagedPlanCard({ compact }: { compact: boolean }) {
  return (
    <article
      className={cn(
        "pl-pricing-card pl-pricing-managed",
        compact && "pl-pricing-compact",
      )}
      aria-label="We manage it for you"
      data-attr="pricing-plan-managed"
    >
      {compact && (
        <span className="pl-pricing-index" aria-hidden="true">
          04
        </span>
      )}
      <h3>We manage it for you</h3>
      <p className="pl-pricing-price">
        <strong>{MANAGED_PRICE_HEADLINE}</strong>
      </p>
      <p className="pl-pricing-billing">
        {compact ? "Quoted for your home" : MANAGED_PRICE_NOTE}
      </p>
      <p className="pl-pricing-includes-heading">Our team takes care of</p>
      <ul className="pl-pricing-short-list">
        {MANAGED_INCLUDES.map((item) => (
          <li key={item.id}>
            <Check />
            <span>{item.title}</span>
          </li>
        ))}
      </ul>
      <Link
        href={MANAGED_CONTACT_HREF}
        prefetch={false}
        className="pl-pricing-cta"
        data-attr="pricing-plan-managed-cta"
      >
        Talk to us
      </Link>
    </article>
  );
}

/** Four choices are always visible in the same row; billing changes only software prices. */
export function PricingCards({
  annual = false,
  variant = "full",
}: {
  annual?: boolean;
  variant?: "full" | "overview";
}) {
  const compact = variant === "overview";
  return (
    <div
      className={cn("pl-pricing-options", compact && "pl-pricing-overview")}
      role="region"
      aria-label="Pricing options"
      data-attr="pricing-plan-stack"
    >
      {MANAGER_PLAN_TIERS.map((tier) => (
        <PlanCard key={tier.id} tier={tier} annual={annual} compact={compact} />
      ))}
      <ManagedPlanCard compact={compact} />
    </div>
  );
}
