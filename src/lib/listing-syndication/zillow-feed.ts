/**
 * Zillow Rental Network (Zillow · Trulia · HotPads) feed — pure mapping only.
 *
 * INPUT CONTRACT: every listing passed in must already be the output of
 * `publicListingProjection` (`src/lib/public-listings.server.ts`). That
 * projection is the one allowlist every anonymous surface reads through, and
 * this feed is exactly as anonymous — a third party crawls it with no
 * PropLane credential. Do NOT widen this module to accept the raw stored
 * listing; that would carry manager-internal fields (house rules, wifi,
 * lease configuration, opt-in state) past the allowlist a second way.
 *
 * A field the projection does not carry (the manager's structured `city` /
 * `state`, entered on the wizard's Basics step) is genuinely unavailable
 * here. `neighborhood` and a ZIP-prefix lookup are the public-safe stand-ins
 * — see {@link cityFromProperty} and {@link stateFromZip} — and are a known,
 * documented approximation, not a workaround for the allowlist.
 */
import type { MockProperty } from "@/data/types";
import {
  isEntireHomeListing,
  type ManagerListingSubmissionV1,
  type ManagerRoomSubmission,
} from "@/lib/manager-listing-submission";
import { buildManagerListingUrl } from "@/lib/manager-property-links";

export type ZillowFeedExclusionReason = "no_street_address" | "no_photo";

export type ZillowFeedExclusion = {
  propertyId: string;
  reasons: ZillowFeedExclusionReason[];
};

export type ZillowFeedBuildResult = {
  xml: string;
  /** Property ids that made it into the feed. */
  includedIds: string[];
  /** Property ids the feed left out, and why — never given a placeholder instead. */
  excluded: ZillowFeedExclusion[];
};

