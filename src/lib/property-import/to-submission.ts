/**
 * Property import — one understood property becomes one listing draft.
 *
 * Pure and client-safe. The draft is an ordinary `ManagerListingSubmissionV1`
 * built the way Add property builds one (default submission → bedroom and
 * bathroom slots → normalize), with the file's values on top. Everything the
 * file filled is recorded on `submission.prefill` as source `file`, which is
 * what the editor's ✦ Imported marks and Undo already read.
 */

import { bathIdFromCount } from "@/lib/listing-prefill/apply";
import {
  applyListingBathroomSlots,
  applyListingBedroomSlots,
  createDefaultListingSubmission,
  normalizeManagerListingSubmissionV1,
  type ManagerListingSubmissionV1,
  type ManagerRoomSubmission,
} from "@/lib/manager-listing-submission";
import type { PropertyImportProperty } from "@/lib/property-import/types";

/** The "from your file · row 3" detail beside a marked field. */
export type PropertyImportFieldSource = { sheet: string; row: number | null };

/** A bare "1", "B" or "2A" from the file reads as "Room 1" / "Unit 2A" on a card. */
export function importedRoomLabel(label: string, byRoom: boolean): string {
  const trimmed = label.trim();
  if (!trimmed) return "";
  if (/^(\d{1,3}[a-z]?|[a-z])$/i.test(trimmed)) return `${byRoom ? "Room" : "Unit"} ${trimmed.toUpperCase()}`;
  return trimmed;
}

export function submissionFromImportedProperty(p: PropertyImportProperty): ManagerListingSubmissionV1 {
  const base = createDefaultListingSubmission();
  const filled: (keyof ManagerListingSubmissionV1)[] = [];
  const set = <K extends keyof ManagerListingSubmissionV1>(sub: ManagerListingSubmissionV1, key: K, value: ManagerListingSubmissionV1[K]) => {
    filled.push(key);
    return { ...sub, [key]: value };
  };

  let sub: ManagerListingSubmissionV1 = { ...base };
  if (p.address) sub = set(sub, "address", p.address);
  if (p.city) sub = set(sub, "city", p.city);
  if (p.state) sub = set(sub, "state", p.state);
  if (p.zip) sub = set(sub, "zip", p.zip);
  sub = set(sub, "buildingName", p.name || p.address);
  sub = set(sub, "listingPropertyTypeId", p.propertyType);
  // "By the room" versus "the whole place" changes every screen after Basics,
  // so it is stamped exactly the way Add property stamps its own answer. A
  // building whose units each carry their own rent is priced per room too —
  // PropLane's rooms are its rentable units, and a whole-place draft would
  // throw those prices away.
  const byRoom = p.rentByRoom || p.rooms.filter((r) => r.rent != null).length >= 2;
  sub = set(sub, "listingPlaceCategoryId", byRoom ? "shared_home" : "entire_home");
  sub = { ...sub, rentalModelStamp: byRoom ? "shared_home" : "entire_home" };

  const bedrooms = Math.max(1, Math.min(20, p.bedrooms || p.rooms.length || 1));
  sub = set(sub, "listingBedroomSlots", bedrooms);
  if (p.bathrooms != null) sub = set(sub, "listingTotalBathroomsId", bathIdFromCount(p.bathrooms));

  const grown = applyListingBedroomSlots(sub, bedrooms);
  sub = grown.ok ? grown.sub : sub;

  // The file's rooms land on the slots in order; a slot the file did not name
  // keeps its default "Room N".
  if (p.rooms.length > 0) {
    const rooms: ManagerRoomSubmission[] = sub.rooms.map((room, i) => {
      const src = p.rooms[i];
      if (!src) return room;
      return {
        ...room,
        name: importedRoomLabel(src.label, p.rentByRoom) || room.name,
        monthlyRent: src.rent ?? room.monthlyRent,
        securityDeposit: src.deposit != null ? String(src.deposit) : room.securityDeposit,
      };
    });
    sub = set(sub, "rooms", rooms);
  }

  if (!byRoom) {
    if (p.monthlyRent != null) sub = set(sub, "entireHomeMonthlyRent", p.monthlyRent);
    else if (p.rooms.length === 1 && p.rooms[0]!.rent != null) sub = set(sub, "entireHomeMonthlyRent", p.rooms[0]!.rent);
    if (p.deposit != null) sub = set(sub, "securityDeposit", String(p.deposit));
    else if (p.rooms.length === 1 && p.rooms[0]!.deposit != null) sub = set(sub, "securityDeposit", String(p.rooms[0]!.deposit));
  }

  const withBaths = applyListingBathroomSlots(sub);
  sub = withBaths.ok ? withBaths.sub : sub;

  sub = {
    ...sub,
    prefill: {
      source: "file",
      fetchedAt: new Date().toISOString(),
      fields: [],
      adFields: [...new Set(filled)],
      previous: {},
    },
  };
  return normalizeManagerListingSubmissionV1(sub);
}

/** Where a property's fields came from, for the marks: sheet + first cited row. */
export function importedFieldSource(p: PropertyImportProperty): PropertyImportFieldSource {
  return { sheet: p.sourceSheet, row: p.sourceRows[0] ?? null };
}

/** "rows 3–6" / "row 14" / "" for the Found list and the switcher. */
export function describeSourceRows(rows: number[]): string {
  if (rows.length === 0) return "";
  if (rows.length === 1) return `row ${rows[0]}`;
  const sorted = [...rows].sort((a, b) => a - b);
  const contiguous = sorted.every((r, i) => i === 0 || r === sorted[i - 1]! + 1);
  return contiguous ? `rows ${sorted[0]}–${sorted[sorted.length - 1]}` : `rows ${sorted.join(", ")}`;
}

/** Monthly rent the file gave this property, summed across its rooms when let by the room. */
export function importedMonthlyRent(p: PropertyImportProperty): number | null {
  if (p.monthlyRent != null && p.rooms.every((r) => r.rent == null)) return p.monthlyRent;
  const rents = p.rooms.map((r) => r.rent).filter((r): r is number => r != null);
  if (rents.length === 0) return p.monthlyRent;
  return rents.reduce((a, b) => a + b, 0);
}
