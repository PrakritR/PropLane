import type { MockProperty } from "@/data/types";

/**
 * A stranger on the PropLane line asks about one specific home: by street address, by house name or by listing title. Pure
 * matching only: the listings passed in are the allowlisted public projection, and only a street line and a city (never a
 * unit or door code) are ever read from them.
 *
 * A street match needs the street NUMBER and at least one significant word of the street NAME, so "1234" alone, or "Maple"
 * alone, never names a home. A misspelled street word (one edit away, 5+ letters) still counts. A name or title match
 * needs the WHOLE name (two or more words) said in order, so "Capitol Hill" never names the home called "Capitol Hill House".
 */

const STREET_SUFFIXES = new Set([
  "st", "street", "ave", "avenue", "av", "rd", "road", "dr", "drive", "ln", "lane", "blvd", "boulevard", "ct", "court",
  "way", "pl", "place", "ter", "terrace", "cir", "circle", "hwy", "pkwy", "parkway", "apt", "unit", "ste", "suite",
  "n", "s", "e", "w", "ne", "nw", "se", "sw", "north", "south", "east", "west",
]);

const words = (s: string): string[] => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().split(" ").filter(Boolean);

/** The part of the address before the first comma: the street line only. */
export function streetLine(address: string): string {
  return String(address ?? "").split(",")[0]!.replace(/\s+/g, " ").trim();
}

/** "1234 Maple St" -> { number: "1234", names: ["maple"] }; null when the line has no leading house number. */
export function parseStreetLine(address: string): { number: string; names: string[] } | null {
  const w = words(streetLine(address));
  const first = w[0];
  if (!first || !/^\d{1,6}[a-z]?$/.test(first)) return null;
  const names = w.slice(1).filter((x) => !STREET_SUFFIXES.has(x) && x.length >= 3);
  if (names.length === 0) return null;
  return { number: first, names };
}

function oneEditAway(a: string, b: string): boolean {
  if (a === b) return true;
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0;
  let j = 0;
  let edits = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      i += 1;
      j += 1;
      continue;
    }
    edits += 1;
    if (edits > 1) return false;
    if (a.length > b.length) i += 1;
    else if (a.length < b.length) j += 1;
    else {
      i += 1;
      j += 1;
    }
  }
  return edits + (a.length - i) + (b.length - j) <= 1;
}

function sameNumber(a: string, b: string): boolean {
  const bare = (x: string) => x.replace(/[a-z]$/, "");
  return a === b || bare(a) === bare(b);
}

function nameInText(name: string, spoken: readonly string[]): boolean {
  return spoken.some((w) => w === name || (name.length >= 5 && w.length >= 5 && oneEditAway(name, w)));
}

/**
 * The ONE listing a text names by address, or null. Several different homes naming the same number and street, or none, is
 * null: this never guesses between two homes.
 */
export function matchListingByAddress<T extends Pick<MockProperty, "id" | "address">>(text: string, listings: readonly T[]): T | null {
  const spoken = words(text);
  if (spoken.length === 0) return null;
  const numbers = spoken.filter((w) => /^\d{1,6}[a-z]?$/.test(w));
  if (numbers.length === 0) return null;
  const hits: T[] = [];
  const seen = new Set<string>();
  for (const listing of listings) {
    const parsed = parseStreetLine(listing.address);
    if (!parsed) continue;
    if (!numbers.some((n) => sameNumber(n, parsed.number))) continue;
    if (!parsed.names.some((name) => nameInText(name, spoken))) continue;
    if (seen.has(listing.id)) continue;
    seen.add(listing.id);
    hits.push(listing);
  }
  return hits.length === 1 ? hits[0]! : null;
}

/** The label a redirect names the home by: its public street line, nothing past the first comma (no unit, no door code). */
export function generalHomeLabel(listing: Pick<MockProperty, "address">): string {
  return streetLine(listing.address);
}

