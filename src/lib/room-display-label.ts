/**
 * A room the product shows a human, from whatever the row happens to carry.
 *
 * A stored room can be a plain number ("2"), an already-written label
 * ("Room 2"), or a structured `propertyId::roomId` choice the listing wizard
 * saved ("mgr-test-magnolia::room-2"). The last one leaked into the Payments
 * group header as its raw key, so the rule lives here and every surface that
 * shows a room imports it rather than re-deriving it.
 */
export function roomDisplayLabel(roomNumber: string | null | undefined): string {
  const trimmed = String(roomNumber ?? "").trim();
  if (!trimmed || trimmed === "—") return "";
  // `propertyId::roomId` (and the `a|b|propertyId::roomId` piped variant the
  // application row uses) — only the room part is the person's business.
  const piped = trimmed.split("|").pop()?.trim() || trimmed;
  const afterScope = piped.includes("::") ? piped.slice(piped.indexOf("::") + 2).trim() : piped;
  if (!afterScope) return "";
  // "room-2" / "room_2" are ids, not labels; "Room 2" and "2" are already fine.
  const bare = afterScope.replace(/^room[-_\s]*/i, "").trim();
  if (!bare) return afterScope;
  return /^room\b/i.test(afterScope) || /^room[-_]/i.test(afterScope) ? `Room ${bare}` : `Room ${afterScope}`;
}
