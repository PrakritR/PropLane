/**
 * Deterministic Seattle place resolver for the leasing agent's "near ..." questions.
 *
 * A prospect says "near University of Washington campus", "U District", "UDistrict near campus", "Capitol Hill",
 * "98105" or "near downtown". The model must not guess coordinates or distances, so the words are resolved HERE, from a
 * small hand-entered table, and the homes are ranked by great-circle distance from the place (or by neighborhood / zip
 * match when a home has no coordinates). No network call is made at reply time.
 *
 * Source of the table: approximate centroids and landmark positions entered by hand from OpenStreetMap and Wikipedia
 * public coordinates, rounded to 4 decimals (about 10 m), and USPS ZIP centroids rounded to 3 decimals. They are good for
 * "within a mile or two" ranking, never for surveying. Add a place by adding a row; `aliases` are lowercase words with
 * punctuation removed ("u-district" is written "u district").
 */

export type SeattlePlaceKind = "landmark" | "neighborhood" | "zip";

export type SeattlePlace = {
  id: string;
  /** What the prospect is told, e.g. "the University of Washington campus". */
  label: string;
  kind: SeattlePlaceKind;
  lat: number;
  lng: number;
  /** Homes within this many miles count as "near". */
  radiusMiles: number;
  /** Lowercase phrases, punctuation removed. Longest match wins. */
  aliases: string[];
  /** Catalog neighborhood spellings that are this place (lowercase), for homes with no coordinates. */
  neighborhoods: string[];
  /** Zip codes that are this place, for homes with neither coordinates nor a neighborhood. */
  zips: string[];
};

const place = (p: SeattlePlace): SeattlePlace => p;

