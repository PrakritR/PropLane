import type { Metadata } from "next";
import Link from "next/link";
import { HandHelping, Laptop } from "lucide-react";
import { RESIDENT_BROWSE_PATH } from "@/lib/resident-public-nav";
import { MANAGED_SERVICE_HREF } from "@/lib/marketing/managed-service";
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
import { cn } from "@/lib/utils";

export const metadata: Metadata = {
  title: "Why PropLane",
  description:
    "PropLane started as the way we run our own Airbnb and room-rental homes in Seattle, which produced six-figure profit. Now we manage homes for owners on it, or you can run your own.",
};

/*
 * The argument, in order:
 *   1. we manage properties ourselves (the founders' own homes, the numbers the captain stated);
 *   2. so there are two ways in: we run your home, or you run it on the software;
 *   3. why we built it (the switchboard problem);
 *   4. where to start.
 *
 * Figures come only from `lib/marketing/track-record.ts`. "Six-figure profit" is
 * the captain's own phrase and carries no dollar amount.
 */

const CARD = "rounded-2xl border border-[var(--site-line,#dbe4ef)] bg-white/85 shadow-[0_18px_44px_-30px_rgba(19,43,71,0.3)]";

const ROLES = [
  {
    href: "/partner",
    title: "Managers & landlords",
    body: "Run the portfolio and approve the rest.",
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
] as const;

const TWO_WAYS = [
  {
    icon: <HandHelping strokeWidth={2} aria-hidden />,
    label: "We manage it",
    title: "PropLane Managed",
    copy: "Our team runs your home on PropLane: leasing, rent, repairs, short-term and room rentals, and the texting line. Quoted per home.",
    href: MANAGED_SERVICE_HREF,
    cta: "See the managed service",
    attr: "why-way-managed",
    primary: true,
  },
  {
    icon: <Laptop strokeWidth={2} aria-hidden />,
    label: "You manage it",
    title: "PropLane software",
    copy: "The same system, in your hands. Free for the first residents, with paid plans as the portfolio grows.",
    href: "/pricing",
    cta: "See software pricing",
    attr: "why-way-software",
    primary: false,
  },
] as const;

export default function WhyPropLanePage() {
  return (
    <SitePage>
      <SitePageHero
        eyebrow="Why PropLane"
        id="why-title"
        wide
        title={
          <>
            We manage homes ourselves.
            <span className="site-accent">PropLane is how.</span>
          </>
        }
        lede="We ran multiple Airbnb and room-rental homes in Seattle, and that operation produced six-figure profit. PropLane is the system we built to run them. Now we run homes for owners on it, or you can run your own."
        actions={
          <div className="flex flex-col items-center gap-6">
            <WhySubnav active="overview" />
            <div className="flex flex-wrap items-center justify-center gap-3.5">
              <Link href={`${MANAGED_SERVICE_HREF}#talk`} data-attr="why-proplane-hero-talk" className={SITE_BTN_PRIMARY}>
                Talk to us about your home
              </Link>
              <Link href="/pricing" data-attr="why-proplane-hero-pricing" className={SITE_BTN_SECONDARY}>
                See software pricing
              </Link>
            </div>
          </div>
        }
      />

      <SiteSection ariaLabelledBy="why-proof-title">
        <div className="mx-auto mb-8 flex max-w-[48rem] flex-col items-center text-center sm:mb-10">
          <SiteEyebrow className="mb-3">Our own homes</SiteEyebrow>
          <SiteHeading id="why-proof-title">The track record is ours, not a case study.</SiteHeading>
          <SiteLede className="mx-auto mt-4">We run these homes ourselves, every day, on the same software we sell.</SiteLede>
        </div>
        <TrackRecordBand attr="why-track-record" />
        <p className="mt-6 text-center">
          <Link href="/why-proplane/track-record" data-attr="why-proof-link" className="text-[15px] font-bold text-primary hover:underline">
            See the homes and how we run them →
          </Link>
        </p>
      </SiteSection>

      <SiteSection ariaLabelledBy="why-ways-title">
        <div className="mx-auto mb-10 flex max-w-[48rem] flex-col items-center text-center">
          <SiteEyebrow className="mb-3">Two ways in</SiteEyebrow>
          <SiteHeading id="why-ways-title">Let us run it, or run it yourself.</SiteHeading>
        </div>
        <div className="mx-auto grid max-w-[60rem] gap-4 md:grid-cols-2">
          {TWO_WAYS.map((w) => (
            <Link
              key={w.href}
              href={w.href}
              data-attr={w.attr}
              className={cn(
                CARD,
                "flex h-full flex-col p-7 transition-[border-color,transform] duration-100 hover:-translate-y-0.5 hover:border-[#8fb0d4]",
                w.primary && "border-[#1769bd]/50",
              )}
            >
              <span className="grid h-10 w-10 place-items-center rounded-xl bg-[#1769bd]/10 text-[#1769bd] [&>svg]:h-[18px] [&>svg]:w-[18px]">{w.icon}</span>
              <p className="mt-5 text-[12px] font-extrabold uppercase tracking-[0.14em] text-[#1a47bd]">{w.label}</p>
              <h3 className="mt-1 text-[22px] font-bold tracking-tight text-foreground">{w.title}</h3>
              <p className="mt-2 flex-1 text-[15px] leading-relaxed text-muted">{w.copy}</p>
              <span className="mt-6 text-[14px] font-bold text-primary">{w.cta} →</span>
            </Link>
          ))}
        </div>
      </SiteSection>

      <SiteSection ariaLabelledBy="why-story-title">
        <div className="grid items-start gap-10 lg:grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)] lg:gap-16">
          <div>
            <SiteEyebrow className="mb-3">Why we built it</SiteEyebrow>
            <SiteHeading id="why-story-title" className="max-w-[16ch]">
              We were the switchboard.
            </SiteHeading>
          </div>
          <div className="space-y-4 text-[16px] leading-relaxed text-muted">
            <p>
              Running several Airbnb and room-rental homes means a resident texts you about a leak, you text a plumber, the plumber quotes, you ask the owner, and every answer travels back down the same line. Most of the job is relaying messages.
            </p>
            <p>
              So we built PropLane to do the relaying: an assistant that drafts the reply, routes the repair and follows up, while we approve what matters. We run our homes on it today, and that operation produced six-figure profit.
            </p>
            <p className="text-foreground">
              Now the same team and the same system are available for your home.{" "}
              <Link href="/why-proplane/software" data-attr="why-story-software" className="font-bold text-primary hover:underline">
                See how the software works →
              </Link>
            </p>
          </div>
        </div>
      </SiteSection>

      <SiteSection ariaLabelledBy="why-roles-title">
        <div>
          <SiteHeading id="why-roles-title" className="mb-8 text-center">
            Start where you fit
          </SiteHeading>
          <div className="mx-auto grid max-w-[60rem] gap-4 md:grid-cols-3">
            {ROLES.map((card) => (
              <Link
                key={card.href}
                href={card.href}
                data-attr={card.attr}
                className={cn(CARD, "flex h-full flex-col p-6 transition-[border-color,transform] duration-100 hover:-translate-y-0.5 hover:border-[#8fb0d4]")}
              >
                <h3 className="text-[18px] font-bold tracking-tight text-foreground">{card.title}</h3>
                <p className="mt-2 flex-1 text-[14.5px] text-muted">{card.body}</p>
                <span className="mt-5 text-[14px] font-bold text-primary">{card.cta} →</span>
              </Link>
            ))}
          </div>
        </div>
      </SiteSection>

      <SiteFinalCta
        title="Want us to run your home?"
        primaryAttr="why-proplane-closing-talk"
        secondaryAttr="why-proplane-closing-software"
        primaryHref={`${MANAGED_SERVICE_HREF}#talk`}
        primaryLabel="Talk to us"
        secondaryHref="/pricing"
        secondaryLabel="See software pricing"
      />
    </SitePage>
  );
}