function escapeXmlText(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function escapeXmlAttr(value: string): string {
  return escapeXmlText(value).replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

function el(tag: string, value: string | number | null | undefined): string {
  if (value === null || value === undefined) return "";
  const text = typeof value === "number" ? String(value) : value.trim();
  if (!text) return "";
  return `<${tag}>${escapeXmlText(text)}</${tag}>`;
}

function isRealPhotoUrl(value: unknown): value is string {
  return typeof value === "string" && /^https?:\/\//i.test(value.trim());
}

/**
 * Real, already-uploaded photo URLs for a listing — whole-home marketing
 * photos first, falling back to room photos for a by-room / shared-home
 * listing. Never a placeholder: an empty result means "no photo", which is
 * an exclusion reason, not something this feed papers over.
 */
export function listingSyndicationPhotoUrls(
  sub: Pick<ManagerListingSubmissionV1, "housePhotoDataUrls" | "rooms"> | undefined,
): string[] {
  if (!sub) return [];
  const house = Array.isArray(sub.housePhotoDataUrls) ? sub.housePhotoDataUrls.filter(isRealPhotoUrl) : [];
  if (house.length > 0) return house;
  const rooms: ManagerRoomSubmission[] = Array.isArray(sub.rooms) ? sub.rooms : [];
  return rooms.flatMap((room) => (Array.isArray(room.photoDataUrls) ? room.photoDataUrls.filter(isRealPhotoUrl) : []));
}

export function listingSyndicationHasStreetAddress(address: string | undefined | null): boolean {
  return Boolean(address?.trim());
}

/** Whole dollars per month, the cheapest available room when the listing is by-room. */
function monthlyRentDollars(sub: ManagerListingSubmissionV1): number | null {
  if (isEntireHomeListing(sub)) {
    const rent = sub.entireHomeMonthlyRent;
    return typeof rent === "number" && rent > 0 ? Math.round(rent) : null;
  }
  const rents = (sub.rooms ?? [])
    .map((room) => room.monthlyRent)
    .filter((rent): rent is number => typeof rent === "number" && rent > 0);
  if (rents.length === 0) return null;
  return Math.round(Math.min(...rents));
}

/**
 * Standard USPS ZIP3 prefix ranges. `city`/`state` are structured wizard
 * fields excluded from the public projection (see module doc); a ZIP the
 * projection DOES carry is public knowledge and a defensible, deterministic
 * stand-in for the state Zillow's schema requires. Approximate at the very
 * small number of ZIP3 prefixes split across a state line.
 */
const ZIP3_STATE_RANGES: readonly [number, number, string][] = [
  [5, 5, "NY"], [6, 9, "PR"], [10, 27, "MA"], [28, 29, "RI"], [30, 38, "NH"], [39, 49, "ME"],
  [50, 59, "VT"], [60, 69, "CT"], [70, 89, "NJ"], [100, 149, "NY"], [150, 196, "PA"], [197, 199, "DE"],
  [200, 205, "DC"], [206, 219, "MD"], [220, 246, "VA"], [247, 268, "WV"], [270, 289, "NC"], [290, 299, "SC"],
  [300, 319, "GA"], [320, 339, "FL"], [341, 342, "FL"], [344, 344, "FL"], [346, 347, "FL"], [349, 349, "FL"],
  [350, 369, "AL"], [370, 385, "TN"], [386, 397, "MS"], [398, 399, "GA"], [400, 427, "KY"], [430, 459, "OH"],
  [460, 479, "IN"], [480, 499, "MI"], [500, 528, "IA"], [530, 549, "WI"], [550, 567, "MN"], [570, 577, "SD"],
  [580, 588, "ND"], [590, 599, "MT"], [600, 629, "IL"], [630, 658, "MO"], [660, 679, "KS"], [680, 693, "NE"],
  [700, 714, "LA"], [716, 729, "AR"], [730, 749, "OK"], [750, 799, "TX"], [800, 816, "CO"], [820, 831, "WY"],
  [832, 838, "ID"], [840, 847, "UT"], [850, 865, "AZ"], [870, 884, "NM"], [889, 898, "NV"], [900, 961, "CA"],
  [967, 968, "HI"], [970, 979, "OR"], [980, 994, "WA"], [995, 999, "AK"],
];

export function stateFromZip(zip: string | undefined | null): string | null {
  const digits = (zip ?? "").trim().slice(0, 5);
  if (!/^\d{3,5}$/.test(digits)) return null;
  const prefix = Number(digits.slice(0, 3));
  for (const [lo, hi, state] of ZIP3_STATE_RANGES) {
    if (prefix >= lo && prefix <= hi) return state;
  }
  return null;
}

/** Public-safe stand-in for a legal city: the wizard's structured `city` never reaches this feed. */
function cityFromProperty(property: MockProperty): string {
  return property.neighborhood?.trim() || property.buildingName?.trim() || "";
}

function propertyTypeFor(sub: ManagerListingSubmissionV1): "house" | "apartment" {
  return isEntireHomeListing(sub) ? "house" : "apartment";
}

/**
 * One `<Listing>` for a property already run through `publicListingProjection`,
 * or `null` with the reason(s) it is excluded. A listing missing a street
 * address or a real photo is left out entirely — never given a placeholder.
 */
function buildListingElement(
  property: MockProperty,
  origin: string,
): { xml: string } | { excluded: ZillowFeedExclusion } {
  const reasons: ZillowFeedExclusionReason[] = [];
  if (!listingSyndicationHasStreetAddress(property.address)) reasons.push("no_street_address");
  const sub = property.listingSubmission;
  const photos = sub ? listingSyndicationPhotoUrls(sub) : [];
  if (photos.length === 0) reasons.push("no_photo");
  if (reasons.length > 0 || !sub) {
    return { excluded: { propertyId: property.id, reasons: reasons.length > 0 ? reasons : ["no_street_address"] } };
  }

  const state = stateFromZip(property.zip);
  const rent = monthlyRentDollars(sub);
  const photoTags = photos.map((url) => `<ListingPhoto source="${escapeXmlAttr(url)}"/>`).join("");
  const listingUrl = buildManagerListingUrl(origin, property.id);

  const body = [
    el("name", property.title || sub.buildingName),
    el("street", property.address),
    el("city", cityFromProperty(property)),
    el("state", state ?? ""),
    el("zip", property.zip),
    property.mapLat !== undefined ? el("lat", property.mapLat) : "",
    property.mapLng !== undefined ? el("lng", property.mapLng) : "",
    rent !== null ? el("price", rent) : "",
    el("numBedrooms", property.beds),
    el("numFullBaths", property.baths),
    sub.houseSizeSqft ? el("squareFeet", sub.houseSizeSqft) : "",
    el("description", sub.houseOverview),
    photoTags,
    property.contactWorkEmail ? el("contactEmail", property.contactWorkEmail) : "",
    property.contactSmsPhone ? el("contactPhone", property.contactSmsPhone) : "",
    el("availableOn", property.available),
    el("listingUrl", listingUrl),
    property.unitLabel ? el("unit", property.unitLabel) : "",
  ]
    .filter(Boolean)
    .join("");

  const attrs = [
    `id="${escapeXmlAttr(property.id)}"`,
    `type="RENTAL"`,
    property.managerUserId ? `companyId="${escapeXmlAttr(property.managerUserId)}"` : "",
    `propertyType="${propertyTypeFor(sub)}"`,
  ]
    .filter(Boolean)
    .join(" ");

  return { xml: `<Listing ${attrs}>${body}</Listing>` };
}

/**
 * Build the Zillow Rental Network (HotPads schema) feed XML for one manager's
 * opted-in, published listings.
 *
 * @param listings Already `publicListingProjection` output — see module doc.
 * @param origin   Absolute app origin used to build each listing's public URL.
 */
export function buildZillowRentalFeedXml(listings: readonly MockProperty[], origin: string): ZillowFeedBuildResult {
  const includedIds: string[] = [];
  const excluded: ZillowFeedExclusion[] = [];
  const items: string[] = [];
  for (const property of listings) {
    const result = buildListingElement(property, origin);
    if ("excluded" in result) {
      excluded.push(result.excluded);
      continue;
    }
    includedIds.push(property.id);
    items.push(result.xml);
  }
  const xml = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<hotPadsItems version="2.1">',
    ...items,
    "</hotPadsItems>",
  ].join("");
  return { xml, includedIds, excluded };
}
