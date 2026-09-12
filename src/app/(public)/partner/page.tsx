import type { Metadata } from "next";
import Link from "next/link";
import { MANAGER_PLAN_TIERS, type PlanTierId } from "@/data/manager-plan-tiers";
import { MANAGER_TIER_MONTHLY_USD } from "@/lib/manager-access";
import { MANAGER_GET_STARTED_HREF } from "@/lib/marketing/public-contact";
import { SiteFeatureRows, type SiteFeatureRow } from "@/components/marketing/site/feature-rows";
import { SiteFinalCta } from "@/components/marketing/site/final-cta";
import {
  MockApproveRow,
  MockChip,
  MockDraft,
  MockFrame,
  MockRow,
  SITE_MEASURE,
  SiteCtaPair,
  SiteEyebrow,
  SiteHeading,
  SiteIntro,
  SiteSection,
} from "@/components/marketing/site/primitives";

export const metadata: Metadata = {
  title: "For managers & landlords",
  description:
    "PropLane for property managers and landlords: list, screen, lease and collect from one queue on web and iPhone — and nothing goes out without your OK.",
};

/*
 * The buyer page. It repeats the promise, then earns it with four rows — each
 * a real screen — and closes with pricing and both doors. Built for how
 * managers and landlords actually work: the same buyer, whether they
 * self-manage three homes or run twenty with a team.
 */
const ROWS: SiteFeatureRow[] = [
  {
    eyebrow: "Leasing",
    title: "From listing to signed lease without a PDF",
    body: "Four answers make a listing. Tours book themselves. The application becomes the lease draft; you read it, tweak a clause, both of you sign online.",
    mock: (
      <MockFrame title="Applications · Pending" aside={<MockChip tone="bad">2</MockChip>}>
        <div className="divide-y divide-border/60">
          <MockRow name="Maya Chen" title="Maya Chen" sub="Cascade Lofts · 4B · screening clear" right={<MockChip tone="info">Approve</MockChip>} />
          <MockRow name="Dev Ramos" title="Dev Ramos" sub="Ballard Commons · 1C" right={<MockChip>New</MockChip>} />
        </div>
      </MockFrame>
    ),
  },
  {
    eyebrow: "Rent",
    title: "Rent that collects itself",
    body: "Card, bank or Zelle. Reminders and late fees draft first and send on your approval. Deposits stay liability; the ledger balances.",
    mock: (
      <MockFrame title="Payments · Incoming">
        <div className="divide-y divide-border/60">
          <MockRow name="Jordan Lee" title="Jordan Lee · Sep rent" sub="$1,240 · 3 days late" right={<span className="flex items-center gap-2"><MockChip tone="bad">Overdue</MockChip><MockChip tone="info">Remind</MockChip></span>} />
          <MockRow name="Priya Nair" title="Priya Nair · Sep rent" sub="$1,160 · paid by bank" right={<MockChip tone="good">Paid</MockChip>} />
        </div>
      </MockFrame>
    ),
  },
  {
    eyebrow: "Inbox & work number",
    title: "One inbox, one number, drafts waiting",
    body: "Residents text your PropLane number, applicants email, vendors reply — one thread each, with a drafted answer you approve, edit or discard.",
    mock: (
      <MockFrame title="Inbox · Dana Reyes" aside={<MockChip tone="warn">Draft</MockChip>}>
        <MockDraft>&ldquo;Thanks Dana — Pacific Plumbing is booked Thursday 10–12.&rdquo;</MockDraft>
        <div className="mt-3">
          <MockApproveRow />
        </div>
      </MockFrame>
    ),
  },
  {
    eyebrow: "Team",
    title: "Co-managers with exactly the access you give",
    body: "Invite by link. Per module — Properties, Leasing, Payments, Services, Inbox — No access · View · Edit · Manage. Property-scoped vendors.",
    mock: (
      <MockFrame title="Settings · Team">
        <div className="divide-y divide-border/60">
          <MockRow name="Test Manager" title="Test Manager" sub="Owner · all houses" right={<MockChip>Owner</MockChip>} />
          <MockRow name="Sofia Diaz" title="Sofia Diaz" sub="3 houses · Payments: View · Inbox: Manage" right={<MockChip tone="info">Access</MockChip>} />
        </div>
      </MockFrame>
    ),
  },
];

