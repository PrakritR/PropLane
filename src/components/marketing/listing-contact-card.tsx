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

/** How a Text us draft names the home: its street address ("4709A 8th Ave"), else its building name or title. */
export function listingTextUsLabel(property: Pick<MockProperty, "buildingName" | "title" | "address">): string {
  return property.address?.split(",")[0]?.trim() || property.buildingName?.trim() || property.title?.trim() || "";
}

/**
 * The listing's action pills — shared with the price card and sticky bar so a
 * renter sees ONE control for tour, apply, text and email (captain, 3009).
 */
export const listingPrimaryCtaClass =
  "btn-cobalt flex min-h-[48px] w-full items-center justify-center rounded-full px-5 py-3 text-sm font-semibold outline-none transition hover:-translate-y-[1px] active:translate-y-0";
export const listingSecondaryCtaClass =
  "btn-metallic flex min-h-[48px] w-full items-center justify-center rounded-full px-5 py-3 text-sm font-semibold text-foreground outline-none transition hover:-translate-y-[1px] active:translate-y-0";

/** The card's tertiary door: the work number as a plain text link under the buttons. */
export const listingTextLinkClass =
  "mt-3 flex min-h-[44px] items-center justify-center text-sm font-semibold text-primary tabular-nums outline-none hover:underline focus-visible:underline";
