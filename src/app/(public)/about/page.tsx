import type { Metadata } from "next";
import Link from "next/link";
import { SiteFinalCta } from "@/components/marketing/site/final-cta";
import {
  PUBLIC_SUPPORT_ADDRESS_LINE,
  PUBLIC_SUPPORT_PHONE_DISPLAY,
  PUBLIC_SUPPORT_PHONE_TEL,
} from "@/lib/marketing/public-contact";
import {
  MarketingHero,
  MarketingPageShell,
  MarketingSection,
} from "@/components/marketing/marketing-page-shell";

export const metadata: Metadata = {
  title: "About us",
  description:
    "PropLane is built by property managers in Seattle who run their own rental units on it every day. AI does the busywork, you approve what matters.",
};

const VALUES = [
  {
    title: "Software should do the work",
    body: "Chasing rent, drafting leases, filing documents, lining up vendors: that's busywork. Your time belongs on decisions.",
  },
  {
    title: "You stay in control",
    body: "Every AI action is previewed, confirmed by you, and audit-logged. Nothing sends without your sign-off.",
  },
  {
    title: "One platform for everyone",
    body: "Managers, residents, and vendors each get a real portal. When everyone works in the same place, less falls through.",
  },
  {
    title: "Prove it before you pay",
    body: "A free tier and a 14-day trial with no card. If PropLane doesn't earn its keep, you shouldn't pay for it.",
  },
] as const;

const FACTS = [
  "Built in Seattle",
  "Web + iOS, one account",
  "3 portals: manager, resident, vendor",
  "Run on our own units",
] as const;

export default function AboutPage() {
  return (
    <MarketingPageShell>
      <MarketingHero
        title="Built by managers tired of the busywork"
        subtitle="We manage real rental units in Seattle. PropLane is the platform we built to run them. AI drafts, we approve."
      />

      <MarketingSection>
        <div className="grid gap-8 lg:grid-cols-[1fr_1.35fr] lg:gap-16">
          <div>
            <p className="lp-page-kicker">Our story</p>
            <h2 className="mt-2 max-w-[14ch]">We are our own first customer</h2>
          </div>
          <div className="space-y-4 text-[15.5px] leading-relaxed text-[var(--lp-muted)]">
            <p>
              For years we ran units the way most small landlords do: one tool for listings, another
              for rent, and a spreadsheet for the books. Every month meant copying the same numbers
              and hoping nothing slipped.
            </p>
            <p>
              So we built the platform we wished we had: applications become leases, rent collects
              itself, repairs get bid out and paid, and the books balance. The AI does the busywork;
              the manager approves what matters.
            </p>
            <p className="text-[var(--lp-ink)]">
              We run our own units on PropLane every day. If a workflow annoys us, we feel it before
              you do, and we fix it.
            </p>
          </div>
        </div>
      </MarketingSection>

      <MarketingSection>
        <h2 className="text-center">What we believe</h2>
        <div className="lp-page-grid-2">
          {VALUES.map((value, i) => (
            <div key={value.title} className="lp-page-card lp-page-card-pad">
              <p className="lp-page-kicker">{String(i + 1).padStart(2, "0")}</p>
              <h3>{value.title}</h3>
              <p>{value.body}</p>
            </div>
          ))}
        </div>
      </MarketingSection>

      <MarketingSection>
        <ul className="lp-page-card flex flex-col items-center justify-center gap-3 px-6 py-5 text-center sm:flex-row sm:flex-wrap sm:gap-x-8 sm:py-6">
          {FACTS.map((fact, i) => (
            <li
              key={fact}
              className="flex items-center gap-3 text-sm font-semibold text-[var(--lp-ink)] sm:gap-8"
            >
              {i > 0 ? (
                <span aria-hidden className="hidden h-1 w-1 rounded-full bg-[var(--lp-muted)] sm:block" />
              ) : null}
              {fact}
            </li>
          ))}
        </ul>
      </MarketingSection>

      <MarketingSection>
        <div className="grid gap-8 lg:grid-cols-[1fr_1.35fr] lg:gap-16">
          <div>
            <p className="lp-page-kicker">Where we are</p>
            <h2 className="mt-2 max-w-[14ch]">Seattle, and a phone that answers</h2>
          </div>
          <dl className="grid gap-4 sm:grid-cols-2">
            <div className="lp-page-card lp-page-card-pad">
              <dt className="text-[12px] font-bold uppercase tracking-[0.08em] text-[var(--lp-blue)]">Address</dt>
              <dd className="mt-2 text-[15px] font-semibold text-[var(--lp-ink)]">{PUBLIC_SUPPORT_ADDRESS_LINE}</dd>
            </div>
            <div className="lp-page-card lp-page-card-pad">
              <dt className="text-[12px] font-bold uppercase tracking-[0.08em] text-[var(--lp-blue)]">Phone</dt>
              <dd className="mt-2 text-[15px] font-semibold tabular-nums text-[var(--lp-ink)]">
                <a href={`tel:${PUBLIC_SUPPORT_PHONE_TEL}`}>{PUBLIC_SUPPORT_PHONE_DISPLAY}</a>
              </dd>
            </div>
            <div className="lp-page-card lp-page-card-pad sm:col-span-2">
              <dt className="text-[12px] font-bold uppercase tracking-[0.08em] text-[var(--lp-blue)]">Security</dt>
              <dd className="mt-2 text-[14.5px] leading-relaxed text-[var(--lp-muted)]">
                How your data and your residents&rsquo; data are kept — encrypted connections and storage, an extra
                encryption layer for sensitive records, permission-checked access, and an assistant that drafts but
                never sends.{" "}
                <Link href="/security" data-attr="about-security" className="font-semibold text-[var(--lp-blue)]">
                  Read the security page →
                </Link>
              </dd>
            </div>
          </dl>
        </div>
      </MarketingSection>

      <SiteFinalCta primaryAttr="about-closing-get-started" secondaryAttr="about-closing-book-demo" />
    </MarketingPageShell>
  );
}
