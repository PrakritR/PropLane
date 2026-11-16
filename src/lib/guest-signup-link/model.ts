import { PERSONAL_LINK_LANDING_PATH, personalLinkTargetId, parsePersonalLinkTarget } from "@/lib/personal-link/model";
import { residentPortalApplyReturnPath } from "@/lib/rental-application/public-apply-session";

/**
 * Guest sign-in link, pure half (captain, Nov 14: "applyings etc need to ideally create accounts but also have the
 * link system that goes through sms"). A renter who applied or booked a tour with NO account can ask for a texted link.
 * It is the existing phone-bound `account` link (hash only, single use, short-lived) with a different `target_type`:
 * opening it on the phone IS the proof of that phone, the way the emailed `token_hash` link is the proof of a mailbox.
 *
 * The link names a workspace and a home (apply) or a tour inquiry (tour) and the phone it was texted to. It never
 * carries the application, a name or an email.
 */
export const GUEST_APPLY_LINK_TARGET = "guest_apply";
export const GUEST_TOUR_LINK_TARGET = "guest_tour";
export type GuestSignupLinkKind = "apply" | "tour";

/** A texted link lives two hours: long enough to find the phone, short enough to be a poor thing to steal. */
export const GUEST_SIGNUP_LINK_TTL_MS = 2 * 60 * 60 * 1000;

export function isGuestSignupTarget(targetType: string): boolean {
  return targetType === GUEST_APPLY_LINK_TARGET || targetType === GUEST_TOUR_LINK_TARGET;
}

export function guestSignupTargetType(kind: GuestSignupLinkKind): string {
  return kind === "tour" ? GUEST_TOUR_LINK_TARGET : GUEST_APPLY_LINK_TARGET;
}

/** `<workspace>:<property id>` for an apply link, `<workspace>:<tour inquiry id>` for a tour link. */
export function guestSignupTargetId(workspaceId: string, subjectId: string): string {
  return personalLinkTargetId(workspaceId, subjectId);
}

export function parseGuestSignupTarget(targetId: string): { workspaceId: string; subjectId: string | null } | null {
  const parsed = parsePersonalLinkTarget(targetId);
  return parsed ? { workspaceId: parsed.workspaceId, subjectId: parsed.propertyId } : null;
}

/** Where the renter lands once the account exists. The apply page claims the held draft and submits it. */
export function guestSignupLandingPath(kind: GuestSignupLinkKind, subjectId: string, opts: { rentalType?: "short_term" } = {}): string {
  if (kind === "tour") return "/resident/tour";
  return subjectId ? residentPortalApplyReturnPath({ propertyId: subjectId, rentalType: opts.rentalType }) : PERSONAL_LINK_LANDING_PATH;
}

export function guestSignupTextBody(kind: GuestSignupLinkKind, homeLabel: string, url: string): string {
  const home = homeLabel.trim().slice(0, 60);
  const what = kind === "tour" ? "see your tour" : "finish your application";
  return `PropLane: tap to ${what}${home ? ` for ${home}` : ""}. The link works once and expires in 2 hours.\n${url}`;
}
