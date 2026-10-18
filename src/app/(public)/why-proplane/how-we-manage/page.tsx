import type { Metadata } from "next";
import Link from "next/link";
import { MANAGED_CONTACT_HREF, MANAGED_SERVICE_HREF } from "@/lib/marketing/managed-service";
import { SiteFinalCta } from "@/components/marketing/site/final-cta";
import { ManagedHowItWorks, ManagedIncludesGrid } from "@/components/marketing/site/managed-service-sections";
import { SITE_BTN_PRIMARY, SITE_BTN_SECONDARY, SiteEyebrow, SiteHeading, SitePageHero, SiteSection } from "@/components/marketing/site/primitives";
import { SitePage } from "@/components/marketing/site/site-page";
import { WhySubnav } from "@/components/marketing/site/why-subnav";
import { cn } from "@/lib/utils";

export const metadata: Metadata = {
  alternates: { canonical: "/#service" },
  title: "How we manage",
  description:
    "How PropLane Managed runs a home: leasing and tenant placement, rent collection, maintenance with vendors, short-term and room rentals, a 24/7 texting line and owner reporting.",
};

const CARD = "rounded-2xl border border-[var(--site-line,#dbe4ef)] bg-white/85 shadow-[0_18px_44px_-30px_rgba(19,43,71,0.3)]";

const PRINCIPLES = [
  {
    title: "One system, one record",
    copy: "Everything we do for your home happens in PropLane, so what we tell you is what the books say.",
  },
  {
    title: "People decide, software relays",
    copy: "The assistant drafts messages and routes repairs. A person approves what matters before it goes out.",
  },
  {
    title: "Regulated notices stay human",
    copy: "Late rent, deposit accounting and adverse action are never automated. PropLane reminds us and opens the tool.",
  },
  {
    title: "You can look any time",
    copy: "Rent, services and messages for your home are in PropLane, not in a report that arrives later.",
  },
] as const;

export default function HowWeManagePage() {
  return (
    <SitePage>
      <SitePageHero
        eyebrow="Why PropLane · How we manage"
        id="how-title"
        wide
        title={
          <>
            Managed on the software
            <span className="site-accent">we use for our own homes.</span>
          </>
        }
        lede="Property management is mostly coordination: tenants, vendors, owners, rent and repairs. We handle that coordination for you, in the same system we use to run our own homes."
        actions={
          <div className="flex flex-col items-center gap-6">
            <WhySubnav active="how-we-manage" />
            <div className="flex flex-wrap items-center justify-center gap-3.5">
              <Link href={MANAGED_CONTACT_HREF} data-attr="how-talk" className={SITE_BTN_PRIMARY}>
                Talk to us
              </Link>
              <Link href={MANAGED_SERVICE_HREF} data-attr="how-service" className={SITE_BTN_SECONDARY}>
                See the managed service
              </Link>
            </div>
          </div>
        }
      />

      <ManagedIncludesGrid id="how-includes-title" />

      <SiteSection ariaLabelledBy="how-principles-title">
        <div className="mx-auto mb-10 flex max-w-[48rem] flex-col items-center text-center">
          <SiteEyebrow className="mb-3">How we work</SiteEyebrow>
          <SiteHeading id="how-principles-title">Four rules we run by.</SiteHeading>
        </div>
        <ul className="grid gap-4 md:grid-cols-2">
          {PRINCIPLES.map((p, i) => (
            <li key={p.title} className={cn(CARD, "p-6")}>
              <p className="text-[12px] font-extrabold tracking-[0.14em] text-[#1a47bd]">{String(i + 1).padStart(2, "0")}</p>
              <h3 className="mt-2 text-[18px] font-bold tracking-tight text-foreground">{p.title}</h3>
              <p className="mt-2 text-[14.5px] leading-relaxed text-muted">{p.copy}</p>
            </li>
          ))}
        </ul>
      </SiteSection>

      <ManagedHowItWorks id="how-steps-title" />

      <SiteFinalCta
        title="Tell us about your home."
        primaryAttr="how-closing-talk"
        secondaryAttr="how-closing-track-record"
        primaryHref={MANAGED_CONTACT_HREF}
        primaryLabel="Talk to us"
        secondaryHref="/#service"
        secondaryLabel="Our track record"
      />
    </SitePage>
  );
}