export const SEATTLE_PLACES: readonly SeattlePlace[] = [
  place({
    id: "uw-campus", label: "the University of Washington campus", kind: "landmark", lat: 47.6553, lng: -122.3035, radiusMiles: 1.5,
    aliases: ["university of washington", "u of w", "uw", "uw campus", "uw seattle", "udub", "u dub", "husky stadium", "suzzallo", "campus", "near campus", "the ave"],
    neighborhoods: ["university district", "u district", "udistrict", "university of washington"], zips: ["98195", "98105"],
  }),
  place({
    id: "u-district", label: "the U District", kind: "neighborhood", lat: 47.6614, lng: -122.3135, radiusMiles: 1.25,
    aliases: ["u district", "udistrict", "university district", "university dist", "u dist", "univ district"],
    neighborhoods: ["university district", "u district", "udistrict"], zips: ["98105"],
  }),
  place({
    id: "u-district-station", label: "U District light rail station", kind: "landmark", lat: 47.6600, lng: -122.3141, radiusMiles: 1,
    aliases: ["u district station", "u district light rail", "udistrict station"],
    neighborhoods: ["university district"], zips: ["98105"],
  }),
  place({
    id: "uw-station", label: "UW light rail station", kind: "landmark", lat: 47.6498, lng: -122.3037, radiusMiles: 1,
    aliases: ["uw station", "uw light rail", "husky stadium station"],
    neighborhoods: [], zips: ["98195"],
  }),
  place({
    id: "ravenna", label: "Ravenna", kind: "neighborhood", lat: 47.6757, lng: -122.3050, radiusMiles: 1.25,
    aliases: ["ravenna", "bryant"], neighborhoods: ["ravenna", "bryant"], zips: ["98115"],
  }),
  place({
    id: "roosevelt", label: "Roosevelt", kind: "neighborhood", lat: 47.6766, lng: -122.3170, radiusMiles: 1.25,
    aliases: ["roosevelt"], neighborhoods: ["roosevelt"], zips: ["98115"],
  }),
  place({
    id: "wallingford", label: "Wallingford", kind: "neighborhood", lat: 47.6615, lng: -122.3354, radiusMiles: 1.25,
    aliases: ["wallingford"], neighborhoods: ["wallingford"], zips: ["98103"],
  }),
  place({
    id: "fremont", label: "Fremont", kind: "neighborhood", lat: 47.6511, lng: -122.3500, radiusMiles: 1.25,
    aliases: ["fremont"], neighborhoods: ["fremont"], zips: ["98103"],
  }),
  place({
    id: "green-lake", label: "Green Lake", kind: "neighborhood", lat: 47.6794, lng: -122.3280, radiusMiles: 1.25,
    aliases: ["green lake", "greenlake"], neighborhoods: ["green lake", "greenlake"], zips: ["98103", "98115"],
  }),
  place({
    id: "ballard", label: "Ballard", kind: "neighborhood", lat: 47.6685, lng: -122.3845, radiusMiles: 1.75,
    aliases: ["ballard"], neighborhoods: ["ballard"], zips: ["98107"],
  }),
  place({
    id: "phinney", label: "Phinney Ridge", kind: "neighborhood", lat: 47.6745, lng: -122.3551, radiusMiles: 1.25,
    aliases: ["phinney", "phinney ridge"], neighborhoods: ["phinney ridge", "phinney"], zips: ["98103"],
  }),
  place({
    id: "northgate", label: "Northgate", kind: "neighborhood", lat: 47.7066, lng: -122.3279, radiusMiles: 1.5,
    aliases: ["northgate"], neighborhoods: ["northgate"], zips: ["98125"],
  }),
  place({
    id: "wedgwood", label: "Wedgwood", kind: "neighborhood", lat: 47.6900, lng: -122.2930, radiusMiles: 1.25,
    aliases: ["wedgwood", "view ridge"], neighborhoods: ["wedgwood", "view ridge"], zips: ["98115"],
  }),
  place({
    id: "laurelhurst", label: "Laurelhurst", kind: "neighborhood", lat: 47.6620, lng: -122.2740, radiusMiles: 1.25,
    aliases: ["laurelhurst"], neighborhoods: ["laurelhurst"], zips: ["98105"],
  }),
  place({
    id: "montlake", label: "Montlake", kind: "neighborhood", lat: 47.6449, lng: -122.3021, radiusMiles: 1.25,
    aliases: ["montlake"], neighborhoods: ["montlake"], zips: ["98112"],
  }),
  place({
    id: "capitol-hill", label: "Capitol Hill", kind: "neighborhood", lat: 47.6253, lng: -122.3222, radiusMiles: 1.25,
    aliases: ["capitol hill", "cap hill", "capitol hil"], neighborhoods: ["capitol hill"], zips: ["98102", "98112", "98122"],
  }),
  place({
    id: "eastlake", label: "Eastlake", kind: "neighborhood", lat: 47.6400, lng: -122.3250, radiusMiles: 1,
    aliases: ["eastlake"], neighborhoods: ["eastlake"], zips: ["98102"],
  }),
  place({
    id: "south-lake-union", label: "South Lake Union", kind: "neighborhood", lat: 47.6256, lng: -122.3344, radiusMiles: 1,
    aliases: ["south lake union", "slu", "amazon", "amazon hq"], neighborhoods: ["south lake union"], zips: ["98109"],
  }),
  place({
    id: "queen-anne", label: "Queen Anne", kind: "neighborhood", lat: 47.6372, lng: -122.3568, radiusMiles: 1.5,
    aliases: ["queen anne", "lower queen anne", "uptown"], neighborhoods: ["queen anne", "uptown", "lower queen anne"], zips: ["98109", "98119"],
  }),
  place({
    id: "seattle-center", label: "Seattle Center", kind: "landmark", lat: 47.6205, lng: -122.3493, radiusMiles: 1,
    aliases: ["seattle center", "space needle"], neighborhoods: ["uptown", "lower queen anne"], zips: ["98109"],
  }),
  place({
    id: "belltown", label: "Belltown", kind: "neighborhood", lat: 47.6149, lng: -122.3453, radiusMiles: 1,
    aliases: ["belltown"], neighborhoods: ["belltown"], zips: ["98121"],
  }),
  place({
    id: "downtown", label: "downtown Seattle", kind: "neighborhood", lat: 47.6062, lng: -122.3321, radiusMiles: 1.25,
    aliases: ["downtown", "downtown seattle", "pioneer square", "pike place", "westlake", "cbd"], neighborhoods: ["downtown", "downtown seattle", "pioneer square", "central business district"], zips: ["98101", "98104"],
  }),
  place({
    id: "first-hill", label: "First Hill", kind: "neighborhood", lat: 47.6089, lng: -122.3257, radiusMiles: 1,
    aliases: ["first hill", "pill hill"], neighborhoods: ["first hill"], zips: ["98122", "98104"],
  }),
  place({
    id: "seattle-u", label: "Seattle University", kind: "landmark", lat: 47.6106, lng: -122.3172, radiusMiles: 1,
    aliases: ["seattle university", "seattle u", "su campus"], neighborhoods: ["first hill", "central district"], zips: ["98122"],
  }),
  place({
    id: "central-district", label: "the Central District", kind: "neighborhood", lat: 47.6063, lng: -122.3040, radiusMiles: 1.25,
    aliases: ["central district", "the cd"], neighborhoods: ["central district"], zips: ["98122", "98144"],
  }),
  place({
    id: "spu", label: "Seattle Pacific University", kind: "landmark", lat: 47.6504, lng: -122.3612, radiusMiles: 1,
    aliases: ["seattle pacific", "spu", "seattle pacific university"], neighborhoods: ["queen anne"], zips: ["98119"],
  }),
  place({
    id: "magnolia", label: "Magnolia", kind: "neighborhood", lat: 47.6395, lng: -122.3995, radiusMiles: 1.5,
    aliases: ["magnolia"], neighborhoods: ["magnolia"], zips: ["98199"],
  }),
  place({
    id: "beacon-hill", label: "Beacon Hill", kind: "neighborhood", lat: 47.5793, lng: -122.3112, radiusMiles: 1.5,
    aliases: ["beacon hill"], neighborhoods: ["beacon hill"], zips: ["98108", "98144"],
  }),
  place({
    id: "columbia-city", label: "Columbia City", kind: "neighborhood", lat: 47.5598, lng: -122.2918, radiusMiles: 1.5,
    aliases: ["columbia city", "rainier valley", "rainier beach"], neighborhoods: ["columbia city", "rainier valley"], zips: ["98118"],
  }),
  place({
    id: "west-seattle", label: "West Seattle", kind: "neighborhood", lat: 47.5617, lng: -122.3866, radiusMiles: 2.5,
    aliases: ["west seattle", "alaska junction", "alki", "admiral"], neighborhoods: ["west seattle", "alki", "admiral"], zips: ["98116", "98126", "98136"],
  }),
  place({
    id: "georgetown", label: "Georgetown", kind: "neighborhood", lat: 47.5476, lng: -122.3205, radiusMiles: 1.25,
    aliases: ["georgetown", "sodo"], neighborhoods: ["georgetown", "sodo"], zips: ["98108", "98134"],
  }),
];

