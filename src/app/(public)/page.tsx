import type { Metadata } from "next";
import Link from "next/link";
import {
  ArrowUpRight,
  CalendarDays,
  House,
  KeyRound,
  Wrench,
} from "lucide-react";
import { TextingHomeHero } from "@/components/marketing/texting-home-hero";
import { TextingHomeLazy } from "@/components/marketing/texting-home-lazy";
import { PricingCards } from "@/components/marketing/site/pricing-cards";
import { HOME_DESCRIPTION, HOME_HEADLINE } from "@/lib/marketing/home-copy";
import { iosAppDownloadUrl } from "@/lib/ios-app-download";
import { homeJsonLd, jsonLdString } from "@/lib/seo/json-ld";
import { llmsOrigin } from "@/lib/seo/llms";
import "@/components/marketing/texting-home.css";

export const revalidate = 60;

export const metadata: Metadata = {
  title: HOME_HEADLINE,
  description: HOME_DESCRIPTION,
  openGraph: { title: HOME_HEADLINE, description: HOME_DESCRIPTION },
  twitter: { title: HOME_HEADLINE, description: HOME_DESCRIPTION },
};
const roles = [
  {
    name: "Applicants",
    icon: CalendarDays,
    line: "From first text to first tour.",
    sample: "Is Room 3 still available?",
  },
  {
    name: "Residents",
    icon: KeyRound,
    line: "House answers. Rent. Repairs.",
    sample: "The kitchen sink is leaking.",
  },
  {
    name: "Vendors",
    icon: Wrench,
    line: "Accept the job. Keep everyone posted.",
    sample: "I can be there Thursday at 9.",
  },
  {
    name: "You",
    icon: House,
    line: "Your properties, one conversation.",
    sample: "Who hasn’t paid rent this month?",
  },
];
// Keep the page synchronous: its shared-line snapshot arrives from the layout.
// Suspending here streams a short loading shell and shifts the entire footer.
export default function HomePage() {
  return (
    <div className="texting-home">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: jsonLdString(homeJsonLd(llmsOrigin(), iosAppDownloadUrl())),
        }}
      />
      <TextingHomeHero />
      <section
        id="how-it-works"
        className="texting-shell texting-roles"
        aria-labelledby="who-texts-title"
      >
        <h2 className="texting-section-title" id="who-texts-title">
          Who texts PropLane
        </h2>
        <div
          className="texting-role-grid"
          tabIndex={0}
          role="region"
          aria-label="People who text PropLane; swipe to explore"
        >
          {roles.map(({ name, icon: Icon, line, sample }) => (
            <article className="texting-role-card" key={name}>
              <Icon aria-hidden="true" />
              <h3>{name}</h3>
              <p>{line}</p>
              <blockquote>{sample}</blockquote>
            </article>
          ))}
        </div>
      </section>
      <section
        id="for-managers"
        className="texting-shell texting-service"
        aria-labelledby="service-title"
      >
        <div className="texting-service-intro">
          <span className="texting-eyebrow">
            SOFTWARE. AND THE PEOPLE BEHIND IT.
          </span>
          <h2 className="texting-section-title" id="service-title">
            PropLane manages it for you.
          </h2>
          <p>
            We built PropLane to run our own Seattle homes. Now we bring the
            software and hands-on management to yours.
          </p>
          <Link className="texting-feature-link" href="/service">
            Explore managed service{" "}
            <ArrowUpRight aria-hidden="true" className="h-4 w-4" />
          </Link>
        </div>
        <dl
          className="texting-track-record"
          aria-label="The founders’ track record"
        >
          <div>
            <dt>Founder-operated</dt>
            <dd>3 Seattle homes</dd>
          </div>
          <div>
            <dt>Rental experience</dt>
            <dd>Room rentals + Airbnb</dd>
          </div>
          <div>
            <dt>Founders’ reported result</dt>
            <dd>six-figure profit</dd>
          </div>
        </dl>
        <div className="texting-control">
          <div>
            <h3>You stay in control.</h3>
            <Link className="texting-feature-link" href="/features">
              Explore the software{" "}
              <ArrowUpRight aria-hidden="true" className="h-4 w-4" />
            </Link>
          </div>
          <TextingHomeLazy kind="draft" />
        </div>
        <div
          className="texting-dashboard"
          aria-label="Sample manager dashboard"
        >
          <TextingHomeLazy kind="dashboard" />
        </div>
      </section>
      <section
        id="pricing"
        className="texting-shell texting-pricing"
        aria-labelledby="home-pricing-title"
      >
        <h2 className="texting-section-title" id="home-pricing-title">
          Your software. Or your whole team.
        </h2>
        <PricingCards variant="overview" />
      </section>
    </div>
  );
}