function tierMonthlyPrice(id: PlanTierId): string {
  const usd = MANAGER_TIER_MONTHLY_USD[id];
  return usd === 0 ? "$0" : `$${usd}/mo`;
}

export default function PartnerLandingPage() {
  return (
    <div className="relative min-h-0 flex-1">
      <section className="border-b border-border/70 pb-14 pt-14 sm:pt-16 lg:pb-20 lg:pt-20" aria-labelledby="partner-title">
        <div className={`${SITE_MEASURE} max-w-[860px]`}>
          <SiteEyebrow className="mb-4">For managers &amp; landlords</SiteEyebrow>
          <SiteHeading as="h1" id="partner-title">
            Run the portfolio.
            <br />
            <span className="text-primary">Approve the rest.</span>
          </SiteHeading>
          <p className="mt-5 max-w-[52ch] text-[16.5px] leading-relaxed text-muted sm:text-[17.5px]">
            PropLane drafts leases, rent work and vendor outreach for property managers and landlords, then hands you one
            queue on web and iPhone. Self-manage three homes or run twenty with a team — nothing goes out without your OK.
          </p>
          <SiteCtaPair
            className="mt-8"
            primaryHref={MANAGER_GET_STARTED_HREF}
            primaryLabel="Get started free"
            primaryAttr="partner-hero-get-started"
            secondaryAttr="partner-hero-book-demo"
            note="Free for one home · no card · 14-day Pro trial"
          />
        </div>
      </section>

      <SiteSection ariaLabelledBy="partner-rows-title">
        <SiteIntro
          id="partner-rows-title"
          title="Built for how managers and landlords actually work"
          lede="One account for leasing, rent, maintenance, inbox and books — every screen below is the product."
        />
        <SiteFeatureRows rows={ROWS} />
      </SiteSection>

      <SiteSection tone="muted" ariaLabelledBy="partner-pricing-title">
        <div className="grid items-center gap-10 lg:grid-cols-2 lg:gap-16">
          <div>
            <SiteEyebrow className="mb-3">Pricing</SiteEyebrow>
            <SiteHeading id="partner-pricing-title">Free for one home.</SiteHeading>
            <p className="mt-4 max-w-[44ch] text-[16px] leading-relaxed text-muted">
              Start at $0. Upgrade when the portfolio earns it. Pro and Business begin with a 14-day trial, no card.
            </p>
            <Link href="/pricing" data-attr="partner-see-pricing" className="mt-6 inline-flex items-center gap-1.5 text-[15px] font-bold text-primary hover:underline">
              See pricing <span aria-hidden>→</span>
            </Link>
          </div>
          <div className="divide-y divide-border rounded-2xl border border-border bg-card">
            {MANAGER_PLAN_TIERS.map((tier) => (
              <div key={tier.id} className="flex items-center justify-between gap-4 px-5 py-4">
                <span className="flex items-center gap-2.5">
                  <b className="text-[15px] font-bold text-foreground">{tier.label}</b>
                  {tier.id === "pro" ? <MockChip tone="info">Most popular</MockChip> : null}
                </span>
                <span className="text-[16px] font-bold tabular-nums text-foreground">{tierMonthlyPrice(tier.id)}</span>
              </div>
            ))}
          </div>
        </div>
      </SiteSection>

      <SiteFinalCta
        title="Bring one home. See the first approval land."
        lede="List it in four answers; the first drafts are in your queue in about ten minutes."
        primaryHref={MANAGER_GET_STARTED_HREF}
        primaryLabel="Start free"
        primaryAttr="partner-closing-get-started"
        secondaryAttr="partner-closing-book-demo"
      />
    </div>
  );
}