/** USPS ZIP centroids for Seattle, for a home that has a zip but no coordinates and for a prospect who types a zip. */
const ZIP_CENTROIDS: Record<string, { lat: number; lng: number; label: string }> = {
  "98101": { lat: 47.611, lng: -122.337, label: "downtown Seattle (98101)" },
  "98102": { lat: 47.632, lng: -122.321, label: "Capitol Hill and Eastlake (98102)" },
  "98103": { lat: 47.673, lng: -122.343, label: "Fremont and Wallingford (98103)" },
  "98104": { lat: 47.602, lng: -122.327, label: "downtown and Pioneer Square (98104)" },
  "98105": { lat: 47.664, lng: -122.288, label: "the University District (98105)" },
  "98107": { lat: 47.670, lng: -122.377, label: "Ballard (98107)" },
  "98108": { lat: 47.540, lng: -122.314, label: "Georgetown and Beacon Hill (98108)" },
  "98109": { lat: 47.632, lng: -122.347, label: "South Lake Union and Queen Anne (98109)" },
  "98112": { lat: 47.630, lng: -122.297, label: "Montlake and Capitol Hill (98112)" },
  "98115": { lat: 47.685, lng: -122.297, label: "Ravenna, Roosevelt and Wedgwood (98115)" },
  "98116": { lat: 47.572, lng: -122.399, label: "West Seattle (98116)" },
  "98117": { lat: 47.689, lng: -122.373, label: "Crown Hill and Greenwood (98117)" },
  "98118": { lat: 47.540, lng: -122.270, label: "Columbia City (98118)" },
  "98119": { lat: 47.637, lng: -122.370, label: "Queen Anne (98119)" },
  "98121": { lat: 47.615, lng: -122.347, label: "Belltown (98121)" },
  "98122": { lat: 47.611, lng: -122.308, label: "First Hill and the Central District (98122)" },
  "98125": { lat: 47.719, lng: -122.303, label: "Northgate (98125)" },
  "98126": { lat: 47.545, lng: -122.373, label: "West Seattle (98126)" },
  "98133": { lat: 47.737, lng: -122.343, label: "Bitter Lake and Broadview (98133)" },
  "98134": { lat: 47.578, lng: -122.335, label: "SoDo (98134)" },
  "98144": { lat: 47.589, lng: -122.301, label: "Beacon Hill and the Central District (98144)" },
  "98177": { lat: 47.745, lng: -122.370, label: "Richmond Beach (98177)" },
  "98195": { lat: 47.655, lng: -122.305, label: "the University of Washington (98195)" },
  "98199": { lat: 47.650, lng: -122.399, label: "Magnolia (98199)" },
};

