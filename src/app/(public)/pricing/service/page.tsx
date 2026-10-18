import type { Metadata } from "next";
import Link from "next/link";
import { CalendarClock, Hammer, MessageSquareText } from "lucide-react";
import { MANAGED_FAQ, MANAGED_SERVICE_NAME } from "@/lib/marketing/managed-service";
import { jsonLdString } from "@/lib/seo/json-ld";
import { llmsOrigin } from "@/lib/seo/llms";
import { TrackOnMount } from "@/components/analytics/track-on-mount";
import { SiteFaq } from "@/components/marketing/site/faq";
import { ManagedHowItWorks, ManagedIncludesGrid, ManagedTalkSection, PricingTabs } from "@/components/marketing/site/managed-service-sections";
import {
  MockChip,
  MockDraft,
  MockFrame,
  MockRow,
  SiteEyebrow,
  SiteHeading,
  SiteLede,
  SitePageHero,
  SiteSection,
  SITE_BTN_PRIMARY,
  SITE_BTN_SECONDARY,
} from "@/components/marketing/site/primitives";
import { SitePage } from "@/components/marketing/site/site-page";
import { TrackRecordBand } from "@/components/marketing/site/track-record-band";
import "@/components/marketing/site/page-polish.css";

export const metadata: Metadata = {
  title: "PropLane Managed",
  description:
    "We manage your home on PropLane: leasing and tenant placement, rent collection, maintenance with vendors, short-term and room rentals, a 24/7 texting line and owner reporting. Quoted per home.",
};

/** What the owner sees. Example text only; there is no number in it. */
function OwnerViewMock() {
  return (
    <MockFrame title="Services · Your home" aside={<MockChip tone="info">Owner view</MockChip>}>
      <div className="space-y-1">
        <MockRow name="Kitchen sink" title="Kitchen sink is leaking" sub="Plumber booked for Thursday morning" right={<MockChip tone="warn">Scheduled</MockChip>} />
        <MockRow name="Rent" title="Room 2 rent" sub="Paid through PropLane" right={<MockChip tone="good">Paid</MockChip>} />
        <MockRow name="Lease" title="Room 3 lease" sub="Waiting on the new resident's signature" right={<MockChip tone="info">Assigned</MockChip>} />
      </div>
      <div className="mt-3">
        <MockDraft label="PropLane drafted an update for you">
          The plumber visits Thursday between 10 and noon. The quote needs your OK before we book the repair.
        </MockDraft>
      </div>
    </MockFrame>
  );
}

const OWNER_POINTS = [
  { icon: <MessageSquareText strokeWidth={2} aria-hidden />, title: "Every message is on the record", copy: "Residents, vendors and prospects text one number, and the conversation is kept in the home's PropLane inbox." },
  { icon: <Hammer strokeWidth={2} aria-hidden />, title: "Repairs follow one path", copy: "Open, Assigned, Scheduled, Completed. You can see where each service is without asking us." },
  { icon: <CalendarClock strokeWidth={2} aria-hidden />, title: "Rent and stays on one calendar", copy: "Rent charges, lease dates and short-term stays sit in the same books we use to run the home." },
] as const;

export default function ManagedServicePage() {
  const origin = llmsOrigin();
  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "Service",
    "@id": `${origin}/pricing/service#service`,
    name: MANAGED_SERVICE_NAME,
    serviceType: "Residential property management",
    description: metadata.description,
    url: `${origin}/pricing/service`,
    provider: { "@type": "Organization", name: "PropLane", url: `${origin}/` },
    areaServed: "Seattle, WA",
  };
  return (
    <SitePage>
      <TrackOnMount event="pricing_viewed" properties={{ billing: "service" }} />
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLdString(jsonLd) }} />
      <SitePageHero
        id="managed-title"
        wide
        eyebrow="PropLane Managed"
        title={
          <>
            Your home, managed
            <span className="site-accent">by the people who built the software.</span>
          </>
        }
        lede="We run our own Airbnb and room-rental homes in Seattle on PropLane. Hand us yours and we will run it the same way: leasing, rent, repairs and residents, with you able to see all of it."
        actions={
          <div className="flex flex-col items-center gap-5">
            <PricingTabs active="service" />
            <div className="flex flex-wrap items-center justify-center gap-3.5">
              <a href="#talk" data-attr="managed-hero-talk" className={SITE_BTN_PRIMARY}>
                Talk to us
              </a>
              <Link href="/why-proplane/track-record" data-attr="managed-hero-track-record" className={SITE_BTN_SECONDARY}>
                See our track record
              </Link>
            </div>
          </div>
        }
        note="Priced per home. No price list, no commitment to ask."
      />

      <SiteSection ariaLabelledBy="managed-proof-title">
        <div className="mx-auto mb-8 flex max-w-[48rem] flex-col items-center text-center">
          <SiteEyebrow className="mb-3">Why trust us with it</SiteEyebrow>
          <SiteHeading id="managed-proof-title">We already do this, for ourselves.</SiteHeading>
        </div>
        <TrackRecordBand attr="managed-track-record" />
        <p className="mt-6 text-center">
          <Link href="/why-proplane/track-record" data-attr="managed-proof-link" className="text-[15px] font-bold text-primary hover:underline">
            Read how we run these homes →
          </Link>
        </p>
      </SiteSection>

      <ManagedIncludesGrid />
      <ManagedHowItWorks />

      <SiteSection ariaLabelledBy="managed-owner-title">
        <div className="grid items-center gap-10 lg:grid-cols-[minmax(0,1fr)_minmax(0,480px)] lg:gap-16">
          <div>
            <SiteEyebrow className="mb-3">What you see</SiteEyebrow>
            <SiteHeading id="managed-owner-title">
              You are not kept in the dark.
              <span className="site-accent block">Your home lives in PropLane.</span>
            </SiteHeading>
            <SiteLede className="mt-4">Because we manage on the software, there is no separate report to wait for. The record is the work.</SiteLede>
            <ul className="mt-8 space-y-5">
              {OWNER_POINTS.map((p) => (
                <li key={p.title} className="flex gap-4">
                  <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-[#1769bd]/10 text-[#1769bd] [&>svg]:h-[18px] [&>svg]:w-[18px]">{p.icon}</span>
                  <span>
                    <span className="block text-[16px] font-bold text-foreground">{p.title}</span>
                    <span className="mt-1 block text-[14.5px] leading-relaxed text-muted">{p.copy}</span>
                  </span>
                </li>
              ))}
            </ul>
          </div>
          <div className="min-w-0">
            <OwnerViewMock />
          </div>
        </div>
      </SiteSection>

      <ManagedTalkSection />
      <SiteFaq items={[...MANAGED_FAQ]} id="managed-faq" />

      <section aria-label="Prefer the software" className="pb-20 pt-4 text-center sm:pb-24">
        <p className="text-[15.5px] text-muted">
          Want to run your own homes instead?{" "}
          <Link href="/pricing" data-attr="managed-closing-software" className="font-bold text-primary hover:underline">
            See the software plans →
          </Link>
        </p>
      </section>
    </SitePage>
  );
}
