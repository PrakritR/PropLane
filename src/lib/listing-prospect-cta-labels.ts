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

/**
 * The listing card's term doors are gone (captain, Oct 12): the price card's Monthly | Short stay
 * segmented control is the choice, and each segment carries its own single primary. Nothing here builds
 * an "Apply long term / Apply short term" pair any more.
 */
