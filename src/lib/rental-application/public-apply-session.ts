import { buildPortfolioApplyHref } from "@/lib/manager-property-links";

/** Session key for the account gate — one property id or a sorted portfolio token. */
export function publicApplyGateKey(input: {
  propertyId?: string;
  portfolioPropertyIds?: readonly string[];
}): string {
  const pid = input.propertyId?.trim();
  if (pid) return pid;
  const ids = [
    ...new Set((input.portfolioPropertyIds ?? []).map((id) => id.trim()).filter(Boolean)),
  ].sort();
  if (ids.length > 0) return `portfolio:${ids.join(",")}`;
  return "";
}

/** In-portal apply URL — canonical return target after sign-in / create-account. */
export function residentPortalApplyReturnPath(input: {
  propertyId?: string;
  rentalType?: "standard" | "short_term";
  listingRoomId?: string;
  bundleId?: string;
}): string {
  const pid = input.propertyId?.trim();
  if (!pid) return "/resident/applications/apply";
  const q = new URLSearchParams({ propertyId: pid });
  if (input.rentalType === "short_term") q.set("rentalType", "short_term");
  const roomId = input.listingRoomId?.trim();
  if (roomId) q.set("listingRoomId", roomId);
  const bundleId = input.bundleId?.trim();
  if (bundleId) q.set("bundle", bundleId);
  return `/resident/applications/apply?${q.toString()}`;
}

/** Return path after sign-in / create-account for a single listing or portfolio picker. */
export function publicApplyReturnPath(input: {
  propertyId?: string;
  portfolioPropertyIds?: readonly string[];
  rentalType?: "standard" | "short_term";
  listingRoomId?: string;
  bundleId?: string;
}): string {
  const pid = input.propertyId?.trim();
  if (pid) {
    return residentPortalApplyReturnPath({
      propertyId: pid,
      rentalType: input.rentalType,
      listingRoomId: input.listingRoomId,
      bundleId: input.bundleId,
    });
  }
  const ids = [
    ...new Set((input.portfolioPropertyIds ?? []).map((id) => id.trim()).filter(Boolean)),
  ].sort();
  if (ids.length > 0) {
    return buildPortfolioApplyHref(ids, {
      rentalType: input.rentalType === "short_term" ? "short_term" : undefined,
    });
  }
  return "/resident/applications/apply";
}

/**
 * A resident account is required to apply (PLAN-0924-1421) — there is no guest
 * path left to remember. Kept as a stub so a stale session key written before
 * the gate closed cannot reopen it.
 *
 * @deprecated Always false. Do not reintroduce a guest bypass.
 */
export function hasPublicApplyGuestContinue(gateKey: string): boolean {
  void gateKey;
  return false;
}

function publicApplyNext(propertyId: string): string {
  return publicApplyReturnPath({ propertyId });
}

export function publicApplySignInHref(gateKey: string, returnPath?: string): string {
  const next = returnPath?.trim() || publicApplyNext(gateKey);
  return `/auth/sign-in?intent=resident&next=${encodeURIComponent(next)}`;
}

/**
 * Create-account entry for a prospective resident. Carries the listing context so
 * signup lands them back on this application (in-portal apply), not a bare portal.
 */
export function publicApplyCreateAccountHref(gateKey: string, returnPath?: string): string {
  const next = returnPath?.trim() || publicApplyNext(gateKey);
  return `/auth/create-account?mode=create&role=resident&next=${encodeURIComponent(next)}`;
}

export type PublicApplyView = "account-prompt" | "signed-in-create-resident" | "wizard";

/**
 * Decide what the public apply surface renders when a property link is present:
 *
 *  - SIGNED OUT → the anonymous "Before you apply" account prompt (create an
 *    account or sign in), owned by the public-apply gate.
 *  - SIGNED IN but NOT a resident (a manager or vendor — residents are
 *    redirected to the portal apply flow before this surface mounts) → the
 *    "create your resident account" prompt: they add a separate resident
 *    account to their existing login and apply from the resident portal. This
 *    is the branch whose absence rendered a blank content area — a signed-in
 *    non-resident matched no case and saw nothing.
 *  - No property link, or a resume link from the applicant's own email → the
 *    wizard directly.
 *
 * An account is required (PLAN-0924-1421): nothing a visitor can click in the
 * prompt reaches the wizard without one.
 */
export function resolvePublicApplyView(input: {
  propertyId?: string;
  gateKey?: string;
  /** @deprecated Ignored — guest apply is gone. */
  guestContinue?: boolean;
  signedInNonResident: boolean;
  /** When true, the caller already holds the resident role — skip the account gate. */
  hasResidentRole?: boolean;
  /**
   * The applicant opened their own tokened resume link, so the draft they are
   * returning to is already theirs. Not a guest bypass — a signed link.
   */
  resumeFromEmailLink?: boolean;
}): PublicApplyView {
  const key = input.gateKey?.trim() || input.propertyId?.trim() || "";
  if (!key) return "wizard";
  if (input.resumeFromEmailLink) return "wizard";
  if (input.hasResidentRole) return "wizard";
  return input.signedInNonResident ? "signed-in-create-resident" : "account-prompt";
}
