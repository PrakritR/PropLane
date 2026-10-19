import Link from "next/link";
import { Mail, MessageSquareText } from "lucide-react";
import {
  MANAGED_INCLUDES,
  MANAGED_SERVICE_HREF,
  MANAGED_STEPS,
} from "@/lib/marketing/managed-service";
import { PUBLIC_SUPPORT_EMAIL } from "@/lib/marketing/public-contact";
import { getPublicTextingConfig } from "@/lib/marketing/public-texting.server";
import { ManagedServiceForm } from "@/components/marketing/site/managed-service-form";
import { SiteEyebrow, SiteHeading, SiteLede, SiteSection } from "@/components/marketing/site/primitives";
import { cn } from "@/lib/utils";

const CARD = "rounded-2xl border border-[#dbe4ef] bg-white/85 shadow-[0_18px_44px_-30px_rgba(19,43,71,0.3)]";

/** Software | Managed service as two real links, so each tab is a URL a visitor can share. */
export function PricingTabs({ active, tabHrefs }: { active: "software" | "service"; tabHrefs?: { software: string; service: string } }) {
  const hrefs = tabHrefs ?? { software: "/pricing", service: MANAGED_SERVICE_HREF };
  const pill = (on: boolean) =>
    cn(
      "inline-flex min-h-[40px] items-center rounded-full px-5 text-[13.5px] font-bold transition-colors",
      on ? "bg-card text-foreground shadow-[var(--shadow-sm)]" : "text-muted hover:text-foreground",
    );
  return (
    <nav
      aria-label="Pricing"
      className="inline-flex items-center gap-1 rounded-full border border-border bg-[var(--pl-surface-muted)] p-1 [html[data-theme=dark]_&]:bg-white/[0.04]"
    >
      <Link href={hrefs.software} scroll={false} data-attr="pricing-tab-software" aria-current={active === "software" ? "page" : undefined} className={pill(active === "software")}>
        Software
      </Link>
      <Link href={hrefs.service} scroll={false} data-attr="pricing-tab-service" aria-current={active === "service" ? "page" : undefined} className={pill(active === "service")}>
        Managed service
      </Link>
    </nav>
  );
}

/** Three numbered steps, left to right on a desktop and top to bottom on a phone. */
export function ManagedHowItWorks({ id = "managed-how-title" }: { id?: string }) {
  return (
    <SiteSection ariaLabelledBy={id}>
      <div className="mx-auto mb-10 flex max-w-[48rem] flex-col items-center text-center">
        <SiteEyebrow className="mb-3">How it works</SiteEyebrow>
        <SiteHeading id={id}>Three steps, and the first is a form.</SiteHeading>
      </div>
      <ol className="grid gap-4 md:grid-cols-3">
        {MANAGED_STEPS.map((s, i) => (
          <li key={s.id} className={cn(CARD, "p-6")}>
            <span className="grid h-9 w-9 place-items-center rounded-full bg-[#1769bd] text-[15px] font-bold text-white">{i + 1}</span>
            <h3 className="mt-4 text-[18px] font-bold tracking-tight text-foreground">{s.title}</h3>
            <p className="mt-2 text-[14.5px] leading-relaxed text-muted">{s.copy}</p>
          </li>
        ))}
      </ol>
    </SiteSection>
  );
}

/** The six inclusions as a grid of cards (the long-form page). */
export function ManagedIncludesGrid({ id = "managed-includes-title" }: { id?: string }) {
  return (
    <SiteSection ariaLabelledBy={id}>
      <div className="mx-auto mb-10 flex max-w-[48rem] flex-col items-center text-center">
        <SiteEyebrow className="mb-3">What is included</SiteEyebrow>
        <SiteHeading id={id}>
          Everything a home needs.
          <span className="site-accent block">Handled.</span>
        </SiteHeading>
      </div>
      <ul className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
        {MANAGED_INCLUDES.map((f) => (
          <li key={f.id} className={cn(CARD, "p-6")}>
            <h3 className="text-[17px] font-bold tracking-tight text-foreground">{f.title}</h3>
            <p className="mt-2 text-[14.5px] leading-relaxed text-muted">{f.copy}</p>
          </li>
        ))}
      </ul>
    </SiteSection>
  );
}

/** "Talk to us": the form, email and the configured shared SMS line. Anchor `#talk`. */
export async function ManagedTalkSection({ headingId = "managed-talk-title", showFullPageLink = false }: { headingId?: string; showFullPageLink?: boolean }) {
  const texting = await getPublicTextingConfig();
  return (
    <SiteSection id="talk" ariaLabelledBy={headingId} className="scroll-mt-20">
      <div className="grid items-start gap-10 lg:grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)] lg:gap-16">
        <div>
          <SiteEyebrow className="mb-3">Talk to us</SiteEyebrow>
          <SiteHeading id={headingId}>
            Tell us about your home.
            <span className="site-accent block">We will tell you what we would do.</span>
          </SiteHeading>
          <SiteLede className="mt-4">
            The form starts a conversation, not a contract. We reply by email, and there is no price list because each home is quoted on its own.
          </SiteLede>
          <ul className="mt-8 space-y-3 text-[15px]">
            {texting.phone && texting.smsHref ? (
              <li>
                <a href={texting.smsHref} data-attr="managed-talk-phone" className="inline-flex items-center gap-3 font-semibold text-foreground hover:text-primary">
                  <MessageSquareText className="h-[18px] w-[18px] text-primary" strokeWidth={2} aria-hidden />
                  <span>Text PropLane <span className="tabular-nums">{texting.phone}</span></span>
                </a>
              </li>
            ) : null}
            <li>
              <a href={`mailto:${PUBLIC_SUPPORT_EMAIL}`} data-attr="managed-talk-email" className="inline-flex items-center gap-3 font-semibold text-foreground hover:text-primary">
                <Mail className="h-[18px] w-[18px] text-primary" strokeWidth={2} aria-hidden />
                {PUBLIC_SUPPORT_EMAIL}
              </a>
            </li>
          </ul>
          {showFullPageLink ? (
            <p className="mt-6">
              <Link href={MANAGED_SERVICE_HREF} data-attr="managed-talk-full-page" className="text-[15px] font-bold text-primary hover:underline">
                Read how PropLane Managed works →
              </Link>
            </p>
          ) : null}
        </div>
        <ManagedServiceForm />
      </div>
    </SiteSection>
  );
}
