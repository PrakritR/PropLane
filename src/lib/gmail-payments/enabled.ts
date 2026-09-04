/**
 * Is Gmail payment-receipt matching switched on?
 *
 * OFF, deliberately, and in one place so it is one line to bring back.
 *
 * Two reasons, and either alone is enough:
 *
 * 1. **Google's restricted-scope tier.** `gmail.readonly` is classed RESTRICTED,
 *    not merely sensitive, so an app requesting it needs OAuth verification PLUS
 *    an annual third-party security assessment (CASA) before Google stops
 *    showing the unverified-app interstitial. Calendar's `calendar.events` is
 *    only sensitive — ordinary verification, no assessment. Dropping this one
 *    scope moves PropLane out of the expensive tier entirely (PRP-130).
 * 2. **Zelle and Venmo are coming out of the product**, to be tracked by hand.
 *    Reading receipt emails to match them automatically has nothing left to
 *    match.
 *
 * Everything behind the flag is left INTACT rather than deleted: the sync, the
 * parsers and the stored connections all still exist, so turning it back on is
 * flipping this constant, not rebuilding a feature. What the flag guarantees is
 * that no code path can ask a manager for the scope while it is false.
 */
export const GMAIL_PAYMENTS_ENABLED = false;

/** Message shown wherever the disabled feature is still reachable by URL. */
export const GMAIL_PAYMENTS_DISABLED_REASON =
  "Gmail payment tracking is turned off. Zelle and Venmo payments are recorded by hand for now.";
