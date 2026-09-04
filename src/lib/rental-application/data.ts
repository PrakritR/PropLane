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
import { bundleShortTermPriceLabel } from "@/lib/listing-bundle-short-term";
import { LEASE_TERM_OPTIONS, SHORT_TERM_LEASE_TERM, type LeaseTermOption } from "@/lib/rental-application/lease-terms";
import { roomDailyRentPrice } from "@/lib/room-pricing";

export { LEASE_TERM_OPTIONS, SHORT_TERM_LEASE_TERM, type LeaseTermOption };

function normFloorLabel(raw: string): string {
  if (!raw.trim()) return "";
  const hit = LISTING_ROOM_FLOOR_LEVEL_OPTIONS.find((o) => o.id === raw.trim());
  return hit ? hit.label : raw.trim();
}

export function listingAllowedLeaseTerms(propertyId: string): string[] {
  const prop = getPropertyById(propertyId);
  const sub = prop?.listingSubmission?.v === 1 ? prop.listingSubmission : undefined;
  if (!sub) return [...LEASE_TERM_OPTIONS];
  const terms = resolveAllowedLeaseTerms(sub);
  return terms.length > 0 ? terms : [...LEASE_TERM_OPTIONS];
}

/** Separates listing property id from submission room id in `roomChoice*` values. */
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

function intervalsOverlap(
  startA: Date | null,
  endA: Date | null,
  startB: Date | null,
  endB: Date | null,
): boolean {
  if (!startA || !startB) return true;
  const aStart = startA.getTime();
  const aEnd = endA ? endA.getTime() : Number.POSITIVE_INFINITY;
  const bStart = startB.getTime();
  const bEnd = endB ? endB.getTime() : Number.POSITIVE_INFINITY;
  return aStart <= bEnd && bStart <= aEnd;
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
  const parsedTarget = parseRoomChoiceValue(roomChoiceValue);
  const normalizedTarget = roomChoiceValue.trim();
  return readManagerApplicationRows()
    .filter((row) => row.bucket === "approved" && row.id !== excludeApplicationId)
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
      // When no explicit start date exists but the resident has a definitive room assignment,
      // treat them as currently occupying from today with no known end date.
      const leaseStart = manualStart ?? appStart ?? (row.assignedRoomChoice?.trim() ? startOfToday() : null);
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

export function getRoomUnavailabilityWindows(
  roomChoiceValue: string,
  options: Pick<RoomAvailabilityOptions, "excludeApplicationId"> = {},
): RoomUnavailabilityWindow[] {
  const residentWindows = approvedOccupancyForRoom(roomChoiceValue, options.excludeApplicationId)
    .map((occ) => {
      const hasRange = Boolean(occ.leaseStart || occ.leaseEnd);
      if (!hasRange) return null;
      const label = occ.leaseStart && occ.leaseEnd
        ? `Occupied ${formatAvailabilityDate(occ.leaseStart)} to ${formatAvailabilityDate(occ.leaseEnd)}`
        : occ.leaseStart
          ? `Occupied from ${formatAvailabilityDate(occ.leaseStart)}`
          : `Occupied until ${formatAvailabilityDate(occ.leaseEnd as Date)}`;
      return {
        id: `resident-${occ.rowId}`,
        start: occ.leaseStart,
        end: occ.leaseEnd,
        label,
        source: "resident" as const,
      };
    })
    .filter((w) => w !== null);

  return [...residentWindows].sort((a, b) => {
    const at = a.start?.getTime() ?? Number.NEGATIVE_INFINITY;
    const bt = b.start?.getTime() ?? Number.NEGATIVE_INFINITY;
    return at - bt;
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
  const occupancies = approvedOccupancyForRoom(roomChoiceValue, options.excludeApplicationId);
  if (occupancies.some((occ) => intervalsOverlap(targetStart, targetEnd, occ.leaseStart, occ.leaseEnd))) {
    return false;
  }
  return true;
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
  return readManagerApplicationRows()
    .filter((row) => row.bucket === "pending" && row.id !== excludeApplicationId)
    .some((row) => {
      const effective = effectiveApplicationForRow(row);
      const assignedChoice = row.assignedRoomChoice?.trim() || effective?.roomChoice1?.trim() || "";
      if (!assignedChoice) return false;
      const parsedAssigned = parseRoomChoiceValue(assignedChoice);
      const sameRoom =
        assignedChoice === normalizedTarget ||
        (parsedAssigned.propertyId === parsedTarget.propertyId &&
          String(parsedAssigned.listingRoomId ?? "") === String(parsedTarget.listingRoomId ?? ""));
      if (!sameRoom) return false;
      const appStart = parseFlexibleLocalDate(effective?.leaseStart);
      const appEnd = parseFlexibleLocalDate(effective?.leaseEnd);
      if (!appStart) return false;
      return intervalsOverlap(targetStart, targetEnd, appStart, appEnd ?? appStart);
    });
}

export function isRoomApprovedConflict(
  roomChoiceValue: string,
  leaseStart: string | null | undefined,
  leaseEnd: string | null | undefined,
): boolean {
  const targetStart = parseFlexibleLocalDate(leaseStart) ?? startOfToday();
  const targetEnd = parseFlexibleLocalDate(leaseEnd) ?? targetStart;
  const occupancies = approvedOccupancyForRoom(roomChoiceValue);
  return occupancies.some((occ) => intervalsOverlap(targetStart, targetEnd, occ.leaseStart, occ.leaseEnd));
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
    : "This room is not available for the selected lease dates. Choose another room or adjust your dates.";
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
