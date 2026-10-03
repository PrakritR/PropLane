/**
 * The time zone a property's quiet hours are read in.
 *
 * Quiet hours are a promise to the person receiving the text ("nothing after
 * 8pm"), so they have to be evaluated on THEIR clock. Everything in PropLane
 * used to read `America/Los_Angeles` unconditionally, which meant a vendor in
 * Eastern time with the default 8pm-7am window was texted at 8-11pm local -
 * that being 5-8pm in Los Angeles.
 *
 * A property stores its ZIP, not a zone, so the zone is derived from the ZIP.
 * The table below is by 3-digit ZIP prefix and is deliberately APPROXIMATE: a
 * handful of states straddle a zone boundary (west Kentucky, the Florida
 * panhandle, east Tennessee, north Idaho, west South Dakota, El Paso) and
 * follow their state's majority zone here. An unknown or unparseable ZIP falls
 * back to Pacific, which is what the product assumed before this existed.
 */

export const DEFAULT_PROPERTY_TIME_ZONE = "America/Los_Angeles";

const EASTERN = "America/New_York";
const CENTRAL = "America/Chicago";
const MOUNTAIN = "America/Denver";
const PACIFIC = "America/Los_Angeles";

/** `[firstPrefix, lastPrefix, zone]`, inclusive, on the ZIP's first three digits. */
const ZONE_BY_ZIP_PREFIX: ReadonlyArray<readonly [number, number, string]> = [
  [6, 9, "America/Puerto_Rico"], // PR / VI
  [10, 89, EASTERN], // New England, NY metro, NJ
  [100, 149, EASTERN], // NY
  [150, 199, EASTERN], // PA, DE
  [200, 246, EASTERN], // DC, MD, VA
  [247, 268, EASTERN], // WV
  [270, 299, EASTERN], // NC, SC
  [300, 319, EASTERN], // GA
  [320, 349, EASTERN], // FL
  [350, 369, CENTRAL], // AL
  [370, 385, CENTRAL], // TN
  [386, 397, CENTRAL], // MS
  [398, 399, EASTERN], // GA
  [400, 427, EASTERN], // KY
  [430, 459, EASTERN], // OH
  [460, 479, "America/Indiana/Indianapolis"], // IN
  [480, 499, EASTERN], // MI
  [500, 528, CENTRAL], // IA
  [530, 549, CENTRAL], // WI
  [550, 567, CENTRAL], // MN
  [570, 577, CENTRAL], // SD
  [580, 588, CENTRAL], // ND
  [590, 599, MOUNTAIN], // MT
  [600, 629, CENTRAL], // IL
  [630, 658, CENTRAL], // MO
  [660, 679, CENTRAL], // KS
  [680, 693, CENTRAL], // NE
  [700, 714, CENTRAL], // LA
  [716, 729, CENTRAL], // AR
  [730, 749, CENTRAL], // OK
  [750, 799, CENTRAL], // TX
  [800, 816, MOUNTAIN], // CO
  [820, 831, MOUNTAIN], // WY
  [832, 838, MOUNTAIN], // ID
  [840, 847, MOUNTAIN], // UT
  [850, 865, "America/Phoenix"], // AZ
  [870, 884, MOUNTAIN], // NM
  [889, 898, PACIFIC], // NV
  [900, 961, PACIFIC], // CA
  [967, 968, "Pacific/Honolulu"], // HI
  [970, 979, PACIFIC], // OR
  [980, 994, PACIFIC], // WA
  [995, 999, "America/Anchorage"], // AK
];

/** The IANA zone a US ZIP reads in, or `null` when it is not a ZIP we place. */
export function timeZoneForUsZip(zip: string | null | undefined): string | null {
  const digits = String(zip ?? "").trim().replace(/\D/g, "");
  if (digits.length < 5) return null;
  const prefix = Number(digits.slice(0, 3));
  if (!Number.isFinite(prefix)) return null;
  for (const [from, to, zone] of ZONE_BY_ZIP_PREFIX) {
    if (prefix >= from && prefix <= to) return zone;
  }
  return null;
}

/** The zone, with the Pacific fallback the quiet-hours policy already defaults to. */
export function propertyTimeZoneForZip(zip: string | null | undefined): string {
  return timeZoneForUsZip(zip) ?? DEFAULT_PROPERTY_TIME_ZONE;
}
