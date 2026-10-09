/**
 * The one place a property's display title is composed from its building name and
 * unit label (`deriveLegacyFields` makes the unit label "5 rooms" for a house).
 *
 * A building name that already carries the same fragment ("Magnolia House — 5 rooms")
 * must not get it appended again ("Magnolia House — 5 rooms · 5 rooms").
 */
const ROOM_COUNT_TAIL = /\b\d+\s+rooms?$/i;

function normalise(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLowerCase();
}

/**
 * A title STORED before `composePropertyTitle` deduped ("Alder Row — 3 rooms · 3 rooms") keeps its
 * doubled tail forever, and flows into every message built from the stored string. This collapses
 * a repeated trailing room count to one; any other title is returned untouched.
 */
export function collapseDuplicateRoomCount(label: string): string {
  return label.replace(/\b(\d+\s+rooms?)\s*[\u00b7\u2014\u2013-]\s*\1\s*$/i, "$1").trim();
}

export function composePropertyTitle(buildingName: string | null | undefined, unitLabel: string | null | undefined): string {
  const building = String(buildingName ?? "").trim();
  const unit = String(unitLabel ?? "").trim();
  if (!building) return `Property · ${unit || "Unit"}`;
  if (!unit) return building;
  const b = normalise(building);
  const u = normalise(unit);
  if (b === u || b.endsWith(u)) return building;
  if (ROOM_COUNT_TAIL.test(building) && ROOM_COUNT_TAIL.test(unit)) return building;
  return `${building} · ${unit}`;
}

/**
 * The title to RENDER for a listing. A property saved before `composePropertyTitle` existed
 * carries a stored `title` of "Magnolia House — 5 rooms · 5 rooms"; recomposing from the
 * building name and unit label gives every renderer the same single title.
 */
export function displayPropertyTitle(property: { title?: string | null; buildingName?: string | null; unitLabel?: string | null }): string {
  const building = String(property.buildingName ?? "").trim();
  if (!building) return collapseDuplicateRoomCount(String(property.title ?? "").trim());
  return composePropertyTitle(building, property.unitLabel);
}
