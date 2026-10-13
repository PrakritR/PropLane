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
 * A segment that only a generator writes: a counter (`0001`, `001`), a
 * timestamp (`1760000000000`), or a random blob (`4f2a9c1e`, `m3k2a9bz`).
 * A segment a person types — `unit`, `2`, `8th`, `4709A`, `12A` — is not one,
 * which is what keeps a hyphenated label the manager wrote off the id list.
 */
function looksLikeGeneratedSegment(segment: string): boolean {
  if (/^\d{3,}$/.test(segment)) return true;
  return segment.length >= 6 && /\d/.test(segment) && /[a-z]/i.test(segment);
}

/**
 * True for a stored identifier that must never be shown as a place name:
 * `mgr-qa-c3-house-0001`, `prop_4f2a_001`, `prop_1760000000000_a1b2c3`, a UUID.
 * A single word, a name with spaces ("Unit 3"), an ordinary "room-2" and a
 * hyphenated label a person typed ("unit-2-a", "4709A-8th-Ave") are not ones:
 * three dash-separated parts alone is how a real place name reads too, so the
 * id shape has to come from a part no human writes.
 */
export function looksLikeRawRecordId(value: string | null | undefined): boolean {
  const v = String(value ?? "").trim();
  if (!v || /\s/.test(v)) return false;
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v)) return true;
  if (!/^[a-z0-9]+([-_][a-z0-9]+){2,}$/i.test(v)) return false;
  return v.split(/[-_]/).some(looksLikeGeneratedSegment);
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

/** "5257 Brooklyn Ave · Room 4": the parts that are names, joined; a raw record id reads as nothing. */
export function placeLineWithoutRawIds(...parts: Array<string | null | undefined>): string {
  return parts.map((part) => placeNameOrEmpty(part)).filter(Boolean).join(" · ");
}
