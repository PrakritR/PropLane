import type { Metadata } from "next";
import Link from "next/link";
import { MarketingCtaPair } from "@/components/marketing/marketing-cta";
import { MANAGER_PLAN_TIERS, type PlanTierId } from "@/data/manager-plan-tiers";
import { MANAGER_TIER_MONTHLY_USD } from "@/lib/manager-access";
import {
  MarketingHero,
  MarketingPageShell,
  MarketingSection,
} from "@/components/marketing/marketing-page-shell";

export const metadata: Metadata = {
  title: "For managers & landlords",
  description:
    "PropLane for property managers and landlords: AI drafts leases, rent work, and vendor outreach. You approve every write. Real double-entry books underneath.",
};

const CAPABILITIES = [
  {
    title: "Leasing that fills itself",
    body: "Public apply links, tour booking, AI lease drafts from applications, and e-sign, all in one queue.",
  },
  {
    title: "Rent without the chase",
    body: "Online payments, late fees, and reminders that draft first. You confirm before anything sends.",
  },
  {
    title: "Vendors who show up",
    body: "Services, bids, visits, and Connect payouts, all tracked from request to paid.",
  },
  {
    title: "Books that balance",
    body: "Charges and payments write through to a double-entry ledger. Trust deposits stay liability.",
  },
] as const;

const TIER_BLURBS: Record<PlanTierId, string> = {
  free: "1 listing · try the core flow",
  pro: "Residents, leases, inbox, co-managers",
  business: "Scale listings · no payment fees",
};

function tierMonthlyPrice(id: PlanTierId): string {
  const usd = MANAGER_TIER_MONTHLY_USD[id];
  return usd === 0 ? "$0" : `$${usd}/mo`;
}

export default function PartnerLandingPage() {
  return (
    <MarketingPageShell>
      <MarketingHero
        title="Run the portfolio. Approve the rest."
        subtitle="PropLane drafts leases, rent work, and vendor outreach, then hands you one queue. Free to start."
      >
        <MarketingCtaPair
          primaryLabel="Get started free"
          primaryAttr="partner-hero-get-started"
          secondaryAttr="partner-hero-book-demo"
        />
      </MarketingHero>

      <MarketingSection>
        <h2 className="lp-center max-w-[22ch]">Built for how managers and landlords actually work</h2>
        <p className="lp-section-lede lp-center">
          One account for leasing, rent, maintenance, inbox, and books — whether you self-manage or run a portfolio, on web and iOS.
        </p>
        <div className="lp-page-grid-2">
          {CAPABILITIES.map((item) => (
            <div key={item.title} className="lp-page-card lp-page-card-pad">
              <h3>{item.title}</h3>
              <p>{item.body}</p>
            </div>
          ))}
        </div>
      </MarketingSection>

      <MarketingSection>
        <div className="grid items-center gap-10 lg:grid-cols-2 lg:gap-16">
          <div>
            <p className="lp-page-kicker">Pricing</p>
            <h2 className="mt-2 max-w-[14ch]">Free, Pro, or Business</h2>
            <p className="lp-section-lede">
              Start at $0. Upgrade when the portfolio earns it. 14-day Pro trial, no card.
            </p>
            <div className="mt-6">
              <Link
                href="/pricing"
                data-attr="partner-see-pricing"
                className="lp-btn lp-btn-ghost"
              >
                See pricing →
              </Link>
            </div>
          </div>
          <div className="lp-page-card overflow-hidden">
            {MANAGER_PLAN_TIERS.map((tier, i) => (
              <div
                key={tier.id}
                className={`lp-page-card-pad flex items-baseline justify-between gap-4 ${i > 0 ? "border-t border-[var(--lp-line)]" : ""}`}
              >
                <div>
                  <h3>{tier.label}</h3>
                  <p>{TIER_BLURBS[tier.id]}</p>
                </div>
                <span className="shrink-0 text-[15px] font-semibold text-[var(--lp-ink)]">
                  {tierMonthlyPrice(tier.id)}
                </span>
              </div>
            ))}
          </div>
        </div>
      </MarketingSection>

    </MarketingPageShell>
  );
}
