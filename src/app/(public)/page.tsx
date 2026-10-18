import type { Metadata } from "next";
import Link from "next/link";
import { TextingHomeHero } from "@/components/marketing/texting-home-hero";
import { ResidentLifecycleAtmosphere } from "@/components/marketing/resident-lifecycle-atmosphere";
import { HomeNumberStage } from "@/components/marketing/home-number-stage";
import { HomeDashboardStage } from "@/components/marketing/home-dashboard-stage";
import { BigNumber } from "@/components/marketing/big-number";
import { PricingCards } from "@/components/marketing/site/pricing-cards";
import { ManagedServiceForm } from "@/components/marketing/site/managed-service-form";
import { HOME_DESCRIPTION, HOME_HEADLINE } from "@/lib/marketing/home-copy";
import { MANAGED_INCLUDES } from "@/lib/marketing/managed-service";
import { TRACK_RECORD } from "@/lib/marketing/track-record";
import { PUBLIC_SUPPORT_EMAIL } from "@/lib/marketing/public-contact";
import { iosAppDownloadUrl } from "@/lib/ios-app-download";
import { homeJsonLd, jsonLdString } from "@/lib/seo/json-ld";
import { llmsOrigin } from "@/lib/seo/llms";

export const revalidate = 60;
export const metadata: Metadata = {
  title: HOME_HEADLINE,
  description: HOME_DESCRIPTION,
  alternates: { canonical: "/" },
  openGraph: { title: HOME_HEADLINE, description: HOME_DESCRIPTION },
  twitter: { title: HOME_HEADLINE, description: HOME_DESCRIPTION },
};

// The layout supplies the shared-line snapshot. Keep this page synchronous so
// the complete cover and section heights are present in the first response.
export default function HomePage() {
  return (
    <div className="texting-home home-wavy">
      <ResidentLifecycleAtmosphere variant="page" staticBelow={10000} />
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: jsonLdString(homeJsonLd(llmsOrigin(), iosAppDownloadUrl())),
        }}
      />
      <TextingHomeHero />
      <HomeNumberStage />
      <div className="home-editorial">
        <HomeDashboardStage />
        <section
          id="service"
          className="texting-shell home-service"
          aria-labelledby="home-service-title"
        >
          <div className="home-service-intro">
            <h2 className="texting-section-title" id="home-service-title">
              We manage it
              <br />
              for you.
            </h2>
            <p>
              We built PropLane to run our own Seattle homes. Now our team can
              run yours, on the same software.
            </p>
            <Link
              className="home-inline-link"
              href="/#contact"
              data-attr="home-service-contact"
            >
              Tell us about your home <span aria-hidden="true">↗</span>
            </Link>
          </div>
          <ul className="home-service-list">
            {MANAGED_INCLUDES.map((item) => (
              <li key={item.id}>
                <h3>{item.title}</h3>
                <p>{item.copy}</p>
              </li>
            ))}
          </ul>
          <dl className="home-track-record" aria-label="Our own Seattle homes">
            <div>
              <dt>We run ourselves in Seattle</dt>
              <dd>{TRACK_RECORD.homes} homes</dd>
            </div>
            <div>
              <dt>Rooms occupied</dt>
              <dd>
                {TRACK_RECORD.roomsOccupied} of {TRACK_RECORD.roomsTotal}
              </dd>
            </div>
            <div>
              <dt>From running these homes</dt>
              <dd>{TRACK_RECORD.profit}</dd>
            </div>
          </dl>
        </section>
        <section
          id="pricing"
          className="texting-shell texting-pricing"
          aria-labelledby="home-pricing-title"
        >
          <h2 className="texting-section-title" id="home-pricing-title">
            Your software.
            <br />
            Or your whole team.
          </h2>
          <PricingCards variant="overview" />
        </section>
        <section
          id="contact"
          className="texting-shell home-contact"
          aria-labelledby="home-contact-title"
        >
          <div className="home-contact-intro" id="home-close">
            <h2 className="texting-section-title" id="home-contact-title">
              Let’s talk
              <br />
              about your home.
            </h2>
            <p>
              Tell us where it is and what you need. We’ll take it from there.
            </p>
            <BigNumber dataAttr="home-contact-text" />
            <a
              href={`mailto:${PUBLIC_SUPPORT_EMAIL}`}
              data-attr="home-contact-email"
            >
              {PUBLIC_SUPPORT_EMAIL}
            </a>
          </div>
          <ManagedServiceForm
            className="home-contact-form"
            attrPrefix="home-contact"
          />
        </section>
      </div>
    </div>
  );
}
