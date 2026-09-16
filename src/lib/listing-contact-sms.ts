import type { MockProperty } from "@/data/types";
import { listingCtaSmsPhone } from "@/lib/claw-leasing-links";
import { listingCtaEmailAddress } from "@/lib/listing-cta-email";

/**
 * Attach the resolved CTA number so a manager-side preview matches what the
 * public browse page will render.
 *
 * `null` CLEARS any number stored on the property rather than leaving it — the
 * stored blob is manager-editable, and a preview must show the same web
 * "Schedule a tour / apply online" fallback the public listing will get.
 */
export function withListingContactSmsPhone(
  property: MockProperty,
  contactSmsPhone: string | null | undefined,
): MockProperty {
  const phone = listingCtaSmsPhone(contactSmsPhone) ?? undefined;
  if (property.contactSmsPhone === phone) return property;
  return { ...property, contactSmsPhone: phone };
}

export function isLiveListingIdForContactSms(listingId: string | null | undefined): boolean {
  const id = listingId?.trim() ?? "";
  return Boolean(id && !id.startsWith("preview-") && !id.startsWith("demo-"));
}

/**
 * Same contract for the work email: `null` CLEARS any address stored on the
 * property. The stored blob could name anybody; only the server-resolved
 * work email is ever shown to a renter.
 */
export function withListingContactWorkEmail(
  property: MockProperty,
  contactWorkEmail: string | null | undefined,
): MockProperty {
  const email = listingCtaEmailAddress(contactWorkEmail) ?? undefined;
  if (property.contactWorkEmail === email) return property;
  return { ...property, contactWorkEmail: email };
}
