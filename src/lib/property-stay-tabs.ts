/**
 * Long term / Short term tabs on a property record: the ONE rule every section (Applications, Leases,
 * Move-in forms, Services, AI info) reads, so a stay's tab is hidden — or kept — identically everywhere.
 *
 * - A tab exists for each stay the property allows (`listingOfferedStays`; Airbnb counts as short term).
 * - A row that applies to "both" stays shows in BOTH tabs, as the same record.
 * - Never hide data: a stay the property does not allow still gets its tab when it has rows, so a short-term
 *   form on a long-term-only house is never orphaned.
 *
 * Pure. No new stored field: the allowed stays are read from the listing's existing lease-term fields.
 */
import {
  STAY_LABEL,
  listingOfferedStays,
  type StayKey,
} from "@/lib/listing-stays";

export type PropertyStay = StayKey;
/** What a row applies to: one stay or both. Absent on a stored row reads as "both" unless the section derives it. */
export type StayAppliesTo = PropertyStay | "both";

export const PROPERTY_STAYS: readonly PropertyStay[] = ["long_term", "short_term"];

type StaySub = Parameters<typeof listingOfferedStays>[0];

/** The stays this property allows, in tab order (Long term first). Never empty. */
export function allowedStays(sub: StaySub): PropertyStay[] {
  const offered = listingOfferedStays(sub);
  return PROPERTY_STAYS.filter((stay) => offered[stay]);
}

/**
 * The stays that get a tab: each allowed stay, plus any stay that still has rows (`populated`) so no data is
 * hidden. `populated` is either a list of stays that hold rows or a per-stay count.
 */
export function stayTabsFor(
  sub: StaySub,
  populated?: readonly PropertyStay[] | Partial<Record<PropertyStay, number>>,
): PropertyStay[] {
  const allowed = new Set(allowedStays(sub));
  const held = new Set<PropertyStay>(
    Array.isArray(populated)
      ? (populated as readonly PropertyStay[])
      : PROPERTY_STAYS.filter((stay) => ((populated as Partial<Record<PropertyStay, number>> | undefined)?.[stay] ?? 0) > 0),
  );
  return PROPERTY_STAYS.filter((stay) => allowed.has(stay) || held.has(stay));
}

/** True when the stay is one the property does not allow but still has a tab (it holds rows). */
export function isDisallowedStay(sub: StaySub, stay: PropertyStay): boolean {
  return !allowedStays(sub).includes(stay);
}

/** True when a row that applies to `appliesTo` belongs in the `stay` tab ("both" matches both). */
export function inStay(appliesTo: StayAppliesTo | null | undefined, stay: PropertyStay): boolean {
  const value = appliesTo ?? "both";
  return value === "both" || value === stay;
}

/** The stays a row covers, for counting where it shows. */
export function staysCoveredBy(appliesTo: StayAppliesTo | null | undefined): PropertyStay[] {
  return PROPERTY_STAYS.filter((stay) => inStay(appliesTo, stay));
}

/** Rows that show in `stay`'s tab. */
export function rowsInStay<T>(
  rows: readonly T[],
  stay: PropertyStay,
  appliesToOf: (row: T) => StayAppliesTo | null | undefined,
): T[] {
  return rows.filter((row) => inStay(appliesToOf(row), stay));
}

/** Per-stay row counts, used both for the tab counts and for `stayTabsFor`'s never-hide-data rule. */
export function stayCounts<T>(
  rows: readonly T[],
  appliesToOf: (row: T) => StayAppliesTo | null | undefined,
): Record<PropertyStay, number> {
  return {
    long_term: rowsInStay(rows, "long_term", appliesToOf).length,
    short_term: rowsInStay(rows, "short_term", appliesToOf).length,
  };
}

export function stayLabel(stay: PropertyStay): string {
  return STAY_LABEL[stay];
}

/** The "Applies to" value for a row created from the open tab. */
export function appliesToForTab(stay: PropertyStay): StayAppliesTo {
  return stay;
}

/** Narrows a stored value to a real "applies to" or undefined (absent = both). */
export function readStayAppliesTo(raw: unknown): StayAppliesTo | undefined {
  return raw === "long_term" || raw === "short_term" || raw === "both" ? raw : undefined;
}

export type PropertyStayTab<Id extends string = string> = { id: Id; label: string; count?: number };

/** Tab descriptors for the stays that get a tab, in order, each labelled with `labelFor`. */
export function stayTabItems(
  sub: StaySub,
  counts: Record<PropertyStay, number>,
  labelFor: (stay: PropertyStay) => string = stayLabel,
): PropertyStayTab<PropertyStay>[] {
  return stayTabsFor(sub, counts).map((stay) => ({ id: stay, label: labelFor(stay), count: counts[stay] }));
}

