import { isDemoModeActive } from "@/lib/demo/demo-session";
import { readPublicRoomOccupancy } from "@/lib/public-room-occupancy-client";
import { mockProperties } from "@/data/mock-properties";
import type { ListingRichContent } from "@/data/listing-rich-content";
import type { MockProperty } from "@/data/types";
import { LISTING_ROOM_FLOOR_LEVEL_OPTIONS } from "@/data/manager-listing-presets";
import {
  buildMockPropertyFromDraft,
  isPropertyActiveForLeads,
  readAllExtraListings,
  readAllPendingManagerProperties,
  readExtraListings,
} from "@/lib/demo-property-pipeline";
import { effectiveApplicationForRow, readManagerApplicationRows } from "@/lib/manager-applications-storage";
import { isEntireHomeListing, normalizeManagerListingSubmissionV1, resolveAllowedLeaseTerms } from "@/lib/manager-listing-submission";
import {
  applicationHoldsRoomPublicly,
  executedApplicationIdsForManager,
} from "@/lib/rental-application/room-public-occupancy-eligibility";
import { bundleShortTermPriceLabel } from "@/lib/listing-bundle-short-term";
import {
  LEASE_TERM_CHOICES,
  LEASE_TERM_OPTIONS,
  SHORT_TERM_LEASE_TERM,
  type LeaseTermOption,
} from "@/lib/rental-application/lease-terms";
import { roomDailyRentPrice } from "@/lib/room-pricing";

export { LEASE_TERM_CHOICES, LEASE_TERM_OPTIONS, SHORT_TERM_LEASE_TERM, type LeaseTermOption };

function normFloorLabel(raw: string): string {
  if (!raw.trim()) return "";
  const hit = LISTING_ROOM_FLOOR_LEVEL_OPTIONS.find((o) => o.id === raw.trim());
  return hit ? hit.label : raw.trim();
}

export function listingAllowedLeaseTerms(propertyId: string): string[] {
  const prop = getPropertyById(propertyId);
  const sub = prop?.listingSubmission?.v === 1 ? prop.listingSubmission : undefined;
  if (!sub) return [...LEASE_TERM_CHOICES];
  const terms = resolveAllowedLeaseTerms(sub);
  return terms.length > 0 ? terms : [...LEASE_TERM_CHOICES];
}

/**
 * Does this listing's lease continue month-to-month when its fixed term ends?
 *
 * Opt-in per listing (`rolloverToMonthToMonth`), because the standard lease
 * document promises the opposite — it "does not automatically continue as a month-to-month
 * tenancy". A listing that has not opted in reads false, so the resident is told
 * the lease ends rather than that it quietly continues.
 */
export function listingRollsOverToMonthToMonth(propertyId: string): boolean {
  const prop = getPropertyById(propertyId);
  const sub = prop?.listingSubmission?.v === 1 ? prop.listingSubmission : undefined;
  return sub?.rolloverToMonthToMonth === true;
}

/** Separates listing property id from submission room id in `roomChoice*` values. */
import {
  evaluateRoomOccupancy,
  normalizeRoomOccupancyCapacity,
  type RoomOccupancyPlacement,
} from "@/lib/rental-application/room-occupancy";

export const LISTING_ROOM_CHOICE_SEP = "::";

export type ParsedRoomChoice = { propertyId: string; listingRoomId?: string };
type RoomAvailabilityOptions = {
  leaseStart?: string | null;
  leaseEnd?: string | null;
  excludeApplicationId?: string | null;
  includeUnavailable?: boolean;
};

export function parseRoomChoiceValue(value: string): ParsedRoomChoice {
  const v = value.trim();
  if (!v) return { propertyId: "" };
  const i = v.indexOf(LISTING_ROOM_CHOICE_SEP);
  if (i === -1) return { propertyId: v };
  return { propertyId: v.slice(0, i), listingRoomId: v.slice(i + LISTING_ROOM_CHOICE_SEP.length) };
}

