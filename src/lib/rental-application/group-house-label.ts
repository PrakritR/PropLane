/**
 * "5257 Brooklyn Ave NE Group 1" — the label every surface uses for a household
 * group (Applications, Residents, Leases).
 *
 * Two things this has to get right, both learned from the Applications header:
 *
 * 1. **A group can span houses.** The header used to call
 *    `householdClusterPropertyLabel`, which returns a label ONLY when every row
 *    shares one property — so a real group with three members at 5257 and one at
 *    5259 fell back to a bare "Group application" with no house at all. The house
 *    is the most useful thing on that row, so we anchor the group to the property
 *    MOST of its rows sit at rather than giving up.
 * 2. **The ordinal is per house, not global.** "Group 1" has to mean "the first
 *    group at this house", or two houses each showing "Group 1" would look like a
 *    bug. Ordinals are assigned over a stable sort of the group id so the number
 *    does not shuffle between renders or between surfaces.
 */
import { stripPropertyRoomCountSuffix } from "@/lib/portal-mobile-preview";

export type GroupHouseRow = {
  /** Normalized group id. Rows with no group are ignored. */
  groupId: string;
  /** Property label as the row displays it (room-count suffix tolerated). */
  property: string;
};

/** Trim the "· 9 rooms" tail and surrounding whitespace. */
function cleanProperty(label: string): string {
  return stripPropertyRoomCountSuffix(label.trim()).trim();
}

/**
 * The property most of a group's rows sit at.
 *
 * Ties break on the alphabetically first label so the answer is stable rather
 * than dependent on row order. Returns null only when no row names a property.
 */
export function dominantPropertyLabel(rows: ReadonlyArray<{ property: string }>): string | null {
  const counts = new Map<string, number>();
  for (const row of rows) {
    const label = cleanProperty(row.property ?? "");
    if (!label) continue;
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  if (counts.size === 0) return null;
  let best: string | null = null;
  let bestCount = 0;
  for (const [label, count] of [...counts.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    if (count > bestCount) {
      best = label;
      bestCount = count;
    }
  }
  return best;
}

/** True when a group's rows are split across more than one property. */
export function groupSpansMultipleProperties(rows: ReadonlyArray<{ property: string }>): boolean {
  const seen = new Set<string>();
  for (const row of rows) {
    const label = cleanProperty(row.property ?? "");
    if (label) seen.add(label);
  }
  return seen.size > 1;
}

/**
 * `groupId -> { property, ordinal }` for every group present in `rows`.
 *
 * The ordinal counts groups within their own house, so the first group at 5257
 * is "Group 1" even if three other groups exist at other properties.
 */
export function numberGroupsByHouse(
  rows: ReadonlyArray<GroupHouseRow>,
): Map<string, { property: string | null; ordinal: number }> {
  const rowsByGroup = new Map<string, GroupHouseRow[]>();
  for (const row of rows) {
    const id = row.groupId?.trim().toUpperCase();
    if (!id) continue;
    const list = rowsByGroup.get(id);
    if (list) list.push(row);
    else rowsByGroup.set(id, [row]);
  }

  const out = new Map<string, { property: string | null; ordinal: number }>();
  const nextOrdinalByProperty = new Map<string, number>();
  // Stable sort on the group id: the ordinal must not depend on row order, or the
  // same group would be "Group 1" on one tab and "Group 2" on the next.
  for (const groupId of [...rowsByGroup.keys()].sort()) {
    const property = dominantPropertyLabel(rowsByGroup.get(groupId)!);
    const key = property ?? "";
    const ordinal = (nextOrdinalByProperty.get(key) ?? 0) + 1;
    nextOrdinalByProperty.set(key, ordinal);
    out.set(groupId, { property, ordinal });
  }
  return out;
}

/**
 * The display label: "5257 Brooklyn Ave NE Group 2", or just "Group 2" when no
 * row in the group names a property.
 */
export function groupHouseLabel(property: string | null, ordinal: number): string {
  const house = property?.trim();
  return house ? `${house} Group ${ordinal}` : `Group ${ordinal}`;
}
