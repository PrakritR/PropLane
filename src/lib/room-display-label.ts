/**
 * A room the product shows a human, from whatever the row happens to carry.
 *
 * A stored room can be a plain number ("2"), an already-written label
 * ("Room 2"), or a structured `propertyId::roomId` choice the listing wizard
 * saved ("mgr-test-magnolia::room-2"). The last one leaked into the Payments
 * group header as its raw key, so the rule lives here and every surface that
 * shows a room imports it rather than re-deriving it.
 */
/**
 * True for a stored identifier that must never be shown as a place name:
 * `mgr-qa-c3-house-0001`, `prop_4f2a_001`, a UUID. A single word, a name with
 * spaces ("Unit 3") or an ordinary "room-2" is not one.
 */
export function looksLikeRawRecordId(value: string | null | undefined): boolean {
  const v = String(value ?? "").trim();
  if (!v || /\s/.test(v)) return false;
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v)) return true;
  return /^[a-z0-9]+([-_][a-z0-9]+){2,}$/i.test(v) && /\d/.test(v);
}

/** A property or place name as the person should read it: a raw id reads as nothing. */
export function placeNameOrEmpty(value: string | null | undefined): string {
  const v = String(value ?? "").trim();
  return looksLikeRawRecordId(v) ? "" : v;
}

export function roomDisplayLabel(roomNumber: string | null | undefined): string {
  const trimmed = String(roomNumber ?? "").trim();
  if (!trimmed || trimmed === "—") return "";
  // `propertyId::roomId` (and the `a|b|propertyId::roomId` piped variant the
  // application row uses) — only the room part is the person's business.
  const piped = trimmed.split("|").pop()?.trim() || trimmed;
  const afterScope = piped.includes("::") ? piped.slice(piped.indexOf("::") + 2).trim() : piped;
  if (!afterScope) return "";
  if (looksLikeRawRecordId(afterScope) && !/^room[-_]/i.test(afterScope)) return "";
  // "room-2" / "room_2" are ids, not labels; "Room 2" and "2" are already fine.
  const bare = afterScope.replace(/^room[-_\s]*/i, "").trim();
  if (!bare) return afterScope;
  if (/^room\b/i.test(afterScope) || /^room[-_]/i.test(afterScope)) return `Room ${bare}`;
  // A name that is already a place ("Unit 3", "Studio", "Suite 4B") is not a room number:
  // prefixing it printed "Room Unit 3" / "Room Studio" on payment and inspection rows.
  if (/^[A-Za-z]{3,}/.test(afterScope)) return afterScope;
  return `Room ${afterScope}`;
}
