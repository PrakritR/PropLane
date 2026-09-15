import type { Metadata } from "next";
import Link from "next/link";

import { SupportFaq } from "./support-faq";
import {
  MarketingHero,
  MarketingPageShell,
  MarketingSection,
} from "@/components/marketing/marketing-page-shell";
import {
  PUBLIC_SUPPORT_ADDRESS_LINE,
  PUBLIC_SUPPORT_EMAIL,
  PUBLIC_SUPPORT_PHONE_DISPLAY,
  PUBLIC_SUPPORT_PHONE_TEL,
} from "@/lib/marketing/public-contact";

export const metadata: Metadata = {
  title: "Help & Support",
  description:
    "Get help with PropLane: contact our team, find answers for residents and property managers, and learn how to reach support.",
};

export default function SupportPage() {
  return (
    <MarketingPageShell>
      <MarketingHero title="Help & Support" />

      <MarketingSection>
        <div className="lp-page-grid-3">
          <ContactCard
            href={`mailto:${PUBLIC_SUPPORT_EMAIL}`}
            label="Email us"
            value={PUBLIC_SUPPORT_EMAIL}
          />
          <ContactCard
            href={`tel:${PUBLIC_SUPPORT_PHONE_TEL}`}
            label="Call us"
            value={PUBLIC_SUPPORT_PHONE_DISPLAY}
          />
          <ContactCard href="/contact" label="Send a message" value="Contact form" internal />
        </div>
      </MarketingSection>

      <MarketingSection narrow>
        <div className="prose-policy text-[var(--lp-muted)]">
          <SupportFaq />
        </div>
      </MarketingSection>

      <MarketingSection narrow>
        <h2>Still need help?</h2>
        <p className="lp-section-lede lp-full">
          Email{" "}
          <a
            href={`mailto:${PUBLIC_SUPPORT_EMAIL}`}
            className="font-medium text-[var(--lp-blue)] hover:opacity-90"
          >
            {PUBLIC_SUPPORT_EMAIL}
          </a>{" "}
          or call {PUBLIC_SUPPORT_PHONE_DISPLAY}. Residents with lease or payment questions should
          also message their manager in the resident portal.
        </p>
        <p className="mt-4 text-[13px] text-[color-mix(in_srgb,var(--lp-muted)_80%,transparent)]">
          See also our{" "}
          <Link href="/privacy" className="font-medium text-[var(--lp-blue)] hover:opacity-90">
            Privacy Policy
          </Link>{" "}
          and{" "}
          <Link href="/tos" className="font-medium text-[var(--lp-blue)] hover:opacity-90">
            Terms of Service
          </Link>
          .
        </p>
        <address className="mt-6 text-[15px] not-italic leading-relaxed text-[var(--lp-muted)]">
          PropLane
          <br />
          {PUBLIC_SUPPORT_ADDRESS_LINE}
          <br />
          United States
        </address>
      </MarketingSection>
    </MarketingPageShell>
  );
}

function ContactCard({
  href,
  label,
  value,
  internal = false,
}: {
  href: string;
  label: string;
  value: string;
  internal?: boolean;
}) {
  const className =
    "lp-page-card lp-page-card-pad group flex flex-col gap-2 transition-colors hover:border-[color-mix(in_srgb,var(--lp-blue)_40%,transparent)]";
  const inner = (
    <>
      <span className="text-[11px] font-semibold uppercase tracking-[0.14em] text-[var(--lp-muted)]">
        {label}
      </span>
      <span className="break-words text-[15px] font-medium text-[var(--lp-ink)] transition-colors group-hover:text-[var(--lp-blue)]">
        {value}
      </span>
    </>
  );

  if (internal) {
    return (
      <Link href={href} className={className}>
        {inner}
      </Link>
    );
  }
  return (
    <a href={href} className={className}>
      {inner}
    </a>
  );
}
