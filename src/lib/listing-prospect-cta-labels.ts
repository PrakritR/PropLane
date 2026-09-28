/** Shared renter CTA copy on public listing surfaces (browsers, modals, sidebars). */

/**
 * `signingOrder` is the listing's resolved leasing-pipeline order
 * (`publicListingProjection`'s `signingOrder` field, PLAN-0927): when the
 * lease is signed before an application, every "Apply" surface says "Sign
 * lease" instead — the CTA still opens the same apply flow, which begins with
 * the lease-signing step for a lease-first listing.
 */
export function listingApplyLabel(textEnabled: boolean, signingOrder?: "application_first" | "lease_first" | null): string {
  if (signingOrder === "lease_first") return textEnabled ? "Text to sign lease" : "Sign lease";
  return textEnabled ? "Text to apply" : "Apply online";
}

export function listingMessageLabel(textEnabled: boolean): string {
  return textEnabled ? "Text a message" : "Send message";
}
