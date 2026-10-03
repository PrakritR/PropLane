import { buildPropertyMessageHref, buildTourContactHref } from "@/lib/manager-property-links";
import { buildRentalApplyHref, type RentalApplyFromListingParams } from "@/lib/rental-application/apply-from-listing";
import { residentPortalApplyReturnPath } from "@/lib/rental-application/public-apply-session";
import { residentListingManagerMessageDraft } from "@/lib/resident-manager-message-draft";
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
  if (auth.ready && auth.userId && auth.hasResidentRole) {
    return residentPortalApplyReturnPath({
      propertyId: params.propertyId,
      rentalType: params.rentalType,
      listingRoomId: params.listingRoomId,
      bundleId: params.bundleId,
    });
  }
  return buildRentalApplyHref(params);
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
  if (auth.ready && auth.userId && auth.hasResidentRole) {
    return residentPortalTourSchedulePath(pid);
  }
  if (opts?.applicationFirst && pid) return buildProspectApplyHref({ propertyId: pid }, auth);
  return buildTourContactHref(pid);
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
