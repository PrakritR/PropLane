export type CalendarCopyHouse = { id: string; name: string };

/**
 * Houses that may receive a copy of the source property's tour availability.
 * When several properties are filtered, destinations are limited to the other
 * filtered houses (source is the first selected filter).
 */
export function buildCalendarCopyDestinationHouses(
  sourcePropertyId: string,
  portfolio: readonly CalendarCopyHouse[],
  activePropertyFilters: readonly string[],
): CalendarCopyHouse[] | undefined {
  const source = sourcePropertyId.trim();
  if (!source) return undefined;

  let destinations = portfolio.filter((property) => property.id !== source);
  if (activePropertyFilters.length > 1) {
    const scoped = new Set(activePropertyFilters);
    destinations = destinations.filter((property) => scoped.has(property.id));
  }

  return destinations.length > 0 ? destinations : undefined;
}

/**
 * Property whose availability grid is the copy source. Uses the first active
 * filter when filtered; otherwise the first house in the current portfolio scope
 * (including the unfiltered "all houses" view).
 */
export function resolveCalendarCopySourcePropertyId(
  activePropertyFilters: readonly string[],
  scopedPropertyIds: readonly string[],
): string {
  if (activePropertyFilters.length >= 1) return activePropertyFilters[0]!;
  if (scopedPropertyIds.length >= 1) return scopedPropertyIds[0]!;
  return "";
}
