import type { Metadata } from "next";
import { MarketingCtaPair } from "@/components/marketing/marketing-cta";
import {
  MarketingHero,
  MarketingPageShell,
  MarketingSection,
} from "@/components/marketing/marketing-page-shell";

export const metadata: Metadata = {
  title: "Vendors · PropLane",
  description:
    "Get discovered by property managers, receive services, bid after a tour, and get paid. Free to join as a PropLane vendor.",
};

const HOW_IT_WORKS = [
  {
    step: "01",
    title: "Get matched",
    body: "Managers near you send services when your trade fits the job.",
  },
  {
    step: "02",
    title: "Tour & bid",
    body: "Visit the property, submit your price and schedule, and message in PropLane.",
  },
  {
    step: "03",
    title: "Get paid",
    body: "Approved work pays out through PropLane, with labor and materials tracked.",
  },
] as const;

const PERKS = [
  {
    title: "Inbox with managers",
    body: "Schedule visits, answer questions, and confirm scope without email chains.",
  },
  {
    title: "Calendar & services",
    body: "See what's open, in progress, and completed in one vendor portal.",
  },
  {
    title: "Invites & payouts",
    body: "Managers add you to their roster; approved jobs flow to payment when work is done.",
  },
] as const;

const VENDOR_SIGNUP_HREF = "/auth/vendor-register";

export default function VendorsPage() {
  return (
    <MarketingPageShell>
      <MarketingHero
        title="Services, sent straight to you."
      >
        <MarketingCtaPair
          primaryHref={VENDOR_SIGNUP_HREF}
          primaryLabel="Join as a vendor"
          primaryAttr="vendors-hero-get-started"
          secondaryHref="/contact"
          secondaryLabel="Talk to us"
          secondaryAttr="vendors-hero-contact"
        />
      </MarketingHero>

      <MarketingSection>
        <div className="lp-page-grid-3">
          {[
            { value: "Free", label: "No subscription, no listing fee" },
            { value: "Direct", label: "Jobs from managers you know" },
            { value: "1099", label: "Tax info on file for accurate filing" },
          ].map((f) => (
            <div key={f.label} className="lp-page-card lp-page-card-pad text-center">
              <p className="text-2xl font-semibold tracking-tight text-[var(--lp-ink)]">{f.value}</p>
              <p className="mt-2 text-[13px] text-[var(--lp-muted)]">{f.label}</p>
            </div>
          ))}
        </div>
      </MarketingSection>

      <MarketingSection>
        <h2 className="text-center">How it works</h2>
        <div className="lp-page-grid-3">
          {HOW_IT_WORKS.map((item) => (
            <div key={item.step} className="lp-page-card lp-page-card-pad">
              <p className="lp-page-kicker">{item.step}</p>
              <h3>{item.title}</h3>
              <p>{item.body}</p>
            </div>
          ))}
        </div>
      </MarketingSection>

      <MarketingSection>
        <h2 className="text-center">Stay connected to every job</h2>
        <div className="lp-page-grid-3">
          {PERKS.map((item) => (
            <div key={item.title} className="lp-page-card lp-page-card-pad">
              <h3>{item.title}</h3>
              <p>{item.body}</p>
            </div>
          ))}
        </div>
      </MarketingSection>
    </MarketingPageShell>
  );
}
