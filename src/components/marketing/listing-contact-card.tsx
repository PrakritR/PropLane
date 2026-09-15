"use client";

import type { MockProperty } from "@/data/types";
import { buildSmsDeepLink, isClawMessagingPubliclyEnabled } from "@/lib/claw-leasing-links";
import { buildListingEmailDeepLink, isListingCtaEmailEnabled } from "@/lib/listing-cta-email";
import { formatSmsPhoneLabel, normalizeE164 } from "@/lib/phone-e164";

/**
 * The manager's two doors, printed once per viewport (PLAN-0914-2124): the
 * work number as a real, tappable number and the leasing email. Both come
 * from the listing's own server-resolved contact fields — never a manager's
 * private phone or `profiles.email` — and a row simply does not render when
 * the manager has no such door, exactly as the old Text / Email buttons did.
 */
export function listingContactRows(property: Pick<MockProperty, "id" | "buildingName" | "title" | "address" | "contactSmsPhone" | "contactWorkEmail">) {
  const propertyLabel = property.buildingName?.trim() || property.title?.trim() || property.address?.trim() || null;
  const phoneEnabled = isClawMessagingPubliclyEnabled(property.contactSmsPhone);
  const phoneLabel = phoneEnabled ? formatSmsPhoneLabel(property.contactSmsPhone) : null;
  const phoneE164 = phoneEnabled ? normalizeE164(property.contactSmsPhone ?? "") : null;
  const smsHref = phoneEnabled
    ? buildSmsDeepLink({ intent: "tour", propertyId: property.id, propertyLabel, toPhone: property.contactSmsPhone })
    : null;
  const emailHref = isListingCtaEmailEnabled(property.contactWorkEmail)
    ? buildListingEmailDeepLink({ intent: "tour", propertyLabel, toEmail: property.contactWorkEmail })
    : null;
  return {
    phone: phoneLabel && smsHref ? { label: phoneLabel, smsHref, telHref: phoneE164 ? `tel:${phoneE164}` : null } : null,
    email: emailHref && emailHref !== "#" ? { href: emailHref } : null,
  };
}

/**
 * The listing's action pills — shared with the price card and sticky bar so a
 * renter sees ONE control for tour, apply, text and email (captain, 3009).
 */
export const listingPrimaryCtaClass =
  "btn-cobalt flex min-h-[48px] w-full items-center justify-center rounded-full px-5 py-3 text-sm font-semibold outline-none transition hover:-translate-y-[1px] active:translate-y-0";
export const listingSecondaryCtaClass =
  "btn-metallic flex min-h-[48px] w-full items-center justify-center rounded-full px-5 py-3 text-sm font-semibold text-foreground outline-none transition hover:-translate-y-[1px] active:translate-y-0";

/**
 * Text and Email as the same secondary pill as Apply, stacked with the same
 * gap. No card, no trailing link word, no Call row.
 */
export function ListingContactCard({
  property,
  className = "",
}: {
  property: Pick<MockProperty, "id" | "buildingName" | "title" | "address" | "contactSmsPhone" | "contactWorkEmail">;
  className?: string;
}) {
  const rows = listingContactRows(property);
  if (!rows.phone && !rows.email) return null;
  return (
    <div className={`space-y-2.5 ${className}`} data-attr="listing-contact-card">
      {rows.phone ? (
        <a href={rows.phone.smsHref} className={listingSecondaryCtaClass} data-attr="listing-text-tour">
          <span className="tabular-nums">Text {rows.phone.label}</span>
        </a>
      ) : null}
      {rows.email ? (
        <a href={rows.email.href} className={listingSecondaryCtaClass} data-attr="listing-email-tour">
          Email the manager
        </a>
      ) : null}
    </div>
  );
}
