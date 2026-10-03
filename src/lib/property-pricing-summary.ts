import {
  entireHomeMonthlyRentAmount,
  isEntireHomeListing,
  normalizeManagerListingSubmissionV1,
  type ManagerBundleRow,
  type ManagerListingSubmissionV1,
  type ManagerRoomSubmission,
  type RoomPricingUiMeta,
} from "@/lib/manager-listing-submission";
import { arrangementSummaryLine } from "@/lib/room-arrangement-pricing";
import { listingRoomPricingSummaryLabel } from "@/lib/rental-application/listing-fees-display";
import { normalizeRoomOccupancyCapacity } from "@/lib/rental-application/room-occupancy";
import { roomHeadlinePriceLabel } from "@/lib/room-pricing";
import { resolveRoomPricingCopyLabel } from "@/lib/property-pricing-room-copy";

export function roomPricingSourceLabel(meta: RoomPricingUiMeta | undefined): string | null {
  if (meta?.priceSource === "default") return "Workspace default";
  if (meta?.priceSource === "own") return "This property";
  return null;
}

/** One property Pricing row summary for a room (replica ps40 / C2-PR8). */
export function propertyPricingRoomSummary(
  room: ManagerRoomSubmission,
  sub: ManagerListingSubmissionV1,
  meta?: RoomPricingUiMeta,
): string {
  const normalized = normalizeManagerListingSubmissionV1(sub);
  const copy = resolveRoomPricingCopyLabel(normalized, room.id, "long_term");
  if (copy) return copy;
  const arrangement = arrangementSummaryLine(room);
  const base = listingRoomPricingSummaryLabel(room, normalized);
  if (arrangement && base) return `${arrangement} · ${base}`;
  return arrangement ?? base ?? "Rent not set";
}

export function propertyPricingRoomAmount(room: ManagerRoomSubmission): string {
  const label = roomHeadlinePriceLabel(room);
  return label && label !== "—" ? label : "—";
}

export function propertyPricingBundleSummary(bundle: ManagerBundleRow, sub: ManagerListingSubmissionV1): string {
  const n = Number(String(bundle.price ?? "").replace(/[^0-9.]/g, ""));
  const rent = Number.isFinite(n) && n > 0 ? `$${n.toLocaleString("en-US")}/mo` : "No price";
  const rooms = (bundle.includedRoomIds ?? [])
    .map((id) => sub.rooms.find((r) => r.id === id)?.name?.trim())
    .filter(Boolean);
  const place = rooms.length ? rooms.join(", ") : bundle.roomsLine?.trim() || bundle.label?.trim() || "Rooms";
  return `${place} · ${rent}`;
}

export function propertyPricingWholeHouseSummary(sub: ManagerListingSubmissionV1): string {
  const n = normalizeManagerListingSubmissionV1(sub);
  if (isEntireHomeListing(n)) {
    const rent = entireHomeMonthlyRentAmount(n);
    return rent > 0 ? `$${rent.toLocaleString("en-US")}/mo` : "Rent not set";
  }
  if (!n.entireHomeOffered) return "Not offered";
  const rent = entireHomeMonthlyRentAmount(n);
  return rent > 0 ? `$${rent.toLocaleString("en-US")}/mo` : "No price yet";
}

export function roomNeedsPrice(room: ManagerRoomSubmission): boolean {
  const cap = normalizeRoomOccupancyCapacity(room.occupancyCapacity);
  return !(room.monthlyRent > 0) && cap >= 1;
}
