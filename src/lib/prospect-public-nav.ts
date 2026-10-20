import { buildPropertyMessageHref, buildTourContactHref } from "@/lib/manager-property-links";
import { buildRentalApplyHref, type RentalApplyFromListingParams } from "@/lib/rental-application/apply-from-listing";
import { residentPortalApplyReturnPath } from "@/lib/rental-application/public-apply-session";
import { residentListingManagerMessageDraft } from "@/lib/resident-manager-message-draft";
import { residentCreateAccountHref } from "@/lib/resident-public-nav";
import { stageResidentComposePrefill } from "@/lib/resident-compose-prefill";

/** In-portal tour scheduling for a known listing. */
export function residentPortalTourSchedulePath(propertyId: string): string {
  const pid = propertyId.trim();
  if (!pid) return "/resident/tour/schedule";
  return `/resident/tour/schedule?propertyId=${encodeURIComponent(pid)}`;
}

/** In-portal Communication with compose staged for a listing question. */
export function residentPortalListingMessagePath(propertyId: string): string {
  const pid = propertyId.trim();
  if (!pid) return "/resident/communication/active";
  return `/resident/communication/active?propertyId=${encodeURIComponent(pid)}&compose=1`;
}

export function stageResidentListingMessageCompose(propertyId: string): void {
  const pid = propertyId.trim();
  if (!pid) return;
  stageResidentComposePrefill(residentListingManagerMessageDraft(pid));
}

export function buildProspectApplyHref(
  params: RentalApplyFromListingParams,
  auth: { ready: boolean; userId: string | null; hasResidentRole: boolean },
): string {
  const step = residentPortalApplyReturnPath({
    propertyId: params.propertyId,
    rentalType: params.rentalType,
    listingRoomId: params.listingRoomId,
    bundleId: params.bundleId,
  });
  if (auth.ready && auth.userId && auth.hasResidentRole) return step;
  // A listing's action buttons make a resident account first, then land on the step (captain, Oct 20): the
  // web flow stays, behind the account. Texting is the other path ("Text us"), with no account at all.
  return params.propertyId?.trim() ? residentCreateAccountHref(step) : buildRentalApplyHref(params);
}

/**
 * `applicationFirst` = the property's workspace requires an application before a tour. A visitor
 * who is not a signed-in resident is sent to apply (the account gate sits in front of it); a
 * signed-in resident goes to the Tour flow, which checks their own applications on the server and
 * sends them to apply when they have none.
 */
export function buildProspectTourHref(
  propertyId: string,
  auth: { ready: boolean; userId: string | null; hasResidentRole: boolean },
  opts?: { applicationFirst?: boolean },
): string {
  const pid = propertyId.trim();
  if (opts?.applicationFirst && pid && !(auth.ready && auth.userId && auth.hasResidentRole)) {
    return buildProspectApplyHref({ propertyId: pid }, auth);
  }
  if (auth.ready && auth.userId && auth.hasResidentRole) {
    return residentPortalTourSchedulePath(pid);
  }
  // Same as apply: a resident account first, then the tour scheduler for this home.
  return pid ? residentCreateAccountHref(residentPortalTourSchedulePath(pid)) : buildTourContactHref(pid);
}

/**
 * Short stay "Request to book" for a visitor without a resident account: make one, then come back to this listing's
 * booking card with the picks still in place (`ShortStayProvider` reads them from the URL).
 */
export function buildProspectBookHref(
  propertyId: string,
  picks: { roomId?: string | null; checkIn?: string | null; checkOut?: string | null; guests?: number | null; arrival?: string | null },
): string {
  const q = new URLSearchParams({ stay: "1" });
  if (picks.checkIn) q.set("checkIn", picks.checkIn);
  if (picks.checkOut) q.set("checkOut", picks.checkOut);
  if (picks.roomId) q.set("room", picks.roomId);
  if (picks.guests && picks.guests > 1) q.set("guests", String(picks.guests));
  if (picks.arrival) q.set("arrive", picks.arrival);
  return residentCreateAccountHref(`/rent/listings/${encodeURIComponent(propertyId.trim())}?${q.toString()}`);
}

export function buildProspectMessageHref(
  propertyId: string,
  auth: { ready: boolean; userId: string | null; hasResidentRole: boolean },
): string {
  const pid = propertyId.trim();
  if (auth.ready && auth.userId && auth.hasResidentRole) {
    return residentPortalListingMessagePath(pid);
  }
  return buildPropertyMessageHref(pid);
}
