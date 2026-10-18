import type { Metadata } from "next";
import { TextingHomeHero } from "@/components/marketing/texting-home-hero";
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
    <div className="texting-home home-swiss">
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
          className="home-swiss-service"
          aria-labelledby="home-service-title"
        >
          <div className="swiss-wrap">
            <div className="swiss-section-label">
              <span>03</span>Service
            </div>
            <div className="swiss-service-grid">
              <h2 className="swiss-title" id="home-service-title">
                We manage
                <br />
                it for you
              </h2>
              <ol className="swiss-service-list">
                {MANAGED_INCLUDES.map((item, index) => (
                  <li key={item.id}>
                    <span>{String(index + 1).padStart(2, "0")}</span>
                    {item.title}
                  </li>
                ))}
              </ol>
            </div>
          </div>
          <div className="swiss-track-record">
            <div className="swiss-wrap swiss-track-grid">
              <div className="swiss-track-label">Track record</div>
              <p>
                We run {TRACK_RECORD.homes === 3 ? "three" : TRACK_RECORD.homes}{" "}
                homes in Seattle — {TRACK_RECORD.roomsOccupied} of{" "}
                {TRACK_RECORD.roomsTotal} rooms occupied — at a{" "}
                {TRACK_RECORD.profit.toLowerCase()}.
              </p>
              <div className="swiss-room-plan">
                <div
                  className="swiss-rooms"
                  role="img"
                  aria-label={`${TRACK_RECORD.roomsOccupied} of ${TRACK_RECORD.roomsTotal} rooms occupied`}
                >
                  {Array.from(
                    { length: TRACK_RECORD.roomsTotal },
                    (_, index) => (
                      <span
                        key={index}
                        data-occupied={index < TRACK_RECORD.roomsOccupied}
                      />
                    ),
                  )}
                </div>
                <div className="swiss-room-legend">
                  <strong>
                    {TRACK_RECORD.roomsOccupied} of {TRACK_RECORD.roomsTotal}{" "}
                    rooms occupied
                  </strong>
                  <span>Filled = occupied</span>
                </div>
              </div>
            </div>
          </div>
        </section>
        <section
          id="pricing"
          className="swiss-wrap swiss-pricing"
          aria-labelledby="home-pricing-title"
        >
          <h2 className="swiss-section-label" id="home-pricing-title">
            <span>04</span>Pricing
          </h2>
          <PricingCards variant="overview" />
        </section>
        <section
          id="contact"
          className="swiss-wrap swiss-contact"
          aria-labelledby="home-contact-title"
        >
          <div className="swiss-section-label">
            <span>05</span>Contact
          </div>
          <div className="swiss-contact-grid">
            <div className="home-contact-intro" id="home-close">
              <h2 className="swiss-title" id="home-contact-title">
                Talk
                <br />
                to us
              </h2>
              <BigNumber dataAttr="home-contact-text" label="Text us" />
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
              variant="swiss"
            />
          </div>
        </section>
      </div>
    </div>
  );
}
