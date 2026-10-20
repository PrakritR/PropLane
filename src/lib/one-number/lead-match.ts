import type { MockProperty } from "@/data/types";
import {
  classifyRoomAvailability,
  filterRoomListings,
  shortBathHint,
  type RoomListingRow,
} from "@/lib/room-listings-catalog";
import { compareAreaMatches, matchHomeToPlace, resolveSeattlePlace, type AreaMatch } from "@/lib/places/seattle-places";
import { toGsm7, type LeadOffer, type LeadProfile } from "@/lib/one-number/lead-qualifying";

/**
 * Matching and offers for the Unassigned-leads agent. The listings passed in are what
 * `getServicePublicListings()` returns (PropLane-managed homes only): already run through `publicListingProjection`, the one
 * allowlist every anonymous reader shares. Nothing here reads a private row, and an offer carries
 * only facts a browse page already shows: a street line, a price, an availability label, a link.
 *
 * Match inputs are price, dates, location and room features. Household size never filters.
 */

export const MAX_OFFERS = 3;

const STOP_WORDS = new Set(["in", "near", "the", "area", "of", "around", "by", "at", "a", "an", "to", "close", "my", "work", "school", "campus", "downtown"]);

function areaTokens(area: string | undefined): string[] {
  return (area ?? "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 1 && !STOP_WORDS.has(t));
}

function locationWords(p: MockProperty): string[] {
  return [p.neighborhood, p.address, p.zip, p.title, p.buildingName].join(" ").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}

/** A token names a place when it is one of the listing's words, or a real prefix of one ("univ" for University). Never a substring: "ok" is not Brooklyn. */
function namesPlace(words: string[], token: string): boolean {
  return words.some((w) => w === token || (token.length >= 4 && w.startsWith(token)));
}

/**
 * Listings whose public location names the prospect's area. Every word first, then any word. An area we cannot find
 * anywhere yields nothing rather than a far-away room: a stranger told "near UW" is never sent across town.
 */
export function listingsInArea(listings: readonly MockProperty[], area: string | undefined): MockProperty[] {
  // A landmark or neighborhood the resolver knows ("UW", "near campus", "Capitol Hill", a zip) ranks homes by distance.
  const place = resolveSeattlePlace(area ?? "");
  if (place) {
    const near = listings
      .map((p) => ({ p, m: matchHomeToPlace({ lat: p.mapLat, lng: p.mapLng, neighborhood: p.neighborhood, zip: p.zip }, place) }))
      .filter((x): x is { p: MockProperty; m: AreaMatch } => x.m !== null && x.m.near)
      .sort((a, b) => compareAreaMatches(a.m, b.m));
    if (near.length > 0) return near.map((x) => x.p);
  }
  const tokens = areaTokens(area);
  if (tokens.length === 0) return [...listings];
  const all = listings.filter((p) => {
    const words = locationWords(p);
    return tokens.every((t) => namesPlace(words, t));
  });
  if (all.length > 0) return all;
  return listings.filter((p) => {
    const words = locationWords(p);
    return tokens.some((t) => namesPlace(words, t));
  });
}

function addMonths(isoDate: string, months: number): string {
  const [y, m, d] = isoDate.split("-").map(Number) as [number, number, number];
  const out = new Date(Date.UTC(y, m - 1 + months, d));
  return out.toISOString().slice(0, 10);
}

/** What a room says about furnishing: the room's own public `furnishing` field, then the listing blurb and tags. */
function furnishingText(row: RoomListingRow, byId: Map<string, MockProperty>): string {
  const sub = byId.get(row.propertyId)?.listingSubmission;
  const room = sub && sub.v === 1 ? sub.rooms?.find((r) => r.id === row.roomId) : undefined;
  return `${room?.furnishing ?? ""} ${row.descriptionBlurb} ${row.listingTags.join(" ")}`.toLowerCase();
}

/** Rooms that fit, cheapest first, furnished preference ranking only. At most one room per house. */
export function matchRooms(
  listings: readonly MockProperty[],
  profile: LeadProfile,
  today: string,
  limit: number = MAX_OFFERS,
): RoomListingRow[] {
  const skipped = new Set(profile.skipped ?? []);
  const inArea = skipped.has("area") ? [...listings] : listingsInArea(listings, profile.area);
  if (inArea.length === 0) return [];
  const moveIn = profile.moveInDate && profile.moveInDate >= today ? profile.moveInDate : undefined;
  const moveOut = moveIn && (profile.leaseMonths ?? 0) > 0 ? addMonths(moveIn, profile.leaseMonths!) : undefined;
  const filter = {
    zipRaw: "",
    radiusMiles: 50,
    maxBudgetNum: profile.budgetMax && profile.budgetMax > 0 && !skipped.has("budget") ? profile.budgetMax : null,
    bathroom: profile.bathroom === "private" ? ("private" as const) : ("any" as const),
    moveIn,
    moveOut,
  };
  // One house at a time: a stored listing with a missing field (no rent label) must drop out of the
  // search, never take every other team's rooms down with it (found by the end-to-end harness).
  const rows: RoomListingRow[] = [];
  for (const listing of inArea) {
    try {
      rows.push(...filterRoomListings([listing], filter));
    } catch (error) {
      console.error("lead match skipped a listing", listing.id, error instanceof Error ? error.name : "unknown");
    }
  }
  const fits = rows.filter((row) => {
    if (row.rentNumeric === null || row.rentNumeric <= 0) return false;
    if (classifyRoomAvailability(row.availabilityRaw) === "unavailable") return false;
    if (profile.bathroom === "shared" && shortBathHint(row.bathroomHint) === "Private bath") return false;
    return true;
  });
  const prefersFurnished = profile.furnished === "yes";
  const prefersBare = profile.furnished === "no";
  const byId = new Map(inArea.map((p) => [p.id, p] as const));
  const rank = (row: RoomListingRow) => {
    const text = furnishingText(row, byId);
    const unfurnished = /\bunfurnished\b/.test(text);
    const furnished = !unfurnished && /\bfurnished\b/.test(text);
    if (prefersFurnished) return furnished ? 0 : 1;
    if (prefersBare) return unfurnished || !furnished ? 0 : 1;
    return 0;
  };
  const sorted = [...fits].sort((a, b) => rank(a) - rank(b) || (a.rentNumeric ?? 0) - (b.rentNumeric ?? 0));
  const seen = new Set<string>();
  const out: RoomListingRow[] = [];
  for (const row of sorted) {
    if (seen.has(row.propertyId)) continue;
    seen.add(row.propertyId);
    out.push(row);
    if (out.length >= limit) break;
  }
  return out;
}

/** "available now" / "available Nov 1", from the room's own availability text (never the count-style card label). */
function availabilityPhrase(raw: string): string {
  const t = raw.replace(/\s+/g, " ").trim();
  if (!t || /^now$/i.test(t)) return "available now";
  return /^available/i.test(t) ? `a${t.slice(1)}` : `available ${t}`;
}

export function offerFromRow(row: RoomListingRow, n: number): LeadOffer {
  return {
    n,
    propertyId: row.propertyId,
    roomId: row.roomId,
    label: row.headlineAddress.trim() || row.neighborhood.trim() || "this house",
    rent: row.rentNumeric !== null ? Math.round(row.rentNumeric) : null,
    availability: availabilityPhrase(row.availabilityRaw),
  };
}

/** The first real listing photo among the offered rooms (one MMS at most). Never a placeholder. */
export function firstOfferPhoto(rows: readonly RoomListingRow[]): string | null {
  for (const row of rows) {
    const slide = row.mediaSlides.find((s) => s.kind === "photo" && /^https:\/\/[^\s]+$/i.test(s.src));
    if (slide) return slide.src;
  }
  return null;
}

/** The first real https photo of one room (never a placeholder), or null. */
export function roomPhoto(row: RoomListingRow): string | null {
  const slide = row.mediaSlides.find((s) => s.kind === "photo" && /^https:\/\/[^\s]+$/i.test(s.src));
  return slide ? slide.src : null;
}

const shortAvailability = (label: string) => {
  const t = label.replace(/\s+/g, " ").trim();
  if (!t) return "ask for dates";
  return t.length > 24 ? t.slice(0, 24).trim() : t;
};

/** "1) 5259 Brooklyn Ave, $850/mo, available now: https://..." for each, then how to reply. */
export function buildOfferText(offers: readonly LeadOffer[], origin: string): string {
  const base = origin.replace(/\/$/, "");
  const lines = offers.map((o) => {
    const price = o.rent !== null ? `$${o.rent}/mo` : "price on listing";
    return `${o.n}) ${o.label}, ${price}, ${shortAvailability(o.availability)}: ${base}/rent/listings/${encodeURIComponent(o.propertyId)}`;
  });
  const reply = offers.length === 1 ? "Reply 1 to pick it, or TOUR to see it." : `Reply ${offers.map((o) => o.n).join(", ").replace(/, (\d)$/, " or $1")} to pick one, or TOUR to see it.`;
  return toGsm7([offers.length === 1 ? "This room fits:" : "These rooms fit:", ...lines, reply].join("\n"));
}

export type OfferBubble = { body: string; mediaUrl?: string };

/**
 * The offer as one text per room, each with that room's own real photo and its listing link (the spec's
 * "top 2-3, each with price, area, available date, one MMS photo and a gallery link"), then one text that
 * says how to pick. `rows[i]` is the room behind `offers[i]`. A room with no real photo is a plain text.
 */
export function buildOfferBubbles(offers: readonly LeadOffer[], rows: readonly RoomListingRow[], origin: string): OfferBubble[] {
  const base = origin.replace(/\/$/, "");
  const bubbles: OfferBubble[] = offers.map((o, i) => {
    const price = o.rent !== null ? `$${o.rent}/mo` : "price on listing";
    const body = toGsm7(`${o.n}) ${o.label}, ${price}, ${shortAvailability(o.availability)}: ${base}/rent/listings/${encodeURIComponent(o.propertyId)}`);
    const photo = rows[i] ? roomPhoto(rows[i]!) : null;
    return photo ? { body, mediaUrl: photo } : { body };
  });
  const reply = offers.length === 1 ? "Reply 1 to pick it, or TOUR to see it." : `Reply ${offers.map((o) => o.n).join(", ").replace(/, (\d)$/, " or $1")} to pick one, or TOUR to see it.`;
  bubbles.push({ body: toGsm7(reply) });
  return bubbles;
}

export const NO_MATCH_TEXT = "I do not have a room that fits right now. I will text you once if one opens up.";

// ---------------------------------------------------------------------------
// Reading the prospect's pick
// ---------------------------------------------------------------------------

export type OfferPick =
  | { kind: "pick"; offer: LeadOffer }
  | { kind: "which" }
  | { kind: "decline" }
  | { kind: "none" };

const ORDINALS: Record<string, number> = { first: 1, "1st": 1, second: 2, "2nd": 2, third: 3, "3rd": 3 };
const TOUR_INTENT = /\b(tour|tours|visit|see (?:it|the|that|this)|view(?:ing)?|come (?:by|see)|schedule|book|apply|application|interested|take it|i'?ll take|sounds good|that one|this one)\b/i;
const DECLINE = /^(?:none|neither|nothing|no thanks?|no thank you|nope|not interested|pass|something else|different|other|more options|any others?|others?)\b|^no[.!]?$/i;
const FILLER = new Set(["the", "a", "an", "at", "on", "in", "of", "and", "or", "one", "it", "that", "this", "please", "i", "ll", "like", "to", "tour", "see", "visit", "want", "ave", "st", "street", "avenue", "rd", "road", "way", "house", "room", "place"]);

const words = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().split(" ").filter(Boolean);

/** Which offer a text picks: a number, an ordinal, or the house's own words. A bare "tour" with several offers asks which. */
export function parseOfferPick(text: string, offers: readonly LeadOffer[]): OfferPick {
  const t = text.trim();
  if (offers.length === 0 || !t) return { kind: "none" };
  if (DECLINE.test(t)) return { kind: "decline" };

  // A leading digit alone is NOT a pick: "2 people" and "1 bed" are answers to the qualifying questions, and a pick
  // claims the lead for one workspace for good. It takes a marker ("#2", "option 2", "the 2") or a digit-only message.
  const numbered =
    t.match(/^(?:#\s*|option\s*|number\s*|no\.?\s*|the\s+)(\d)\b/i) ?? t.match(/^(\d)\s*[.!]*$/);
  if (numbered) {
    const hit = offers.find((o) => o.n === Number(numbered[1]));
    if (hit) return { kind: "pick", offer: hit };
  }
  const inline = t.match(/\b(?:option|number|#)\s*(\d)\b/i);
  if (inline) {
    const hit = offers.find((o) => o.n === Number(inline[1]));
    if (hit) return { kind: "pick", offer: hit };
  }
  for (const [word, n] of Object.entries(ORDINALS)) {
    if (new RegExp(`\\b${word}\\b`, "i").test(t)) {
      const hit = offers.find((o) => o.n === n);
      if (hit) return { kind: "pick", offer: hit };
    }
  }
  if (/\blast one\b/i.test(t)) return { kind: "pick", offer: offers[offers.length - 1]! };

  const spoken = new Set(words(t).filter((w) => !FILLER.has(w)));
  if (spoken.size > 0) {
    const named = offers.filter((o) => {
      const labelWords = words(o.label).filter((w) => !FILLER.has(w));
      return labelWords.length > 0 && labelWords.some((w) => spoken.has(w));
    });
    if (named.length === 1) return { kind: "pick", offer: named[0]! };
  }
  if (TOUR_INTENT.test(t)) {
    return offers.length === 1 ? { kind: "pick", offer: offers[0]! } : { kind: "which" };
  }
  return { kind: "none" };
}
