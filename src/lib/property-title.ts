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
