import type { Metadata } from "next";
import { TextingHomeHero } from "@/components/marketing/texting-home-hero";
import { HomeSoftwareDemo } from "@/components/marketing/home-software-demo";
import { HomeNumberStage } from "@/components/marketing/home-number-stage";
import { ResidentLifecycleAtmosphere } from "@/components/marketing/resident-lifecycle-atmosphere";
import { BigNumber } from "@/components/marketing/big-number";
import "@/components/marketing/home-h1.css";
import { HomeSectionHeader } from "@/components/marketing/home-section-header";
import { HomeJoinFree } from "@/components/marketing/home-join-free";
import { HomePricingCompare } from "@/components/marketing/home-pricing-compare";
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
    <div className="texting-home home-swiss home-wavy">
      <ResidentLifecycleAtmosphere variant="page" staticBelow={861} />
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: jsonLdString(homeJsonLd(llmsOrigin(), iosAppDownloadUrl())),
        }}
      />
      <section id="number" aria-label="The number">
        <TextingHomeHero />
        <HomeNumberStage />
      </section>
      <div className="home-editorial">
        <HomeSoftwareDemo />
        <section
          id="service"
          className="home-swiss-service"
          aria-labelledby="home-service-title"
        >
          <div className="swiss-wrap">
            <HomeSectionHeader id="home-service-title">Service</HomeSectionHeader>
            <div className="swiss-service-grid">
              <div className="swiss-service-intro">
                <p className="swiss-service-caption">
                  Too much work to run yourself? We&apos;ll manage it for you.
                </p>
                <a
                  href="#contact"
                  className="home-btn-primary"
                  data-attr="home-service-message-team"
                >
                  Message our team
                </a>
              </div>
              <ol className="swiss-service-list">
                {MANAGED_INCLUDES.map((item) => (
                  <li key={item.id}>{item.title}</li>
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
            </div>
          </div>
        </section>
        <section
          id="pricing"
          className="swiss-wrap swiss-pricing"
          aria-labelledby="home-pricing-title"
        >
          <HomePricingCompare titleId="home-pricing-title" />
        </section>
        <section
          id="contact"
          className="swiss-wrap swiss-contact"
          aria-labelledby="home-contact-title"
        >
          <HomeSectionHeader id="home-contact-title">Contact</HomeSectionHeader>
          <div className="swiss-contact-grid">
            <div className="home-contact-intro" id="home-close">
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
        <HomeJoinFree />
      </div>
    </div>
  );
}