function parseFlexibleLocalDate(value: string | undefined | null): Date | null {
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    const [y, m, d] = raw.split("-").map(Number);
    const dt = new Date(y, m - 1, d);
    return Number.isNaN(dt.getTime()) ? null : new Date(dt.getFullYear(), dt.getMonth(), dt.getDate());
  }
  if (/^\d{1,2}\/\d{1,2}\/\d{4}$/.test(raw)) {
    const [m, d, y] = raw.split("/").map(Number);
    const dt = new Date(y, m - 1, d);
    return Number.isNaN(dt.getTime()) ? null : new Date(dt.getFullYear(), dt.getMonth(), dt.getDate());
  }
  const dt = new Date(raw);
  return Number.isNaN(dt.getTime()) ? null : new Date(dt.getFullYear(), dt.getMonth(), dt.getDate());
}

function startOfToday() {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate());
}

function dateMinusOneDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() - 1);
}

function formatAvailabilityDate(date: Date): string {
  return date.toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
  });
}

type ApprovedRoomOccupancy = {
  rowId: string;
  leaseStart: Date;
  leaseEnd: Date | null;
};

export type RoomUnavailabilityWindow = {
  id: string;
  start: Date | null;
  end: Date | null;
  label: string;
  source: "resident" | "manual_block";
};

function approvedOccupancyForRoom(roomChoiceValue: string, excludeApplicationId?: string | null): ApprovedRoomOccupancy[] {
  const publicSpans = !isDemoModeActive() && !excludeApplicationId ? readPublicRoomOccupancy(roomChoiceValue) : undefined;
  if (publicSpans) return publicSpans.flatMap((span, index) => Array.from({ length: span.count }, (_, bed) => ({
    rowId: `public-capacity-${index}-${bed}`, leaseStart: parseFlexibleLocalDate(span.start)!, leaseEnd: parseFlexibleLocalDate(span.end),
  })));
  const parsedTarget = parseRoomChoiceValue(roomChoiceValue);
  const normalizedTarget = roomChoiceValue.trim();
  const executedApplicationIds = executedApplicationIdsForManager();
  return readManagerApplicationRows()
    .filter((row) => row.bucket === "approved" && !row.withdrawnAt && row.id !== excludeApplicationId)
    .filter((row) => applicationHoldsRoomPublicly(row, executedApplicationIds))
    .map((row) => {
      const effective = effectiveApplicationForRow(row);
      const assignedChoice = row.assignedRoomChoice?.trim() || effective?.roomChoice1?.trim() || "";

      let sameRoom = false;
      if (assignedChoice) {
        const parsedAssigned = parseRoomChoiceValue(assignedChoice);
        sameRoom =
          assignedChoice === normalizedTarget ||
          (parsedAssigned.propertyId === parsedTarget.propertyId &&
            String(parsedAssigned.listingRoomId ?? "") === String(parsedTarget.listingRoomId ?? ""));
      } else if (parsedTarget.listingRoomId && row.assignedPropertyId?.trim() === parsedTarget.propertyId) {
        // Fallback for residents added without a structured room choice:
        // match by property + room display name stored in manualResidentDetails.
        const residentRoomName = row.manualResidentDetails?.roomNumber?.trim().toLowerCase();
        if (residentRoomName) {
          const prop = getPropertyById(parsedTarget.propertyId);
          if (prop?.listingSubmission?.v === 1) {
            const sub = normalizeManagerListingSubmissionV1(prop.listingSubmission);
            const matchRoom = sub.rooms.find((r) => r.id === parsedTarget.listingRoomId);
            if (matchRoom && matchRoom.name.trim().toLowerCase() === residentRoomName) {
              sameRoom = true;
            }
          }
        }
      }
      if (!sameRoom) return null;

      const manualStart = parseFlexibleLocalDate(row.manualResidentDetails?.moveInDate);
      const manualEnd = parseFlexibleLocalDate(row.manualResidentDetails?.moveOutDate);
      const appStart = parseFlexibleLocalDate(effective?.leaseStart);
      const appEnd = parseFlexibleLocalDate(effective?.leaseEnd);
      const currentStart = manualStart ?? appStart ?? null;
      const floor = parseFlexibleLocalDate(row.occupancyStartedOn);
      const leaseStart = floor && currentStart && floor < currentStart ? floor : currentStart;
      const leaseEnd = manualEnd ?? appEnd;

      if (!leaseStart) return null;

      return {
        rowId: row.id,
        leaseStart,
        leaseEnd,
      };
    })
    .filter((value): value is NonNullable<typeof value> => value !== null);
}

