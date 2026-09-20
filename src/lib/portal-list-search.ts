/**
 * The one search rule every portal list tab shares.
 *
 * Properties has a search box in its command bar; every other list tab copies
 * it (AGENTS.md → Portal UI system). The box narrows the rows of the CURRENT
 * bucket — tab counts stay the bucket totals — and matches the way a person
 * types: case does not matter, accents do not matter, and every word of the
 * query has to appear somewhere in the row's searchable text ("brooklyn 9"
 * finds the Brooklyn Ave resident in Room 9).
 */

export function normalizePortalSearchText(value: string | number | null | undefined): string {
  if (value == null) return "";
  return String(value)
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

/** Words the query splits into; an empty query has none and matches everything. */
export function portalSearchTerms(query: string | null | undefined): string[] {
  const normalized = normalizePortalSearchText(query);
  return normalized ? normalized.split(" ") : [];
}

/**
 * True when every word of `query` appears in the joined `fields`. Nullish and
 * empty fields are ignored, so callers pass every fact a row shows without
 * guarding each one.
 */
export function matchesPortalListSearch(
  query: string | null | undefined,
  ...fields: Array<string | number | null | undefined>
): boolean {
  const terms = portalSearchTerms(query);
  if (terms.length === 0) return true;
  const haystack = normalizePortalSearchText(fields.filter((f) => f != null && f !== "").join(" "));
  return terms.every((term) => haystack.includes(term));
}
