import Link from "next/link";
import { MANAGER_PLAN_TIERS, type PlanTierId } from "@/data/manager-plan-tiers";
import { RATE_CARD, formatRateCardUsd } from "@/lib/billing/rate-card";
import { MANAGER_GET_STARTED_HREF } from "@/lib/marketing/public-contact";
import { SITE_BTN_PRIMARY, SITE_BTN_SECONDARY, SiteIntro, SiteSection } from "@/components/marketing/site/primitives";
import { cn } from "@/lib/utils";

/**
 * One line under each price - the reason to pick it, not the feature list.
 * Doors come from RATE_CARD, the one enforced source of truth (see its
 * doc comment): Free's hard cap is doors, and Pro/Business are uncapped on
 * listing count and co-managers, priced by door instead - never retype the
 * legacy `FREE_MAX_PROPERTIES`/`PRO_MAX_PROPERTIES`/`BUSINESS_MAX_PROPERTIES`
 * constants here, they are informational-only leftovers from before
 * per-door billing.
 */
const TIER_LINE: Record<PlanTierId, string> = {
  free: `${RATE_CARD.free.includedDoors} doors · no card`,
  pro: `${RATE_CARD.pro.includedDoors} doors included · residents, leases, inbox`,
  business: `${RATE_CARD.business.includedDoors} doors included · unlimited co-managers`,
};

const TIER_CTA: Record<PlanTierId, string> = {
  free: "Start free",
  pro: "Start 14-day trial",
  business: "Start 14-day trial",
};

/** Pricing, in one breath, with a door to the full page. Prices come from the tier table, never retyped. */
export function SitePricingTeaser() {
  return (
    <SiteSection id="pricing" ariaLabelledBy="site-pricing-title">
      <SiteIntro
        eyebrow="Pricing"
        id="site-pricing-title"
        title={`Free for one home. ${formatRateCardUsd(RATE_CARD.pro.floorMonthlyCents)}/mo for up to ${RATE_CARD.pro.includedDoors} doors. ${formatRateCardUsd(RATE_CARD.business.floorMonthlyCents)}/mo for up to ${RATE_CARD.business.includedDoors}.`}
        lede="No card to start."
        align="center"
      />
      <div className="grid gap-4 md:grid-cols-3">
        {MANAGER_PLAN_TIERS.map((tier) => {
          const featured = tier.id === "pro";
          const price = tier.monthly;
          return (
            <div
              key={tier.id}
              className={cn(
                "relative flex flex-col rounded-2xl border bg-card p-6",
                featured ? "border-primary/40 ring-[3px] ring-primary/10" : "border-border",
              )}
            >
              {featured ? (
                <span className="absolute -top-3 left-6 rounded-full bg-primary px-3 py-1 text-[11px] font-bold uppercase tracking-[0.07em] text-white">
                  Most popular
                </span>
              ) : null}
              <p className="text-[13px] font-bold uppercase tracking-[0.07em] text-muted">{tier.label}</p>
              <p className="mt-3 flex items-end gap-1">
                <span className="text-[40px] font-bold leading-none tracking-[-0.03em] text-foreground">
                  {tier.id === "free" ? "$0" : price.headline}
                </span>
                {price.period ? <span className="pb-1 text-[14px] text-muted">{price.period.replace(/\s+/g, "")}</span> : null}
              </p>
              <p className="mt-2 text-[13.5px] text-muted">{TIER_LINE[tier.id]}</p>
              <Link
                href={`${MANAGER_GET_STARTED_HREF}&tier=${tier.id}`}
                data-attr={`home-pricing-${tier.id}`}
                className={cn("mt-6 w-full", featured ? SITE_BTN_PRIMARY : SITE_BTN_SECONDARY)}
              >
                {TIER_CTA[tier.id]}
              </Link>
            </div>
          );
        })}
      </div>
      <p className="mt-8 text-center">
        <Link href="/pricing#compare" data-attr="home-pricing-compare" className="text-[15px] font-bold text-primary hover:underline">
          Compare every feature →
        </Link>
      </p>
    </SiteSection>
  );
}
