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

export type ListingTermCta = {
  id: "apply-long-term" | "apply-short-term";
  label: string;
  /** `short_term` selects the short-term application and lease templates. */
  rentalType: "standard" | "short_term";
  dataAttr: string;
};

/**
 * The listing side card's two term doors (captain, Oct 3): "Apply long term"
 * always, "Apply short term" only when the listing offers short stays (the
 * existing short-stay gate, `propertyAllowsShortTermRental`). A lease-first
 * listing keeps its "Sign lease" wording for both, since the flow they open
 * begins with the lease.
 */
export function listingTermCtas(opts: {
  shortStayOffered: boolean;
  signingOrder?: "application_first" | "lease_first" | null;
}): ListingTermCta[] {
  const verb = opts.signingOrder === "lease_first" ? "Sign lease" : "Apply";
  const ctas: ListingTermCta[] = [
    { id: "apply-long-term", label: `${verb} long term`, rentalType: "standard", dataAttr: "listing-web-apply" },
  ];
  if (opts.shortStayOffered) {
    ctas.push({ id: "apply-short-term", label: `${verb} short term`, rentalType: "short_term", dataAttr: "listing-web-apply-short" });
  }
  return ctas;
}
