/**
 * A notice names a house the way a person does ("5257 Brooklyn Ave"), never by its stored id
 * ("mgr-listing-1x3tiu0489ha"). Pure: no database. `notice-place-label.server.ts` resolves ids against the property
 * records; everything here is the decision of what counts as a raw id and what to say instead.
 */
import { looksLikeRawRecordId } from "@/lib/room-display-label";

/** What a notice says when no display name can be found for the house. */
export const NOTICE_UNKNOWN_HOUSE = "your house";

/** `mgr-…` / `prop-…` style property ids: a known prefix then at least two more segments (`mgr-listing-1x3tiu0489ha`). */
export const RAW_PROPERTY_ID_PATTERN = /(?<![A-Za-z0-9%_/-])(?:mgr|prop|property)[-_][A-Za-z0-9]+(?:[-_][A-Za-z0-9]+)+(?![A-Za-z0-9])/gi;

const URL_PATTERN = /https?:\/\/[^\s<>]+/gi;

/** The first candidate that reads as a name (not empty, not an id); else the unknown-house phrase. */
export function noticePlaceName(...candidates: Array<string | null | undefined>): string {
  for (const candidate of candidates) {
    const value = String(candidate ?? "").trim();
    if (value && !looksLikeRawRecordId(value) && !hasRawPropertyId(value)) return value;
  }
  return NOTICE_UNKNOWN_HOUSE;
}

/** Raw property ids written in the prose of `text` (links are left alone: an id inside a URL is a path, not copy). */
export function findRawPropertyIds(text: string): string[] {
  const prose = String(text ?? "").replace(URL_PATTERN, " ");
  return [...new Set(prose.match(RAW_PROPERTY_ID_PATTERN) ?? [])];
}

export function hasRawPropertyId(text: string): boolean {
  return findRawPropertyIds(text).length > 0;
}

/** `text` with every raw property id in its prose replaced by `names[id]` (or the unknown-house phrase). Links are untouched. */
export function scrubRawPropertyIds(text: string, names: ReadonlyMap<string, string>): string {
  const source = String(text ?? "");
  const parts = source.split(/(https?:\/\/[^\s<>]+)/gi);
  return parts
    .map((part, index) => (index % 2 === 1 ? part : part.replace(RAW_PROPERTY_ID_PATTERN, (id) => noticePlaceName(names.get(id)))))
    .join("");
}
