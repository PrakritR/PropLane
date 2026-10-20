import type { MockProperty } from "@/data/types";

/**
 * A stranger on the PropLane line asks about one specific street address. Pure matching only: the listings passed in are the
 * allowlisted public projection, and only a street line (never a unit or door code) is ever read from them.
 *
 * A match needs the street NUMBER and at least one significant word of the street NAME, so "1234" alone, or "Maple" alone,
 * never names a home. A misspelled street word (one edit away, 5+ letters) still counts.
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
