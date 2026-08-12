import { buildPortfolioApplyHref } from "@/lib/manager-property-links";

const GUEST_CONTINUE_PREFIX = "proplane_apply_guest_continue:";

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

/** Remember that the applicant chose to apply without signing in (per gate key). */
export function markPublicApplyGuestContinue(gateKey: string): void {
  if (typeof window === "undefined") return;
  const key = gateKey.trim();
  if (!key) return;
  try {
    window.sessionStorage.setItem(`${GUEST_CONTINUE_PREFIX}${key}`, "1");
  } catch {
    /* ignore */
  }
}

export function hasPublicApplyGuestContinue(gateKey: string): boolean {
  if (typeof window === "undefined") return false;
  const key = gateKey.trim();
  if (!key) return false;
  try {
    return window.sessionStorage.getItem(`${GUEST_CONTINUE_PREFIX}${key}`) === "1";
  } catch {
    return false;
  }
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
 *  - SIGNED OUT → the anonymous "Before you apply" account prompt (sign in /
 *    continue as guest), owned by the public-apply gate.
 *  - SIGNED IN but NOT a resident (a manager or vendor — residents are
 *    redirected to the portal apply flow before this surface mounts) → the
 *    "create your resident account" prompt: they add a separate resident
 *    account to their existing login and apply from the resident portal. This
 *    is the branch whose absence rendered a blank content area — a signed-in
 *    non-resident matched no case and saw nothing.
 *  - GUEST chosen, or no property link → the wizard directly.
 */
export function resolvePublicApplyView(input: {
  propertyId?: string;
  gateKey?: string;
  guestContinue: boolean;
  signedInNonResident: boolean;
  /** When true, the caller already holds the resident role — skip the account gate. */
  hasResidentRole?: boolean;
}): PublicApplyView {
  const key = input.gateKey?.trim() || input.propertyId?.trim() || "";
  const gateInPlay = Boolean(key) && !input.guestContinue;
  if (!gateInPlay) return "wizard";
  if (input.hasResidentRole) return "wizard";
  return input.signedInNonResident ? "signed-in-create-resident" : "account-prompt";
}