/**
 * How many residents this room may hold at once. Resolved from the listing the
 * room choice names; anything unresolvable reads as 1, which is the pre-per-bed
 * behaviour and can only ever under-sell.
 */
function roomCapacityForChoice(roomChoiceValue: string): number {
  const parsed = parseRoomChoiceValue(roomChoiceValue);
  if (!parsed.listingRoomId) return DEFAULT_SINGLE_OCCUPANCY;
  const prop = getPropertyById(parsed.propertyId);
  if (prop?.listingSubmission?.v !== 1) return DEFAULT_SINGLE_OCCUPANCY;
  const sub = normalizeManagerListingSubmissionV1(prop.listingSubmission);
  const room = sub.rooms.find((r) => r.id === parsed.listingRoomId);
  return normalizeRoomOccupancyCapacity(room?.occupancyCapacity);
}

const DEFAULT_SINGLE_OCCUPANCY = 1;

function occupancyToPlacements(occupancies: ApprovedRoomOccupancy[]): RoomOccupancyPlacement[] {
  return occupancies.map((occ) => ({ id: occ.rowId, start: occ.leaseStart, end: occ.leaseEnd }));
}

/** Earliest day any of these placements begins, used as an unbounded sweep origin. */
function earliestStart(placements: RoomOccupancyPlacement[]): Date {
  let earliest: Date | null = null;
  for (const placement of placements) {
    if (!earliest || placement.start.getTime() < earliest.getTime()) earliest = placement.start;
  }
  return earliest ?? startOfToday();
}

export function getRoomUnavailabilityWindows(
  roomChoiceValue: string,
  options: Pick<RoomAvailabilityOptions, "excludeApplicationId"> = {},
): RoomUnavailabilityWindow[] {
  const capacity = roomCapacityForChoice(roomChoiceValue);
  const placements = occupancyToPlacements(
    approvedOccupancyForRoom(roomChoiceValue, options.excludeApplicationId),
  );
  if (placements.length === 0) return [];

  // A window is unavailable only where the room reaches CAPACITY, not merely where
  // someone is present. At capacity 1 that is the same set of dates the product
  // has always shown; above 1 a partly-filled room stays selectable.
  const { fullyBookedIntervals } = evaluateRoomOccupancy({
    capacity,
    placements,
    windowStart: earliestStart(placements),
    windowEnd: null,
  });

  return fullyBookedIntervals.map((interval, index) => {
    const label = interval.end
      ? capacity > 1
        ? `Fully booked ${formatAvailabilityDate(interval.start)} to ${formatAvailabilityDate(interval.end)}`
        : `Occupied ${formatAvailabilityDate(interval.start)} to ${formatAvailabilityDate(interval.end)}`
      : capacity > 1
        ? `Fully booked from ${formatAvailabilityDate(interval.start)}`
        : `Occupied from ${formatAvailabilityDate(interval.start)}`;
    return {
      id: `resident-full-${index}`,
      start: interval.start,
      end: interval.end,
      label,
      source: "resident" as const,
    };
  });
}

export function isRoomChoiceAvailable(
  roomChoiceValue: string,
  _rawAvailability: string,
  options: RoomAvailabilityOptions = {},
): boolean {
  const targetStart = parseFlexibleLocalDate(options.leaseStart) ?? startOfToday();
  // When no end date is given (e.g. search with only move-in), treat as a point-in-time
  // check so we don't falsely conflict with occupancy windows outside the search date.
  const targetEnd = parseFlexibleLocalDate(options.leaseEnd) ?? targetStart;
  const placements = occupancyToPlacements(
    approvedOccupancyForRoom(roomChoiceValue, options.excludeApplicationId),
  );
  return evaluateRoomOccupancy({
    capacity: roomCapacityForChoice(roomChoiceValue),
    placements,
    windowStart: targetStart,
    windowEnd: targetEnd,
  }).hasRoom;
}