/** "12 Elm St, Louisville": the street line and the city, never a unit, a state, a ZIP or a door code. */
export function homeLabelWithCity(listing: Pick<MockProperty, "address">): string {
  const parts = String(listing.address ?? "").split(",").map((p) => p.replace(/\s+/g, " ").trim());
  const street = parts[0] ?? "";
  const city = parts[1] ?? "";
  // A second segment that is a unit ("Apt 3", "#4"), a ZIP or a state code is not a city.
  const isCity = city.length >= 2 && /[a-z]{2}/i.test(city) && !/^(apt|unit|ste|suite|#|floor|fl)\b/i.test(city) && !/\d/.test(city) && !/^[A-Z]{2}$/.test(city);
  return street && isCity ? `${street}, ${city}` : street;
}

const NAME_STOP = new Set(["the", "a", "an", "house", "home", "room", "rooms", "apartment", "apt", "unit", "studio", "place", "rental", "for", "rent", "near", "in", "at", "of", "and", "with"]);

/** Lowercase alphanumeric words of a name or a text. */
const tokens = (value: string): string[] => String(value ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().split(" ").filter(Boolean);

/** True when `needle` appears in `haystack` as a run of consecutive words. */
function containsPhrase(haystack: readonly string[], needle: readonly string[]): boolean {
  if (needle.length === 0 || needle.length > haystack.length) return false;
  for (let i = 0; i + needle.length <= haystack.length; i += 1) {
    if (needle.every((word, j) => haystack[i + j] === word)) return true;
  }
  return false;
}

/**
 * Does the text say this listing's house name or title in full? Two or more words, at least one that is not a filler word
 * ("house", "room"...), and not just the listing's neighborhood (a title that is only an area never names one home).
 */
export function textNamesListingByName(text: string, listing: Pick<MockProperty, "title" | "buildingName" | "neighborhood">): boolean {
  const spoken = tokens(text);
  if (spoken.length === 0) return false;
  const area = tokens(listing.neighborhood ?? "").join(" ");
  for (const name of [listing.title, listing.buildingName]) {
    const words = tokens(name ?? "");
    if (words.length < 2 || words.join(" ").length < 6) continue;
    if (!words.some((w) => !NAME_STOP.has(w) && w.length >= 3)) continue;
    if (area && words.join(" ") === area) continue;
    if (containsPhrase(spoken, words)) return true;
  }
  return false;
}

export type HomeMatch<T> = { kind: "none" } | { kind: "one"; listing: T } | { kind: "several" };

/** The homes a text names by street, by house name or by title. Distinct homes only; several is "several", never a guess. */
export function matchListingsNamedIn<T extends Pick<MockProperty, "id" | "address" | "title" | "buildingName" | "neighborhood">>(
  text: string,
  listings: readonly T[],
): HomeMatch<T> {
  const hits = new Map<string, T>();
  const byAddress = matchListingByAddress(text, listings);
  if (byAddress) hits.set(byAddress.id, byAddress);
  // An address that names several homes ("1234 Maple" twice) is ambiguous, but it still names a home: never fall to "none".
  const spoken = words(text);
  const numbers = spoken.filter((w) => /^\d{1,6}[a-z]?$/.test(w));
  let ambiguousAddress = false;
  if (!byAddress && numbers.length > 0) {
    const candidates = listings.filter((listing) => {
      const parsed = parseStreetLine(listing.address);
      return Boolean(parsed) && numbers.some((n) => sameNumber(n, parsed!.number)) && parsed!.names.some((name) => nameInText(name, spoken));
    });
    ambiguousAddress = new Set(candidates.map((c) => c.id)).size > 1;
  }
  for (const listing of listings) if (textNamesListingByName(text, listing)) hits.set(listing.id, listing);
  if (hits.size === 0) return ambiguousAddress ? { kind: "several" } : { kind: "none" };
  if (hits.size > 1 || ambiguousAddress) return { kind: "several" };
  return { kind: "one", listing: [...hits.values()][0]! };
}
