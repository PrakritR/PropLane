"use client";

import type { MockProperty } from "@/data/types";
import { buildListingEmailDeepLink, isListingCtaEmailEnabled } from "@/lib/listing-cta-email";

/**
 * The manager's leasing email, the one contact door a listing prints. Its number is never drawn on a /rent page
 * (captain, Oct 20: the website runs through the portal, texting through the text line); the email comes from the
 * listing's own server-resolved contact field, never `profiles.email`, and is null when the manager has none.
 */
export function listingContactRows(property: Pick<MockProperty, "buildingName" | "title" | "address" | "contactWorkEmail">) {
  const propertyLabel = property.buildingName?.trim() || property.title?.trim() || property.address?.trim() || null;
  const emailHref = isListingCtaEmailEnabled(property.contactWorkEmail)
    ? buildListingEmailDeepLink({ intent: "tour", propertyLabel, toEmail: property.contactWorkEmail })
    : null;
  return { email: emailHref && emailHref !== "#" ? { href: emailHref } : null };
}

/**
 * The listing's primary action button — shared with the price card and the short-stay block so a renter sees ONE
 * control style for tour, apply and request to book (captain, 3009).
 */
export const listingPrimaryCtaClass =
  "btn-cobalt flex min-h-[48px] w-full items-center justify-center rounded-full px-5 py-3 text-sm font-semibold outline-none transition hover:-translate-y-[1px] active:translate-y-0";