function pendingConflictForRoom(
  roomChoiceValue: string,
  leaseStart: string | null | undefined,
  leaseEnd: string | null | undefined,
  excludeApplicationId?: string | null,
): boolean {
  const parsedTarget = parseRoomChoiceValue(roomChoiceValue);
  const normalizedTarget = roomChoiceValue.trim();
  const targetStart = parseFlexibleLocalDate(leaseStart) ?? startOfToday();
  const targetEnd = parseFlexibleLocalDate(leaseEnd) ?? targetStart;

  const pendingPlacements: RoomOccupancyPlacement[] = [];
  for (const row of readManagerApplicationRows()) {
    if (row.bucket !== "pending" || row.id === excludeApplicationId) continue;
    const effective = effectiveApplicationForRow(row);
    const assignedChoice = row.assignedRoomChoice?.trim() || effective?.roomChoice1?.trim() || "";
    if (!assignedChoice) continue;
    const parsedAssigned = parseRoomChoiceValue(assignedChoice);
    const sameRoom =
      assignedChoice === normalizedTarget ||
      (parsedAssigned.propertyId === parsedTarget.propertyId &&
        String(parsedAssigned.listingRoomId ?? "") === String(parsedTarget.listingRoomId ?? ""));
    if (!sameRoom) continue;
    const appStart = parseFlexibleLocalDate(effective?.leaseStart);
    if (!appStart) continue;
    pendingPlacements.push({ id: row.id, start: appStart, end: parseFlexibleLocalDate(effective?.leaseEnd) ?? appStart });
  }
  if (pendingPlacements.length === 0) return false;

  // Pending applications reserve NOTHING — this is only the advisory "someone else
  // is asking for this room too" warning. It fires when the approved placements plus
  // the pending ones would exceed capacity, so a two-bed room with one pending
  // applicant no longer warns about a bed that is genuinely still free.
  const placements = [
    ...occupancyToPlacements(approvedOccupancyForRoom(roomChoiceValue, excludeApplicationId)),
    ...pendingPlacements,
  ];
  return !evaluateRoomOccupancy({
    capacity: roomCapacityForChoice(roomChoiceValue),
    placements,
    windowStart: targetStart,
    windowEnd: targetEnd,
  }).hasRoom;
}

/**
 * How many of this room's beds are free over the requested window. Used by the
 * public catalog so a shared room can say "1 of 2 beds available" instead of the
 * flat "1 available" that was correct only while every room held one person.
 */
export function roomBedAvailability(
  roomChoiceValue: string,
  options: RoomAvailabilityOptions = {},
): { capacity: number; remaining: number } {
  const targetStart = parseFlexibleLocalDate(options.leaseStart) ?? startOfToday();
  const targetEnd = parseFlexibleLocalDate(options.leaseEnd) ?? targetStart;
  const { capacity, remaining } = evaluateRoomOccupancy({
    capacity: roomCapacityForChoice(roomChoiceValue),
    placements: occupancyToPlacements(
      approvedOccupancyForRoom(roomChoiceValue, options.excludeApplicationId),
    ),
    windowStart: targetStart,
    windowEnd: targetEnd,
  });
  return { capacity, remaining };
}

export function isRoomApprovedConflict(
  roomChoiceValue: string,
  leaseStart: string | null | undefined,
  leaseEnd: string | null | undefined,
): boolean {
  const targetStart = parseFlexibleLocalDate(leaseStart) ?? startOfToday();
  const targetEnd = parseFlexibleLocalDate(leaseEnd) ?? targetStart;
  return !evaluateRoomOccupancy({
    capacity: roomCapacityForChoice(roomChoiceValue),
    placements: occupancyToPlacements(approvedOccupancyForRoom(roomChoiceValue)),
    windowStart: targetStart,
    windowEnd: targetEnd,
  }).hasRoom;
}

export function isRoomPendingConflict(
  roomChoiceValue: string,
  leaseStart: string | null | undefined,
  leaseEnd: string | null | undefined,
): boolean {
  return pendingConflictForRoom(roomChoiceValue, leaseStart, leaseEnd);
}