/** The neighborhood words for a Seattle zip ("Ballard (98107)"), or null when the table does not hold it. A general area, never a street. */
export function zipAreaLabel(zip: string | null | undefined): string | null {
  const key = String(zip ?? "").trim().slice(0, 5);
  return ZIP_CENTROIDS[key]?.label ?? null;
}

const KNOWN_NEIGHBORHOODS = new Set(SEATTLE_PLACES.flatMap((p) => p.neighborhoods.map((n) => normalizePlaceText(n))));

export type ResolvedPlace = {
  id: string;
  label: string;
  kind: SeattlePlaceKind;
  lat: number;
  lng: number;
  radiusMiles: number;
  neighborhoods: string[];
  zips: string[];
};

/** Lowercase, drop punctuation, collapse spaces: "U-District, near campus!" -> "u district near campus". */
export function normalizePlaceText(text: string): string {
  return text.normalize("NFKC").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

/** Whole-phrase containment on normalized text, so "uw" never matches inside "bruwer". */
function containsPhrase(haystack: string, phrase: string): boolean {
  return (` ${haystack} `).includes(` ${phrase} `);
}

/**
 * The place the words name, or null. The longest matching alias wins ("u district station" beats "u district"), a
 * zip code in the text resolves to its centroid, and ties go to the earlier row of the table. A bare "near campus" or
 * "campus" in a Seattle conversation is the University of Washington.
 */
export function resolveSeattlePlace(text: string): ResolvedPlace | null {
  const normalized = normalizePlaceText(text);
  if (!normalized) return null;
  let best: { place: SeattlePlace; length: number } | null = null;
  for (const candidate of SEATTLE_PLACES) {
    for (const alias of candidate.aliases) {
      if (alias.length <= (best?.length ?? 0)) continue;
      if (containsPhrase(normalized, alias)) best = { place: candidate, length: alias.length };
    }
  }
  // "udistrict" typed with no space, or "u-district" written "udistrict": the alias list has both; this catches the joined
  // spelling of "university district" ("universitydistrict").
  if (!best && /\buniversitydistrict\b/.test(normalized)) {
    const u = SEATTLE_PLACES.find((p) => p.id === "u-district");
    if (u) best = { place: u, length: 18 };
  }
  if (best) {
    const { id, label, kind, lat, lng, radiusMiles, neighborhoods, zips } = best.place;
    return { id, label, kind, lat, lng, radiusMiles, neighborhoods: [...neighborhoods], zips: [...zips] };
  }
  const zip = /\b(98\d{3})\b/.exec(normalized)?.[1];
  if (zip) {
    const centroid = ZIP_CENTROIDS[zip];
    return {
      id: `zip-${zip}`, label: centroid?.label ?? `zip ${zip}`, kind: "zip",
      lat: centroid?.lat ?? Number.NaN, lng: centroid?.lng ?? Number.NaN, radiusMiles: 1.5, neighborhoods: [], zips: [zip],
    };
  }
  return null;
}

const EARTH_RADIUS_MILES = 3958.8;

/** Great-circle distance in miles (haversine). */
export function distanceMiles(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const rad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_MILES * Math.asin(Math.min(1, Math.sqrt(h)));
}

export type AreaHome = {
  lat?: number | null;
  lng?: number | null;
  neighborhood?: string | null;
  zip?: string | null;
};

export type AreaMatch = {
  how: "distance" | "neighborhood" | "zip";
  /** Miles from the place, rounded to a tenth; null when matched by neighborhood or zip only. */
  distanceMiles: number | null;
  /** Inside the place's radius (or an exact neighborhood / zip match). */
  near: boolean;
};

function finite(n: unknown): n is number {
  return typeof n === "number" && Number.isFinite(n);
}

/**
 * How one home relates to a place: by distance when it has coordinates, else by its catalog neighborhood, else by zip.
 * Null when nothing connects them.
 */
export function matchHomeToPlace(home: AreaHome, target: ResolvedPlace): AreaMatch | null {
  if (finite(home.lat) && finite(home.lng) && finite(target.lat) && finite(target.lng)) {
    const miles = distanceMiles({ lat: home.lat, lng: home.lng }, target);
    return { how: "distance", distanceMiles: Math.round(miles * 10) / 10, near: miles <= target.radiusMiles };
  }
  const hood = normalizePlaceText(home.neighborhood ?? "");
  if (hood && target.neighborhoods.some((n) => normalizePlaceText(n) === hood)) return { how: "neighborhood", distanceMiles: null, near: true };
  // A home that names a DIFFERENT known neighborhood is not here, whatever its zip shares (98105 spans several).
  if (hood && target.kind !== "zip" && KNOWN_NEIGHBORHOODS.has(hood)) return null;
  const zip = (home.zip ?? "").trim().slice(0, 5);
  if (zip && target.zips.includes(zip)) return { how: "zip", distanceMiles: null, near: true };
  // A home with a zip but no coordinates still has a rough position.
  if (zip && finite(target.lat) && finite(target.lng) && ZIP_CENTROIDS[zip]) {
    const miles = distanceMiles(ZIP_CENTROIDS[zip], target);
    return { how: "zip", distanceMiles: Math.round(miles * 10) / 10, near: miles <= target.radiusMiles + 0.5 };
  }
  return null;
}

/** Sorts homes nearest first: distance, then neighborhood/zip matches (those have no distance) after measured ones that are near. */
export function compareAreaMatches(a: AreaMatch, b: AreaMatch): number {
  if (a.near !== b.near) return a.near ? -1 : 1;
  const da = a.distanceMiles, db = b.distanceMiles;
  if (da !== null && db !== null) return da - db;
  if (da !== null) return -1;
  if (db !== null) return 1;
  return 0;
}
