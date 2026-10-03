/** Shared renter CTA copy on public listing surfaces (browsers, modals, sidebars). */

/**
 * Every listing is application first (captain, Oct 3 2026), so every surface says "Apply". The
 * `signingOrder` argument is accepted and ignored so older call sites keep compiling.
 */
export function listingApplyLabel(textEnabled: boolean, _signingOrder?: "application_first" | null): string {
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
 * existing short-stay gate, `propertyAllowsShortTermRental`). Always "Apply".
 */
export function listingTermCtas(opts: {
  shortStayOffered: boolean;
  signingOrder?: "application_first" | null;
}): ListingTermCta[] {
  const verb = "Apply";
  const ctas: ListingTermCta[] = [
    { id: "apply-long-term", label: `${verb} long term`, rentalType: "standard", dataAttr: "listing-web-apply" },
  ];
  if (opts.shortStayOffered) {
    ctas.push({ id: "apply-short-term", label: `${verb} short term`, rentalType: "short_term", dataAttr: "listing-web-apply-short" });
  }
  return ctas;
}
