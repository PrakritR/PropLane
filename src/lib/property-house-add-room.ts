import { emptyRoom, type ManagerListingSubmissionV1 } from "@/lib/manager-listing-submission";

/**
 * Add room opens the room form on a copy of the listing that already holds the new, blank room.
 * Nothing is written until the manager presses Save in that form: cancelling (or closing) simply
 * drops the copy, so no empty "Room N" row is ever left behind.
 *
 * `base` is the listing WITHOUT the new room — the third side
 * {@link mergePendingAddSubmission} diffs the form's answer against.
 */
export function submissionWithNewRoom(sub: ManagerListingSubmissionV1): {
  base: ManagerListingSubmissionV1;
  sub: ManagerListingSubmissionV1;
  roomId: string;
} {
  const rooms = sub.rooms ?? [];
  const room = emptyRoom(rooms.length);
  return { base: sub, sub: { ...sub, rooms: [...rooms, room] }, roomId: room.id };
}

function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

/**
 * Three-way merge of one id-keyed list: a row the form touched is the form's, a row only the sync
 * touched is the sync's, a row either side deleted stays deleted, and a row the form minted is
 * appended.
 */
function mergeIdRows<T extends { id: string }>(
  latest: T[] | undefined,
  base: T[] | undefined,
  edited: T[] | undefined,
): T[] | undefined {
  if (!edited) return latest;
  const baseById = new Map((base ?? []).map((row) => [row.id, row] as const));
  const editedById = new Map(edited.map((row) => [row.id, row] as const));
  const kept = (latest ?? []).flatMap((row) => {
    const editedRow = editedById.get(row.id);
    if (!editedRow) return baseById.has(row.id) ? [] : [row];
    return [sameValue(editedRow, baseById.get(row.id)) ? row : editedRow];
  });
  const latestIds = new Set((latest ?? []).map((row) => row.id));
  const minted = edited.filter((row) => !latestIds.has(row.id) && !baseById.has(row.id));
  return [...kept, ...minted];
}

/**
 * Save of a pending Add room.
 *
 * The form has been editing a COPY of the listing taken when Add room was pressed, and it changes
 * more than the new room: picking that room's bathroom mints a `bathrooms[]` row and stores the
 * room↔bathroom link on it (`applyRoomBathroom` / `addBathroomForRoom` / `copyRoomBathroomLinkFrom`).
 * Writing the copy back whole would discard a sync that landed meanwhile; writing only the new room
 * would discard the bathroom.
 *
 * So this is a field-level three-way merge: `base` is what the form opened on (without the new
 * room), `latest` is the listing as it stands now, `edited` is the form's answer. Every field the
 * form changed is taken from `edited`; every field it left alone keeps `latest`'s value. The
 * id-keyed lists reconcile row by row, so a concurrent change to another room survives.
 */
export function mergePendingAddSubmission(args: {
  base: ManagerListingSubmissionV1;
  latest: ManagerListingSubmissionV1;
  edited: ManagerListingSubmissionV1;
}): ManagerListingSubmissionV1 {
  const { base, latest, edited } = args;
  const merged = { ...latest } as ManagerListingSubmissionV1 & Record<string, unknown>;
  const baseRecord = base as unknown as Record<string, unknown>;
  const editedRecord = edited as unknown as Record<string, unknown>;
  const listKeys = new Set(["rooms", "bathrooms", "sharedSpaces", "bundles", "customFees"]);
  for (const key of new Set([...Object.keys(baseRecord), ...Object.keys(editedRecord)])) {
    if (listKeys.has(key)) continue;
    if (sameValue(editedRecord[key], baseRecord[key])) continue;
    merged[key] = editedRecord[key];
  }
  const rooms = mergeIdRows(latest.rooms, base.rooms, edited.rooms);
  if (rooms) merged.rooms = rooms;
  const bathrooms = mergeIdRows(latest.bathrooms, base.bathrooms, edited.bathrooms);
  if (bathrooms) merged.bathrooms = bathrooms;
  const sharedSpaces = mergeIdRows(latest.sharedSpaces, base.sharedSpaces, edited.sharedSpaces);
  if (sharedSpaces) merged.sharedSpaces = sharedSpaces;
  const bundles = mergeIdRows(latest.bundles, base.bundles, edited.bundles);
  if (bundles) merged.bundles = bundles;
  const customFees = mergeIdRows(latest.customFees, base.customFees, edited.customFees);
  if (customFees) merged.customFees = customFees;
  return merged;
}
