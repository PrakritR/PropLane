import {
  normalizeManagerListingSubmissionV1,
  type ManagerListingSubmissionV1,
} from "@/lib/manager-listing-submission";

/** True when any room is explicitly priced for this property (not workspace default fill). */
export function propertyHasOwnRoomPricing(sub: ManagerListingSubmissionV1): boolean {
  const n = normalizeManagerListingSubmissionV1(sub);
  const meta = n.roomPricingMeta ?? {};
  return Object.values(meta).some(
    (m) => m?.priceSource === "own" || Boolean(m?.copyFromRoomIdByTerm && Object.keys(m.copyFromRoomIdByTerm).length),
  );
}

export function countPropertiesWithOwnPricing(subs: ManagerListingSubmissionV1[]): number {
  return subs.filter(propertyHasOwnRoomPricing).length;
}
