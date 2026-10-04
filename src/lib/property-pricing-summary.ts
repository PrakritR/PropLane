import {
  entireHomeMonthlyRentAmount,
  isEntireHomeListing,
  normalizeManagerListingSubmissionV1,
  resolveAllowedLeaseTerms,
  type ManagerBundleRow,
  type ManagerListingSubmissionV1,
  type ManagerRoomSubmission,
  type RoomPricingUiMeta,
} from "@/lib/manager-listing-submission";
import { arrangementSummaryLine } from "@/lib/room-arrangement-pricing";
import { listingRoomPricingSummaryLabel, roomSecurityDepositAmount } from "@/lib/rental-application/listing-fees-display";
import { leaseTypeDisplayLabels } from "@/lib/rental-application/lease-terms";
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
  void meta;
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

export function wholeHousePricingSourceLabel(sub: ManagerListingSubmissionV1): string | null {
  if (sub.entireHomePriceSource === "default") return "Workspace default";
  if (sub.entireHomePriceSource === "own") return "This property";
  return null;
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

/** Money as the Pricing rows show it: `$1,300`, `$1,300.50` - grouped, never `$1300`. */
export function formatPricingMoney(amount: number): string {
  const whole = Math.abs(amount % 1) < 0.005;
  return `$${amount.toLocaleString("en-US", {
    minimumFractionDigits: whole ? 0 : 2,
    maximumFractionDigits: whole ? 0 : 2,
  })}`;
}

/** The lease types a row offers, in the one label set: `Long-term · Short-term`. Empty when none. */
export function propertyPricingTermsFact(sub: ManagerListingSubmissionV1): string {
  return leaseTypeDisplayLabels(resolveAllowedLeaseTerms(normalizeManagerListingSubmissionV1(sub))).join(" · ");
}

/** `$1,300 deposit`, or null when the room takes none. */
export function propertyPricingRoomDepositFact(room: ManagerRoomSubmission, sub: ManagerListingSubmissionV1): string | null {
  const deposit = roomSecurityDepositAmount(room, normalizeManagerListingSubmissionV1(sub));
  return deposit > 0 ? `${formatPricingMoney(deposit)} deposit` : null;
}

/** A bundle row's title is the rooms it combines, in the listing's room order: `Room 4 + Room 5`. */
export function propertyPricingBundleTitle(bundle: ManagerBundleRow, sub: ManagerListingSubmissionV1): string {
  const ids = new Set(bundle.includedRoomIds ?? []);
  const names = sub.rooms
    .filter((room) => ids.has(room.id))
    .map((room) => room.name?.trim())
    .filter((name): name is string => Boolean(name));
  if (names.length > 0) return names.join(" + ");
  return bundle.roomsLine?.trim() || bundle.label?.trim() || "Bundle";
}
