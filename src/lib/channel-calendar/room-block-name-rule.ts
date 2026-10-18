import { isImportedChannelBlock } from "@/lib/channel-calendar/property-bookings";

/**
 * Every booking has a name. A `room_date_block` is either a named reservation
 * (`residentName`) or a room the manager explicitly CLOSED with a reason
 * (`blockKind: "closed"`, e.g. "Painting", "Owner use"). One rule, shared by the
 * Add/Edit sheets, `saveRoomDateBlock`, the `/api/portal-schedule-records`
 * route and the `block_room_dates` assistant tool.
 *
 * A cancelled block (and a delete, which never reaches this rule) is never
 * refused: removing what is already there must always work, whatever shape the
 * row was saved in before the rule existed.
 */
export const ROOM_BLOCK_KIND_CLOSED = "closed" as const;
export type RoomBlockKind = typeof ROOM_BLOCK_KIND_CLOSED;

export function normalizeRoomBlockKind(value: unknown): RoomBlockKind | undefined {
  return value === ROOM_BLOCK_KIND_CLOSED ? ROOM_BLOCK_KIND_CLOSED : undefined;
}

/** "Airbnb" / "Booking" are the import markers (`isImportedChannelBlock`, the one definition): never a real reason to close a room. */
export function isReservedImportReason(reason: string): boolean {
  return isImportedChannelBlock({ reason });
}

export const ROOM_BLOCK_NAME_REQUIRED = "Add the guest's name, or close the room with a reason.";
export const ROOM_BLOCK_REASON_REQUIRED = "Add a reason for closing the room.";
export const ROOM_BLOCK_REASON_RESERVED = "Pick another reason: Airbnb and Booking are reserved for imported stays.";

export function roomDateBlockNameError(input: {
  bookingStatus?: unknown;
  residentName?: unknown;
  blockKind?: unknown;
  reason?: unknown;
}): string | null {
  if (input.bookingStatus === "cancelled") return null;
  if (typeof input.residentName === "string" && input.residentName.trim()) return null;
  if (normalizeRoomBlockKind(input.blockKind) !== ROOM_BLOCK_KIND_CLOSED) return ROOM_BLOCK_NAME_REQUIRED;
  const reason = typeof input.reason === "string" ? input.reason.trim() : "";
  if (!reason) return ROOM_BLOCK_REASON_REQUIRED;
  if (isReservedImportReason(reason)) return ROOM_BLOCK_REASON_RESERVED;
  return null;
}

/**
 * True when a save leaves the stored row's name, kind and reason exactly as
 * they already are: a restore (Undo), a pure date edit, or an edit of a row
 * written before this rule existed. The rule arbitrates NEW content only, so
 * such a save must always go through - otherwise a reserved block saved with
 * no reason (pre-rule) could never have its dates changed again.
 *
 * One definition, shared by the Edit sheet, the `/api/portal-schedule-records`
 * route (`sameRoomBlockNameShape`) and the `update_room_block` tool.
 */
export function roomBlockNameShapeUnchanged(
  prior: { residentName?: unknown; blockKind?: unknown; reason?: unknown },
  next: { residentName?: unknown; blockKind?: unknown; reason?: unknown },
): boolean {
  const text = (value: unknown) => (typeof value === "string" ? value.trim() : "");
  return (
    text(prior.residentName) === text(next.residentName) &&
    text(prior.blockKind) === text(next.blockKind) &&
    text(prior.reason) === text(next.reason)
  );
}