export function effectiveRoomAvailabilityLabel(
  roomChoiceValue: string,
  _rawAvailability: string,
  options: RoomAvailabilityOptions = {},
): string {
  const today = startOfToday();
  const windows = getRoomUnavailabilityWindows(roomChoiceValue, { excludeApplicationId: options.excludeApplicationId });

  // Check if today is within any unavailability window (point-in-time check).
  const currentBlock = windows.find((w) => {
    const wStart = w.start?.getTime() ?? Number.NEGATIVE_INFINITY;
    const wEnd = w.end?.getTime() ?? Number.POSITIVE_INFINITY;
    return today.getTime() >= wStart && today.getTime() <= wEnd;
  });

  if (currentBlock) {
    if (!currentBlock.end) {
      return currentBlock.source === "resident" ? "Unavailable (occupied)" : "Unavailable (blocked)";
    }
    return `Unavailable until ${formatAvailabilityDate(currentBlock.end)}`;
  }

  // Room is available now — find the next upcoming block.
  const nextBlock = windows
    .filter((w) => w.start && w.start.getTime() > today.getTime())
    .sort((a, b) => (a.start as Date).getTime() - (b.start as Date).getTime())[0];

  if (nextBlock?.start) {
    const until = dateMinusOneDay(nextBlock.start);
    if (until.getTime() >= today.getTime()) {
      return `Available now until ${formatAvailabilityDate(until)}`;
    }
  }

  return "Available now";
}

/** Compact room label for payment ledger rows (no rent suffix). */
export function ledgerRoomNumberForApplication(row: {
  assignedRoomChoice?: string;
  application?: { roomChoice1?: string };
  manualResidentDetails?: { roomNumber?: string };
}): string {
  const raw =
    row.manualResidentDetails?.roomNumber?.trim() ||
    row.assignedRoomChoice?.trim() ||
    row.application?.roomChoice1?.trim() ||
    "";
  if (!raw) return "";
  const label = getRoomChoiceLabel(raw).split(" · ")[0]?.trim() || raw;
  return label.replace(/^room\s+/i, "").trim();
}

/** Human-readable label for a 1st/2nd/3rd room choice (legacy property id or `mgr-*::roomId`). */
export function getRoomChoiceLabel(roomChoiceValue: string): string {
  const t = roomChoiceValue.trim();
  if (!t) return "";
  const { propertyId, listingRoomId } = parseRoomChoiceValue(t);
  if (listingRoomId) {
    const prop = getPropertyById(propertyId);
    if (!prop?.listingSubmission || prop.listingSubmission.v !== 1) return prop?.title ?? "";
    const sub = normalizeManagerListingSubmissionV1(prop.listingSubmission);
    const room = sub.rooms.find((r) => r.id === listingRoomId);
    if (!room) return prop.title;
    const daily = roomDailyRentPrice(room);
    const rent = daily !== undefined ? `$${daily}/day` : room.monthlyRent > 0 ? `$${room.monthlyRent}/mo` : "";
    const parts = [room.name.trim(), normFloorLabel(room.floor), rent].filter(Boolean);
    return parts.length ? parts.join(" · ") : room.name.trim();
  }
  const r = getPropertyById(t);
  return r ? `${r.buildingName} · ${r.unitLabel}` : "";
}

/** Dropdown: one row per listing (property + unit). */
export function getPropertySelectOptions(): { value: string; label: string }[] {
  return mockProperties.map((p) => ({
    value: p.id,
    label: p.title,
  }));
}

export function getPropertyById(id: string): MockProperty | undefined {
  const base = id.trim();
  if (!base) return undefined;
  const { propertyId } = parseRoomChoiceValue(base);
  // Prefer the full extras cache (includes resident-hydrated unpublished
  // listings) over the public live-only catalog, which may be incomplete.
  const fromKnown =
    mockProperties.find((p) => p.id === propertyId) ??
    readAllExtraListings().find((p) => p.id === propertyId) ??
    readExtraListings().find((p) => p.id === propertyId);
  if (fromKnown) return fromKnown;
  // Fall back to pending properties (not yet approved/listed) so their title resolves correctly.
  const pendingRow = readAllPendingManagerProperties().find((p) => p.id === propertyId);
  if (pendingRow) return buildMockPropertyFromDraft(pendingRow, propertyId);
  return undefined;
}

/** Active manager-shared link target — returns undefined for inactive or unknown properties. */
export function getPropertyForPublicLink(propertyId: string): MockProperty | undefined {
  const prop = getPropertyById(propertyId.trim());
  if (!prop || !isPropertyActiveForLeads(prop)) return undefined;
  return prop;
}

