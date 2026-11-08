import type { DemoApplicantRow } from "@/data/demo-portal";
import { isEntireHomeListing, normalizeManagerListingSubmissionV1, type ManagerListingSubmissionV1 } from "@/lib/manager-listing-submission";
import { parseRoomChoiceValue } from "@/lib/rental-application/room-choice-value";

/** Check that billing can resolve the exact placement, without treating zero rent as missing. */
export function approvalPlacementBlocker(row: DemoApplicantRow, raw: ManagerListingSubmissionV1 | null | undefined): string | null {
  const propertyId = row.assignedPropertyId?.trim() || row.propertyId?.trim() || row.application?.propertyId?.trim() || "";
  if (!propertyId) return "Assign a property before approving.";
  if (!raw || raw.v !== 1) return "Could not verify this property's pricing. Refresh and try again.";
  let sub: ManagerListingSubmissionV1;
  try { sub = normalizeManagerListingSubmissionV1(raw); } catch { return "Could not verify this property's pricing. Refresh and try again."; }
  const bundleId = row.application?.bundleId?.trim();
  if (bundleId) return (sub.bundles ?? []).some(bundle => bundle.id === bundleId) ? null : "Assign a valid bundle before approving.";
  const choice = row.assignedRoomChoice?.trim() || row.application?.roomChoice1?.trim() || "";
  const parsed = parseRoomChoiceValue(choice);
  if (choice && parsed.propertyId !== propertyId) return "The assigned room does not belong to this property.";
  if (parsed.listingRoomId) return sub.rooms.some(room => room.id === parsed.listingRoomId) ? null : "Assign a valid room before approving.";
  if (isEntireHomeListing(sub) || sub.rooms.length === 1) return null;
  return "Assign a room before approving.";
}
