import type { Metadata } from "next";
import Link from "next/link";
import { BedDouble, CalendarRange, MessageSquareText, ShieldCheck } from "lucide-react";
import { MANAGED_CONTACT_HREF } from "@/lib/marketing/managed-service";
import { TRACK_RECORD, TRACK_RECORD_HOMES } from "@/lib/marketing/track-record";
import { SiteFinalCta } from "@/components/marketing/site/final-cta";
import {
  SITE_BTN_PRIMARY,
  SITE_BTN_SECONDARY,
  SiteEyebrow,
  SiteHeading,
  SiteLede,
  SitePageHero,
  SiteSection,
} from "@/components/marketing/site/primitives";
import { SitePage } from "@/components/marketing/site/site-page";
import { TrackRecordBand } from "@/components/marketing/site/track-record-band";
import { WhySubnav } from "@/components/marketing/site/why-subnav";

export const metadata: Metadata = {
  alternates: { canonical: "/#service" },
  title: "Our track record",
  description: `We run ${TRACK_RECORD.homes} homes in Seattle on PropLane: ${TRACK_RECORD.roomsOccupied} of ${TRACK_RECORD.roomsTotal} rooms occupied, and an operation that produced six-figure profit.`,
};

const CARD = "rounded-2xl border border-[var(--site-line,#d6d7d2)] bg-white/85 shadow-[0_18px_44px_-30px_rgba(12,13,16,0.3)]";

/** What running these homes made the software do. Each is a real PropLane capability. */
const LEARNED = [
  {
    icon: <BedDouble strokeWidth={2} aria-hidden />,
    title: "A home is rooms, not one lease",
    copy: "Rooms are rented separately, so PropLane tracks occupancy, rent and leases room by room.",
  },
  {
    icon: <CalendarRange strokeWidth={2} aria-hidden />,
    title: "Stays and leases share a calendar",
    copy: "Short-term stays and by-the-room leases sit in one bookings view, with Airbnb calendars synced.",
  },
  {
    icon: <MessageSquareText strokeWidth={2} aria-hidden />,
    title: "One number for every conversation",
    copy: "Residents, vendors and prospects text the same line, and every thread is kept in one inbox.",
  },
  {
    icon: <ShieldCheck strokeWidth={2} aria-hidden />,
    title: "Nothing sends without an OK",
    copy: "The assistant drafts. A person approves what matters, and regulated notices are never automated.",
  },
] as const;

export default function TrackRecordPage() {
  return (
    <SitePage>
      <SitePageHero
        eyebrow="Why PropLane · Our track record"
        id="track-title"
        wide
        title={
          <>
            The homes behind PropLane.
            <span className="site-accent">Run by us, every day.</span>
          </>
        }
        lede="We ran multiple Airbnb and room-rental homes in Seattle before we sold anyone software. These are the numbers from our own homes, and nothing else."
        actions={
          <div className="flex flex-col items-center gap-6">
            <WhySubnav active="track-record" />
          </div>
        }
      />

      <SiteSection ariaLabelledBy="track-numbers-title">
        <div className="mx-auto mb-8 flex max-w-[48rem] flex-col items-center text-center sm:mb-10">
          <SiteEyebrow className="mb-3">The numbers</SiteEyebrow>
          <SiteHeading id="track-numbers-title">{TRACK_RECORD.homes} homes. {TRACK_RECORD.roomsOccupied} of {TRACK_RECORD.roomsTotal} rooms occupied.</SiteHeading>
          <SiteLede className="mx-auto mt-4">
            Occupancy is a count of rooms as of October 2026. The profit figure is the founders&rsquo; own statement of how the operation did; we do not publish a dollar amount.
          </SiteLede>
        </div>
        <TrackRecordBand attr="track-page-record" />
      </SiteSection>

      <SiteSection ariaLabelledBy="track-homes-title">
        <div className="mx-auto mb-8 flex max-w-[48rem] flex-col items-center text-center">
          <SiteEyebrow className="mb-3">The homes</SiteEyebrow>
          <SiteHeading id="track-homes-title">Where it happens.</SiteHeading>
        </div>
        <ul className="mx-auto grid max-w-[60rem] gap-4 md:grid-cols-3">
          {TRACK_RECORD_HOMES.map((address) => (
            <li key={address} className={`${CARD} p-6`}>
              <p className="text-[17px] font-bold tracking-tight text-foreground">{address}</p>
              <p className="mt-1 text-[14px] text-muted">Seattle, WA</p>
              <p className="mt-4 text-[13px] font-semibold text-primary">Run by us on PropLane</p>
            </li>
          ))}
        </ul>
      </SiteSection>

      <SiteSection ariaLabelledBy="track-learned-title">
        <div className="mx-auto mb-10 flex max-w-[48rem] flex-col items-center text-center">
          <SiteEyebrow className="mb-3">What it taught the software</SiteEyebrow>
          <SiteHeading id="track-learned-title">Built on our own mistakes first.</SiteHeading>
        </div>
        <ul className="grid gap-4 md:grid-cols-2">
          {LEARNED.map((l) => (
            <li key={l.title} className={`${CARD} flex gap-4 p-6`}>
              <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-[#2f5fd0]/10 text-[#2f5fd0] [&>svg]:h-[18px] [&>svg]:w-[18px]">{l.icon}</span>
              <span>
                <span className="block text-[17px] font-bold tracking-tight text-foreground">{l.title}</span>
                <span className="mt-1.5 block text-[14.5px] leading-relaxed text-muted">{l.copy}</span>
              </span>
            </li>
          ))}
        </ul>
        <div className="mt-10 flex flex-wrap items-center justify-center gap-3.5">
          <Link href={MANAGED_CONTACT_HREF} data-attr="track-talk" className={SITE_BTN_PRIMARY}>
            Talk to us about your home
          </Link>
          <Link href="/why-proplane/how-we-manage" data-attr="track-how" className={SITE_BTN_SECONDARY}>
            How we manage
          </Link>
        </div>
      </SiteSection>

      <SiteFinalCta
        title="Want this for your home?"
        primaryAttr="track-closing-talk"
        secondaryAttr="track-closing-software"
        primaryHref={MANAGED_CONTACT_HREF}
        primaryLabel="Talk to us"
        secondaryHref="/pricing"
        secondaryLabel="See software pricing"
      />
    </SitePage>
  );
}
