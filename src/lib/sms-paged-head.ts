/** A refreshed first page may keep an older loaded window only if their IDs meet. */
export function hasPagedHeadOverlap<T>(
  fresh: readonly T[],
  loaded: readonly T[],
  idOf: (row: T) => string,
): boolean {
  if (!fresh.length || !loaded.length) return false;
  const loadedIds = new Set(loaded.map(idOf));
  return fresh.some((row) => loadedIds.has(idOf(row)));
}

export function refreshedPageCursor<T>(
  fresh: readonly T[],
  loaded: readonly T[],
  freshCursor: string | null | undefined,
  loadedCursor: string | null,
  idOf: (row: T) => string,
): { overlaps: boolean; nextCursor: string | null } {
  const overlaps = hasPagedHeadOverlap(fresh, loaded, idOf);
  return { overlaps, nextCursor: overlaps ? loadedCursor : freshCursor ?? null };
}
