import type {
  ManagerBathroomRoomAccessKind,
  ManagerBathroomSubmission,
  ManagerListingSubmissionV1,
  ManagerRoomSubmission,
} from "@/lib/manager-listing-submission";

function listingRooms(sub: ManagerListingSubmissionV1): ManagerRoomSubmission[] {
  return sub.rooms.filter((r) => r.name.trim() || r.monthlyRent > 0);
}

function roomDisplayName(rooms: ManagerRoomSubmission[], roomId: string): string {
  return rooms.find((r) => r.id === roomId)?.name?.trim() ?? "";
}

function isUpperFloor(floor: string): boolean {
  return /3rd|top/i.test(floor);
}

function emptyBathroomShell(
  id: string,
  patch: Partial<ManagerBathroomSubmission> & Pick<ManagerBathroomSubmission, "name" | "assignedRoomIds">,
): ManagerBathroomSubmission {
  return {
    id,
    name: patch.name,
    location: patch.location ?? "",
    amenitiesText: patch.amenitiesText ?? "",
    photoDataUrls: patch.photoDataUrls ?? [],
    videoDataUrl: patch.videoDataUrl ?? null,
    shower: patch.shower ?? true,
    toilet: patch.toilet ?? true,
    bathtub: patch.bathtub ?? false,
    // Added to the type on another branch while this builder landed on this
    // one, so the merge left the shell short two required fields.
    sink: patch.sink ?? true,
    mirror: patch.mirror ?? true,
    assignedRoomIds: patch.assignedRoomIds,
    allResidents: patch.allResidents,
    accessKindByRoomId: patch.accessKindByRoomId,
  };
}

/** Mirror seed-test-db `buildCatalogBathrooms` — infer layout when managers skip bathroom assignments. */
export function synthesizeBathroomRowsFromRooms(
  rooms: ManagerRoomSubmission[],
  idPrefix = "inferred-bath",
): ManagerBathroomSubmission[] {
  const roomIds = rooms.map((r) => r.id);
  if (roomIds.length === 0) return [];

  if (roomIds.length === 1) {
    const roomId = roomIds[0]!;
    const room = rooms[0]!;
    return [
      emptyBathroomShell(`${idPrefix}-1`, {
        name: "Full bathroom",
        location: room.floor.trim(),
        assignedRoomIds: [roomId],
        accessKindByRoomId: { [roomId]: "ensuite" },
      }),
    ];
  }

  const upperRoomIds = rooms.filter((r) => isUpperFloor(r.floor)).map((r) => r.id);
  const mainRoomIds = roomIds.filter((id) => !upperRoomIds.includes(id));
  const baths: ManagerBathroomSubmission[] = [];

  if (mainRoomIds.length > 0) {
    baths.push(
      emptyBathroomShell(`${idPrefix}-main`, {
        name: "Main hall bath",
        location: "Hallway",
        bathtub: true,
        assignedRoomIds: mainRoomIds,
        accessKindByRoomId: Object.fromEntries(mainRoomIds.map((id) => [id, "shared"])),
      }),
    );
  }

  for (const roomId of upperRoomIds) {
    baths.push(
      emptyBathroomShell(`${idPrefix}-${roomId}`, {
        name: "Upper bath",
        location: "Upper floor",
        assignedRoomIds: [roomId],
        accessKindByRoomId: { [roomId]: "ensuite" },
      }),
    );
  }

  return baths;
}

function hasExplicitRoomAssignments(sub: ManagerListingSubmissionV1): boolean {
  return sub.bathrooms
    .filter((b) => b.name.trim() && !b.allResidents)
    .some((b) => (b.assignedRoomIds ?? []).length > 0);
}

/** Explicit manager bathroom rows when present; otherwise infer from room floors. */
export function effectiveBathroomsForListing(sub: ManagerListingSubmissionV1): ManagerBathroomSubmission[] {
  const rooms = listingRooms(sub);
  const namedBaths = sub.bathrooms.filter((b) => b.name.trim());
  const wholeHouse = namedBaths.filter((b) => b.allResidents);
  const specificBaths = namedBaths.filter((b) => !b.allResidents);

  if (!hasExplicitRoomAssignments(sub)) {
    if (wholeHouse.length > 0 && specificBaths.length === 0) {
      return wholeHouse;
    }
    return [...synthesizeBathroomRowsFromRooms(rooms), ...wholeHouse];
  }

  const assigned = new Set<string>();
  for (const bath of specificBaths) {
    for (const id of bath.assignedRoomIds ?? []) assigned.add(id);
  }

  const orphans = rooms.filter((r) => !assigned.has(r.id));
  const orphanBaths =
    orphans.length > 0 ? synthesizeBathroomRowsFromRooms(orphans, "inferred-orphan-bath") : [];

  return [...specificBaths, ...orphanBaths, ...wholeHouse];
}