export function propertyAllowsShortTermRental(propertyId: string): boolean {
  const property = getPropertyById(propertyId);
  return Boolean(property?.listingSubmission?.shortTermRentalsAllowed);
}

export function propertyAllowsAirbnbRental(propertyId: string): boolean {
  const property = getPropertyById(propertyId);
  return Boolean(property?.listingSubmission?.airbnbRentalsAllowed);
}

/** Rooms for the selected listing: manager submission rooms, else legacy one-row-per-unit in the same building. */
export function getRoomOptionsForProperty(propertyId: string, options: RoomAvailabilityOptions = {}): { value: string; label: string }[] {
  const selected = getPropertyById(propertyId);
  if (!selected) return [];

  if (selected.listingSubmission?.v === 1) {
    const sub = normalizeManagerListingSubmissionV1(selected.listingSubmission);
    const roomRows = sub.rooms.filter(
      (r) =>
        r.name.trim() &&
        (options.includeUnavailable ||
          isRoomChoiceAvailable(`${selected.id}${LISTING_ROOM_CHOICE_SEP}${r.id}`, r.availability, options)),
    );
    if (roomRows.length > 0) {
      return roomRows.map((r) => {
        const daily = roomDailyRentPrice(r);
        const rent = daily !== undefined ? `$${daily}/day` : r.monthlyRent > 0 ? `$${r.monthlyRent}/mo` : "Rent TBD";
        const floor = normFloorLabel(r.floor);
        // Size sits beside the rent so a prospect ranking rooms can see WHY one
        // costs more (AXI-167). Omitted entirely when the manager did not state
        // it — never "0 sq ft", which would assert a fact nobody supplied.
        const size = r.sizeSqft != null && r.sizeSqft > 0 ? `${r.sizeSqft} sq ft` : "";
        const label = [r.name.trim(), floor, size, rent].filter(Boolean).join(" · ");
        return { value: `${selected.id}${LISTING_ROOM_CHOICE_SEP}${r.id}`, label };
      });
    }
  }

  const catalog = [...mockProperties, ...readAllExtraListings(), ...readExtraListings()];
  const seen = new Set<string>();
  const out: { value: string; label: string }[] = [];
  for (const p of catalog) {
    if (p.buildingId !== selected.buildingId) continue;
    if (seen.has(p.id)) continue;
    seen.add(p.id);
    out.push({
      value: p.id,
      label: p.unitLabel ? `${p.buildingName} · ${p.unitLabel}` : p.title,
    });
  }
  return out;
}

const NONE = "";

export function roomSelectOptionsWithNone(propertyId: string, options: RoomAvailabilityOptions = {}): { value: string; label: string }[] {
  return [{ value: NONE, label: "None" }, ...getRoomOptionsForProperty(propertyId, options)];
}

/**
 * True when the listing is rented room-by-room, vs. leased as a whole unit.
 * Drives the application form: by-room listings ask for ranked 1st/2nd/3rd
 * room choices; whole-unit listings don't (there's no room to choose — the
 * whole place is one lease).
 *
 * The listing's pricing model is authoritative: an entire-home listing may
 * still itemize rooms for display ("you can still itemize rooms inside
 * PropLane"), so room presence alone must not flip the application to
 * ranked room choices.
 */
export function isPropertyRentedByRoom(propertyId: string): boolean {
  const selected = getPropertyById(propertyId);
  if (!selected?.listingSubmission || selected.listingSubmission.v !== 1) return false;
  const sub = normalizeManagerListingSubmissionV1(selected.listingSubmission);
  if (isEntireHomeListing(sub)) return false;
  return sub.rooms.some((r) => r.name.trim());
}

/**
 * True when the listing's pricing model is "entire place — one lease for the
 * home". Its itemized rooms (if any) are interior bedrooms shown on the
 * listing, NOT selectable units — the application applies for the whole home
 * (roomChoice1 = the property id, labeled building · unit).
 */
