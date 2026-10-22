import type { MockProperty } from "@/data/types";
import { listingCtaEmailAddress } from "@/lib/listing-cta-email";

/**
 * A listing id that names a STORED home, rather than a wizard draft or a demo row: only those have a public
 * payload to read a contact from.
 */
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