function wholeHouseBaths(sub: ManagerListingSubmissionV1): ManagerBathroomSubmission[] {
  return effectiveBathroomsForListing(sub).filter((b) => b.name.trim() && b.allResidents);
}

function directBathroomForRoom(
  roomId: string,
  bathrooms: ManagerBathroomSubmission[],
): ManagerBathroomSubmission | null {
  return (
    bathrooms.find(
      (b) => b.name.trim() && !b.allResidents && (b.assignedRoomIds ?? []).includes(roomId),
    ) ?? null
  );
}

function accessKindForRoom(
  bath: ManagerBathroomSubmission,
  roomId: string,
): ManagerBathroomRoomAccessKind | undefined {
  const explicit = bath.accessKindByRoomId?.[roomId];
  if (explicit) return explicit;
  const ids = bath.assignedRoomIds ?? [];
  if (ids.length === 1 && ids[0] === roomId) return "ensuite";
  if (ids.length > 1) return "shared";
  return undefined;
}

function otherRoomNamesOnBathroom(
  bath: ManagerBathroomSubmission,
  roomId: string,
  rooms: ManagerRoomSubmission[],
): string[] {
  return (bath.assignedRoomIds ?? [])
    .filter((id) => id !== roomId)
    .map((id) => roomDisplayName(rooms, id))
    .filter(Boolean);
}

function bathroomHintFromRoomDetail(detail: string): string | null {
  const text = detail.trim();
  if (!text) return null;
  const d = text.toLowerCase();
  if (/\ben[- ]?suite\b/.test(d) || /\bprivate\s+bath(?:room)?\b/.test(d)) {
    return "En suite · private bathroom attached to this room";
  }
  if (/\bshared\s+bath(?:room)?\b/.test(d) || /\bshares?\s+(?:a\s+)?bath(?:room)?\b/.test(d)) {
    return "Shared bathroom · see room notes for layout";
  }
  if (/\bhall\s+bath(?:room)?\b/.test(d) || /\bwhole[- ]house\s+bath/.test(d)) {
    return "Hall bathroom · shared bathroom in the hallway";
  }
  return null;
}

function formatWholeHouseSupplement(sub: ManagerListingSubmissionV1): string {
  const names = wholeHouseBaths(sub)
    .map((b) => b.name.trim())
    .filter(Boolean);
  return names.length ? ` · Whole-house bath: ${names.join(", ")}` : "";
}

/** Room names assigned to a bathroom row — for listing cards and modals. */
export function bathroomAssignedRoomNames(
  b: ManagerBathroomSubmission,
  sub: ManagerListingSubmissionV1,
): string[] {
  const rooms = listingRooms(sub);
  if (b.allResidents) {
    return rooms.map((r) => r.name.trim()).filter(Boolean);
  }
  return (b.assignedRoomIds ?? [])
    .map((id) => rooms.find((r) => r.id === id)?.name?.trim())
    .filter((name): name is string => Boolean(name));
}

/** One-line “used by” label for bathroom listing cards. */
export function bathroomUsedByListingLabel(
  b: ManagerBathroomSubmission,
  sub: ManagerListingSubmissionV1,
): string {
  const names = bathroomAssignedRoomNames(b, sub);
  if (b.allResidents) {
    return names.length ? `All bedrooms (${names.join(", ")})` : "All listed bedrooms";
  }
  return names.length ? `Shared by ${names.join(", ")}` : "";
}

function describeAssignedBathroom(
  roomId: string,
  bath: ManagerBathroomSubmission,
  sub: ManagerListingSubmissionV1,
): string {
  const rooms = listingRooms(sub);
  const ids = bath.assignedRoomIds ?? [];
  const kind = accessKindForRoom(bath, roomId);
  const bathName = bath.name.trim();
  const others = otherRoomNamesOnBathroom(bath, roomId, rooms);
  const wholeHouseSuffix = formatWholeHouseSupplement(sub);

  if (kind === "ensuite" || ids.length === 1) {
    if (bathName) {
      return `${bathName} · en suite · private to this room${wholeHouseSuffix}`;
    }
    return `En suite · private bathroom attached to this room${wholeHouseSuffix}`;
  }

  if (kind === "hall") {
    const base = bathName || "Hall bathroom";
    return `${base} · hallway access${wholeHouseSuffix}`;
  }

  const head = bathName || "Shared bathroom";
  const roommateClause = others.length ? ` · shared with ${others.join(", ")}` : "";
  return `${head}${roommateClause}${wholeHouseSuffix}`;
}