export function isEntireHomeProperty(propertyId: string): boolean {
  const selected = getPropertyById(propertyId);
  if (!selected?.listingSubmission || selected.listingSubmission.v !== 1) return false;
  return isEntireHomeListing(normalizeManagerListingSubmissionV1(selected.listingSubmission));
}

/** Manager-defined lease bundles on the listing (empty for listings without bundles). */
export function getBundlesForProperty(propertyId: string) {
  const selected = getPropertyById(propertyId);
  if (!selected?.listingSubmission || selected.listingSubmission.v !== 1) return [];
  const sub = normalizeManagerListingSubmissionV1(selected.listingSubmission);
  if (isEntireHomeListing(sub)) return [];
  return sub.bundles.filter((b) => b.label.trim() || b.price.trim());
}

/** Dropdown options for the application form's bundle picker. */
export function getBundleOptionsForProperty(
  propertyId: string,
  opts?: { rentalType?: "standard" | "short_term" },
): { value: string; label: string }[] {
  const selected = getPropertyById(propertyId);
  const sub =
    selected?.listingSubmission?.v === 1
      ? normalizeManagerListingSubmissionV1(selected.listingSubmission)
      : null;
  const shortTerm = opts?.rentalType === "short_term";

  return getBundlesForProperty(propertyId)
    .filter((b) => (shortTerm ? Boolean(b.shortTermEnabled) : Boolean(b.price.trim())))
    .map((b) => {
      const name = b.label.trim() || "Package";
      if (shortTerm) {
        const nightly =
          (sub ? bundleShortTermPriceLabel(b, sub) : undefined) ??
          (b.shortTermNightlyRent?.trim() ? `${b.shortTermNightlyRent.trim()}/night` : "");
        return { value: b.id, label: [name, nightly].filter(Boolean).join(" · ") };
      }
      return { value: b.id, label: [name, b.price.trim()].filter(Boolean).join(" · ") };
    });
}

/** Human-readable label for an application's selected bundle (manager views + lease). */
export function getBundleChoiceLabel(
  propertyId: string,
  bundleId: string,
  opts?: { rentalType?: "standard" | "short_term" },
): string {
  const id = bundleId.trim();
  if (!id) return "";
  const bundle = getBundlesForProperty(propertyId).find((b) => b.id === id);
  if (!bundle) return "";
  const selected = getPropertyById(propertyId);
  const sub =
    selected?.listingSubmission?.v === 1
      ? normalizeManagerListingSubmissionV1(selected.listingSubmission)
      : null;
  const shortTerm = opts?.rentalType === "short_term";
  const pricePart = shortTerm
    ? (sub ? bundleShortTermPriceLabel(bundle, sub) : undefined) ?? bundle.shortTermNightlyRent?.trim() ?? ""
    : bundle.price.trim();
  const parts = [bundle.label.trim() || "Package", pricePart].filter(Boolean);
  const scope = bundle.roomsLine.trim();
  return scope ? `${parts.join(" · ")} (${scope})` : parts.join(" · ");
}

export function getDemoRoomAvailabilityMessage(
  roomId: string,
  leaseStart: string,
  leaseEnd: string | undefined,
  leaseTerm: string,
): string | null {
  if (!roomId || !leaseStart) return null;
  const mtm = leaseTerm === "Month-to-Month";
  const endForCheck = mtm ? undefined : leaseEnd?.trim() || undefined;
  const { propertyId, listingRoomId } = parseRoomChoiceValue(roomId);
  const room = getPropertyById(listingRoomId ? propertyId : roomId);
  if (!room) return null;
  return isRoomChoiceAvailable(roomId, room.available, { leaseStart, leaseEnd: endForCheck })
    ? null
    : "This room is not available for your selected dates. Choose another room or adjust your move-in dates.";
}

export function applyApprovedAvailabilityToRichContent(property: MockProperty, rich: ListingRichContent): ListingRichContent {
  return {
    ...rich,
    floorPlans: rich.floorPlans.map((floor) => ({
      ...floor,
      rooms: floor.rooms.map((room) => {
        const roomChoiceValue = `${property.id}${LISTING_ROOM_CHOICE_SEP}${room.id}`;
        return {
          ...room,
          availability: effectiveRoomAvailabilityLabel(roomChoiceValue, room.availability),
        };
      }),
    })),
  };
}
