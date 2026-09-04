import type { Metadata } from "next";
import Link from "next/link";
import { MarketingCtaPair } from "@/components/marketing/marketing-cta";
import {
  MarketingHero,
  MarketingPageShell,
  MarketingSection,
} from "@/components/marketing/marketing-page-shell";
import { RESIDENT_BROWSE_PATH } from "@/lib/resident-public-nav";

export const metadata: Metadata = {
  title: "Why PropLane",
  description:
    "AI drafts leases, tours, messages, and rent work. You approve every write. One platform for managers, residents, and vendors with real double-entry books.",
};

const PILLARS = [
  {
    eyebrow: "Approval-first AI",
    title: "AI drafts. You approve.",
    body: "Chatbot and leasing SMS prepare the work. Leases, reminders, and vendor outreach never send without your OK.",
    points: [
      ["Leases from applications", "Terms filled from the applicant; e-sign when you release."],
      ["Automatic messages", "Rent, lease-ready, and visit updates draft first; you send."],
      ["Scheduled tours", "Prospects book from listings or text; slots land on your calendar."],
    ],
  },
  {
    eyebrow: "Three portals",
    title: "Managers, residents, vendors.",
    body: "Same product, scoped correctly. Everyone works in PropLane, not parallel inboxes.",
    points: [
      ["Managers", "Leasing, rent, services, inbox, finances, and AI approvals."],
      ["Residents", "Browse, apply, pay rent (ACH free), and message your manager."],
      ["Vendors", "Jobs, bids, visits, and payouts in one place."],
    ],
  },
  {
    eyebrow: "Real books",
    title: "Ledger, not a spreadsheet.",
    body: "Charges and payments write through to double-entry books your accountant can trust.",
    points: [
      ["Trial balance & GL", "Always balanced from the same source of truth."],
      ["Owner statements", "Per property, ready to send."],
      ["Deposit trust", "Security deposits book as liability, not income."],
    ],
  },
] as const;

const OLD_WAY = [
  "Retype applications into lease templates and chase signatures by email.",
  "Text tenants about rent and track paid/unpaid in a spreadsheet.",
  "Phone-tag contractors for one quote on one repair.",
  "Reconcile receipts every spring for something tax-ready.",
] as const;

const PROPLANE_WAY = [
  "AI drafts the lease from the application; you review, both sides e-sign.",
  "Rent collects on-platform via Stripe; reminders draft, you approve send.",
  "Services invite bids; approved work pays out through Connect.",
  "Double-entry posts itself: trial balance, trust, owner statements.",
] as const;

const PRICING_TIERS = [
  { name: "Free", price: "$0", cadence: "forever", detail: "1 listing · no payment fees" },
  { name: "Pro", price: "$20", cadence: "/mo", detail: "2 listings · no payment fees" },
  { name: "Business", price: "$200", cadence: "/mo", detail: "20 listings · no payment fees" },
] as const;

export default function WhyPropLanePage() {
  return (
    <MarketingPageShell>
      <MarketingHero
        title="Property ops that wait for your OK"
        subtitle="Tours. Texts. Rent. Approvals. One platform. AI drafts, you confirm."
      >
        <MarketingCtaPair
          primaryLabel="Get started free"
          primaryAttr="why-proplane-hero-get-started"
          secondaryHref="/pricing"
          secondaryLabel="See pricing"
          secondaryAttr="why-proplane-hero-pricing"
        />
      </MarketingHero>

      {PILLARS.map((pillar) => (
        <MarketingSection key={pillar.title}>
          <div className="grid items-start gap-10 lg:grid-cols-2 lg:gap-16">
            <div>
              <p className="lp-page-kicker">{pillar.eyebrow}</p>
              <h2 className="mt-2 max-w-[14ch]">{pillar.title}</h2>
              <p className="lp-section-lede">{pillar.body}</p>
            </div>
            <div className="lp-page-card overflow-hidden">
              {pillar.points.map(([label, copy], idx) => (
                <div
                  key={label}
                  className={`lp-page-card-pad ${idx > 0 ? "border-t border-[var(--lp-line)]" : ""}`}
                >
                  <h3>{label}</h3>
                  <p>{copy}</p>
                </div>
              ))}
            </div>
          </div>
        </MarketingSection>
      ))}

      <MarketingSection>
        <h2 className="text-center">Old way vs PropLane</h2>
        <div className="lp-page-grid-2">
          <div className="lp-page-card lp-page-card-pad">
            <h3 className="text-[var(--lp-muted)]">Old way</h3>
            <ul className="lp-page-list">
              {OLD_WAY.map((item) => (
                <li key={item}>
                  <span className="lp-mark lp-mark-muted" aria-hidden>
                    ✕
                  </span>
                  <span>{item}</span>
                </li>
              ))}
            </ul>
          </div>
          <div className="lp-page-card lp-page-card-pad border-[color-mix(in_srgb,var(--lp-blue)_28%,transparent)]">
            <h3>PropLane</h3>
            <ul className="lp-page-list">
              {PROPLANE_WAY.map((item) => (
                <li key={item}>
                  <span className="lp-mark" aria-hidden>
                    ✓
                  </span>
                  <span>{item}</span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </MarketingSection>

      <MarketingSection>
        <h2 className="text-center">Start where you fit</h2>
        <div className="lp-page-grid-3">
          {[
            {
              href: "/partner",
              title: "Managers & landlords",
              body: "Run the portfolio with AI approvals.",
              cta: "For managers & landlords",
              attr: "why-role-managers",
            },
            {
              href: RESIDENT_BROWSE_PATH,
              title: "Residents",
              body: "Browse, apply, pay, and message.",
              cta: "For residents",
              attr: "why-role-residents",
            },
            {
              href: "/vendors",
              title: "Vendors",
              body: "Jobs, bids, and payouts.",
              cta: "For vendors",
              attr: "why-role-vendors",
            },
          ].map((card) => (
            <Link
              key={card.href}
              href={card.href}
              data-attr={card.attr}
              className="lp-page-card lp-page-card-pad flex h-full flex-col transition hover:border-[color-mix(in_srgb,var(--lp-blue)_35%,transparent)]"
            >
              <h3>{card.title}</h3>
              <p className="flex-1">{card.body}</p>
              <span className="mt-5 text-[13px] font-semibold text-[var(--lp-blue)]">
                {card.cta} →
              </span>
            </Link>
          ))}
        </div>
      </MarketingSection>

      <MarketingSection>
        <h2 className="text-center">Honest pricing</h2>
        <p className="lp-section-lede lp-center">Three plans. No sales wall.</p>
        <div className="mx-auto mt-8 grid max-w-4xl gap-3 sm:grid-cols-3">
          {PRICING_TIERS.map((tier) => (
            <div key={tier.name} className="lp-page-card lp-page-card-pad text-center">
              <div className="lp-page-kicker">{tier.name}</div>
              <div className="mt-2 text-3xl font-semibold tracking-tight text-[var(--lp-ink)]">
                {tier.price}
                <span className="text-sm font-medium text-[var(--lp-muted)]"> {tier.cadence}</span>
              </div>
              <p className="mt-2">{tier.detail}</p>
            </div>
          ))}
        </div>
        <div className="mt-8 text-center">
          <Link
            href="/pricing"
            data-attr="why-proplane-pricing-link"
            className="text-sm font-semibold text-[var(--lp-blue)]"
          >
            Full pricing →
          </Link>
        </div>
      </MarketingSection>

    </MarketingPageShell>
  );
}
