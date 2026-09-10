"use client";

import { buildSmsDeepLink, isClawMessagingPubliclyEnabled } from "@/lib/claw-leasing-links";
import { buildListingEmailDeepLink, isListingCtaEmailEnabled } from "@/lib/listing-cta-email";

const ctaBase =
  "inline-flex min-h-[48px] w-full items-center justify-center rounded-full px-5 py-3 text-sm font-semibold transition sm:w-auto";

export function PropertyDetailActions({
  propertyId,
  propertyLabel,
  contactSmsPhone,
  contactWorkEmail,
}: {
  propertyId: string;
  propertyLabel?: string;
  contactSmsPhone?: string | null;
  contactWorkEmail?: string | null;
}) {
  const textEnabled = isClawMessagingPubliclyEnabled(contactSmsPhone);
  const textTourHref = textEnabled
    ? buildSmsDeepLink({ intent: "tour", propertyId, propertyLabel, toPhone: contactSmsPhone })
    : null;
  const textApplyHref = textEnabled
    ? buildSmsDeepLink({ intent: "apply", propertyId, propertyLabel, toPhone: contactSmsPhone })
    : null;

  // Same rule as the text links: rendered only for a live, server-resolved work
  // email, so there is never a dead mailto:.
  const emailHref = isListingCtaEmailEnabled(contactWorkEmail)
    ? buildListingEmailDeepLink({ intent: "tour", propertyLabel, toEmail: contactWorkEmail })
    : null;

  if (!textTourHref && !textApplyHref && !emailHref) return null;

  return (
    <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
      {textTourHref ? (
        <a
          href={textTourHref}
          data-attr="listing-text-tour"
          className={`${ctaBase} border border-border bg-card text-foreground hover:bg-accent/30`}
        >
          Text to tour
        </a>
      ) : null}
      {textApplyHref ? (
        <a
          href={textApplyHref}
          data-attr="listing-text-apply"
          className={`${ctaBase} bg-primary text-primary-foreground shadow-[0_4px_20px_rgba(47,107,255,0.28)] hover:opacity-95`}
        >
          Text to apply
        </a>
      ) : null}
      {emailHref ? (
        <a
          href={emailHref}
          data-attr="listing-email-tour"
          className={`${ctaBase} border border-border bg-card text-foreground hover:bg-accent/30`}
        >
          Email to tour
        </a>
      ) : null}
    </div>
  );
}