/** Human-readable bathroom situation for a room modal / listing copy. */
export function describeRoomBathroomSituation(roomId: string, sub: ManagerListingSubmissionV1): string {
  const bathrooms = effectiveBathroomsForListing(sub);
  const direct = directBathroomForRoom(roomId, bathrooms);

  if (direct) {
    return describeAssignedBathroom(roomId, direct, sub);
  }

  const wholeHouse = wholeHouseBaths(sub);
  if (wholeHouse.length > 0) {
    const names = wholeHouse.map((b) => b.name.trim()).filter(Boolean);
    return `Hall bathroom · ${names.join(", ")} · shared by all bedrooms`;
  }

  const room = sub.rooms.find((r) => r.id === roomId);
  const fromDetail = room ? bathroomHintFromRoomDetail(room.detail) : null;
  if (fromDetail) return fromDetail;

  return "Bathroom details not listed — contact leasing for layout.";
}

export function roomHasPrivateBath(roomId: string, sub: ManagerListingSubmissionV1): boolean {
  const bathrooms = effectiveBathroomsForListing(sub);
  return bathrooms.some((b) => {
    if (b.allResidents) return false;
    const ids = b.assignedRoomIds ?? [];
    return ids.length === 1 && ids[0] === roomId;
  });
}

export function bathroomShareCountForRoom(roomId: string, sub: ManagerListingSubmissionV1): number | null {
  const bathrooms = effectiveBathroomsForListing(sub);
  const direct = directBathroomForRoom(roomId, bathrooms);
  if (!direct) return null;
  const n = (direct.assignedRoomIds ?? []).filter(Boolean).length;
  return n > 0 ? n : null;
}

export function listingHasWholeHouseBath(sub: ManagerListingSubmissionV1): boolean {
  return wholeHouseBaths(sub).length > 0;
}

export type RoomBathroomAccessLine = {
  label: string;
  privacy: "private" | "shared";
  shareRoomCount?: number;
};

function bathroomsAccessibleToRoom(
  roomId: string,
  sub: ManagerListingSubmissionV1,
): ManagerBathroomSubmission[] {
  return effectiveBathroomsForListing(sub).filter((b) => {
    if (!b.name.trim()) return false;
    if (b.allResidents) return true;
    return (b.assignedRoomIds ?? []).includes(roomId);
  });
}

function bathroomPrivacyForRoom(
  bath: ManagerBathroomSubmission,
  roomId: string,
  sub: ManagerListingSubmissionV1,
): Pick<RoomBathroomAccessLine, "privacy" | "shareRoomCount"> {
  if (bath.allResidents) {
    const count = listingRooms(sub).length;
    return { privacy: "shared", shareRoomCount: count > 0 ? count : undefined };
  }

  const ids = (bath.assignedRoomIds ?? []).filter(Boolean);
  const kind = accessKindForRoom(bath, roomId);
  if (kind === "ensuite" || ids.length === 1) {
    return { privacy: "private" };
  }

  return { privacy: "shared", shareRoomCount: ids.length > 0 ? ids.length : undefined };
}

export function formatRoomBathroomAccessLine(line: RoomBathroomAccessLine): string {
  if (line.privacy === "private") {
    return `${line.label} (private)`;
  }
  const n = line.shareRoomCount;
  if (typeof n === "number" && n > 1) {
    return `${line.label} (shared · ${n} rooms)`;
  }
  return `${line.label} (shared)`;
}

/** Every bathroom this room can use — numbered for listing modals. */
export function roomBathroomAccessLines(
  roomId: string,
  sub: ManagerListingSubmissionV1,
): RoomBathroomAccessLine[] {
  return bathroomsAccessibleToRoom(roomId, sub).map((bath, index) => ({
    label: `Bathroom ${index + 1}`,
    ...bathroomPrivacyForRoom(bath, roomId, sub),
  }));
}

export function roomBathroomAccessDisplayLines(
  roomId: string,
  sub: ManagerListingSubmissionV1,
): string[] {
  return roomBathroomAccessLines(roomId, sub).map(formatRoomBathroomAccessLine);
}

function splitBathroomModalCopy(full: string): { label: string; detail: string } {
  const parts = full
    .split(" · ")
    .map((s) => s.trim())
    .filter(Boolean);
  if (parts.length <= 1) return { label: full, detail: "" };
  return { label: parts[0]!, detail: parts.slice(1).join(" · ") };
}

/** Short stat-card label (e.g. "En suite", "Shared bathroom"). */
export function roomBathroomModalLabel(
  room: ManagerRoomSubmission,
  sub: ManagerListingSubmissionV1,
): string {
  return splitBathroomModalCopy(describeRoomBathroomSituation(room.id, sub)).label;
}

/** Secondary detail line under the stat-card label. */
export function roomBathroomSetupLine(room: ManagerRoomSubmission, sub: ManagerListingSubmissionV1): string {
  return splitBathroomModalCopy(describeRoomBathroomSituation(room.id, sub)).detail;
}
