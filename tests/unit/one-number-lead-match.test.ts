// Matching a qualified lead to live PUBLIC rooms, the offer text, and reading the pick.
import { describe, expect, it, vi } from "vitest";
import type { MockProperty } from "@/data/types";
import { storedListing } from "../helpers/lead-listing-fixtures";

vi.mock("@/lib/supabase/service", () => ({ createSupabaseServiceRoleClient: vi.fn() }));
vi.mock("server-only", () => ({}));

import { publicListingProjection } from "@/lib/public-listings.server";
import { buildOfferBubbles, buildOfferText, countFittingRooms, firstOfferPhoto, listingsInArea, matchOffers, matchRooms, offerFromRow, parseOfferPick } from "@/lib/one-number/lead-match";
import type { LineListing, LineTier } from "@/lib/one-number/line-tier";
import type { LeadOffer, LeadProfile } from "@/lib/one-number/lead-qualifying";

const TODAY = "2026-10-18";

const CATALOG: MockProperty[] = [
  storedListing("l-uw-a", { manager: "mgr-a", neighborhood: "University District", beds: 4, rent: 900, street: "4000 15th Ave NE", name: "Brooklyn House" }),
  storedListing("l-uw-b", { manager: "mgr-b", neighborhood: "University District", beds: 4, rent: 1100, street: "4100 Brooklyn Ave NE", name: "Brooklyn Annex" }),
  storedListing("l-uw-d", { manager: "mgr-c", neighborhood: "University District", beds: 4, rent: 950, street: "4200 17th Ave NE", name: "Seventeenth House", furnishing: "Unfurnished" }),
  storedListing("l-ballard", { manager: "mgr-a", neighborhood: "Ballard", beds: 3, rent: 800, street: "9 Market St", name: "Ballard House" }),
  storedListing("l-cap", { manager: "mgr-d", neighborhood: "Capitol Hill", beds: 2, rent: 1500, street: "3 Pike St", name: "Pike House" }),
].map((p) => publicListingProjection(p));

const profile = (over: Partial<LeadProfile>): LeadProfile => ({ budgetMax: 1000, area: "University District", bathroom: "any", furnished: "any", household: 1, leaseMonths: 6, moveInDate: "2026-11-01", ...over });

describe("matchRooms", () => {
  it("filters by area and budget, cheapest first, one room per house", () => {
    const rows = matchRooms(CATALOG, profile({}), TODAY);
    expect(rows.map((r) => r.propertyId)).toEqual(["l-uw-a", "l-uw-d"]);
    expect(rows.map((r) => r.rentNumeric)).toEqual([900, 950]);
  });

  it("a stored listing with no rent label never takes the other houses down with it", () => {
    const broken = { ...CATALOG[0]!, id: "l-broken", rentLabel: undefined, listingSubmission: undefined } as unknown as MockProperty;
    const rows = matchRooms([broken, ...CATALOG], profile({}), TODAY);
    expect(rows.map((r) => r.propertyId)).toEqual(expect.arrayContaining(["l-uw-a", "l-uw-d"]));
  });

  it("an area nobody serves is no match, never a far-away room", () => {
    expect(matchRooms(CATALOG, profile({ area: "Tacoma" }), TODAY)).toEqual([]);
    expect(listingsInArea(CATALOG, "University District").map((p) => p.id).sort()).toEqual(["l-uw-a", "l-uw-b", "l-uw-d"]);
    // any one word may name the place when no listing carries every word
    expect(listingsInArea(CATALOG, "near the Ballard market").map((p) => p.id)).toEqual(["l-ballard"]);
    // a token is a word or a real prefix of one, never a substring: "ok" is not Brooklyn
    expect(listingsInArea(CATALOG, "ok")).toEqual([]);
    expect(listingsInArea(CATALOG, "univ").map((p) => p.id).sort()).toEqual(["l-uw-a", "l-uw-b", "l-uw-d"]);
  });

  it("a skipped area or budget filters nothing on that axis", () => {
    const rows = matchRooms(CATALOG, profile({ area: undefined, budgetMax: undefined, skipped: ["area", "budget"] }), TODAY, 10);
    expect(rows.map((r) => r.propertyId).sort()).toEqual(["l-ballard", "l-cap", "l-uw-a", "l-uw-b", "l-uw-d"]);
  });

  it("furnishing only ranks: a preferred room goes first and none is dropped", () => {
    const wantsFurnished = matchRooms(CATALOG, profile({ budgetMax: 1200, furnished: "yes" }), TODAY).map((r) => r.propertyId);
    expect(wantsFurnished.slice(0, 2)).toEqual(["l-uw-a", "l-uw-b"]);
    expect(wantsFurnished).toContain("l-uw-d");
    const wantsBare = matchRooms(CATALOG, profile({ budgetMax: 1200, furnished: "no" }), TODAY).map((r) => r.propertyId);
    expect(wantsBare[0]).toBe("l-uw-d");
  });

  it("household size never filters", () => {
    expect(matchRooms(CATALOG, profile({ household: 1 }), TODAY).map((r) => r.propertyId)).toEqual(
      matchRooms(CATALOG, profile({ household: 6 }), TODAY).map((r) => r.propertyId),
    );
  });

  it("caps at three offers", () => {
    expect(matchRooms(CATALOG, profile({ area: undefined, budgetMax: 5000, skipped: ["area"] }), TODAY)).toHaveLength(3);
  });
});

describe("the offer text", () => {
  const rows = matchRooms(CATALOG, profile({}), TODAY);
  const offers = rows.map((r, i) => offerFromRow(r, i + 1));

  it("states price, availability and the public listing link, and how to reply", () => {
    const text = buildOfferText(offers, "https://proplane.ai/");
    expect(text).toContain("1) ");
    expect(text).toContain("$900/mo, available now: https://proplane.ai/rent/listings/l-uw-a");
    expect(text).toContain("https://proplane.ai/rent/listings/l-uw-a");
    expect(text).toContain("https://proplane.ai/rent/listings/l-uw-d");
    expect(text.endsWith("Reply 1 or 2 to pick one, or TOUR to see it.")).toBe(true);
  });

  it("carries nothing private: no phone, email, manager or door code", () => {
    const text = buildOfferText(offers, "https://proplane.ai");
    for (const secret of ["mgr-a", "mail.proplane.app", "+12065550100", "Lockbox", "001000", "welcome-home"]) expect(text).not.toContain(secret);
    expect(JSON.stringify(offers)).not.toMatch(/mgr-|mail\.proplane|lockbox/i);
  });

  it("is plain GSM-7", () => {
    const text = buildOfferText(offers, "https://proplane.ai");
    expect(/^[\x20-\x7E\n]*$/.test(text)).toBe(true);
  });

  it("uses a real https listing photo only, never a placeholder", () => {
    expect(firstOfferPhoto(rows)).toBeNull();
    const withPhoto = publicListingProjection(storedListing("l-photo", { manager: "m", neighborhood: "Ballard", beds: 3, rent: 700, street: "1 Elm St", photo: "https://cdn.example.com/room.jpg" }));
    const photoRows = matchRooms([withPhoto], profile({ area: "Ballard" }), TODAY);
    const found = firstOfferPhoto(photoRows);
    expect(found === null || found.startsWith("https://")).toBe(true);
  });
});

describe("buildOfferBubbles", () => {
  const found = matchRooms(CATALOG, profile({}), TODAY);
  const offered = found.map((row, i) => offerFromRow(row, i + 1));
  const photo = (url: string) => ({ kind: "photo" as const, src: url, alt: "" });

  it("sends one text per room, each with its own real photo and listing link, then how to pick", () => {
    const rowsWithPhotos = found.map((row, i) => ({ ...row, mediaSlides: [photo(`https://cdn.example.com/room-${i + 1}.jpg`)] }));
    const bubbles = buildOfferBubbles(offered, rowsWithPhotos as never, "https://proplane.ai/");
    expect(bubbles).toHaveLength(3);
    expect(bubbles[0]).toMatchObject({ mediaUrl: "https://cdn.example.com/room-1.jpg" });
    expect(bubbles[0]!.body).toContain("1) 4000 15th Ave NE, $900/mo");
    expect(bubbles[0]!.body).toContain("https://proplane.ai/rent/listings/l-uw-a");
    expect(bubbles[1]).toMatchObject({ mediaUrl: "https://cdn.example.com/room-2.jpg" });
    expect(bubbles[1]!.body).toContain("2) 4200 17th Ave NE");
    expect(bubbles[2]).toEqual({ body: "Reply 1 or 2 to pick one, or TOUR to see it." });
  });

  it("a room with no real https photo is a plain text, never a placeholder", () => {
    const rowsMixed = found.map((row, i) => ({ ...row, mediaSlides: i === 0 ? [photo("http://insecure.example.com/a.jpg")] : [] }));
    const bubbles = buildOfferBubbles(offered, rowsMixed as never, "https://proplane.ai");
    expect(bubbles.every((b) => b.mediaUrl === undefined)).toBe(true);
    for (const b of bubbles) expect(/^[\x20-\x7E]*$/.test(b.body)).toBe(true);
  });
});

describe("reading the pick", () => {
  const offers: LeadOffer[] = [
    { n: 1, propertyId: "p1", roomId: "r1", label: "5259 Brooklyn Ave", rent: 900, availability: "Now" },
    { n: 2, propertyId: "p2", roomId: "r2", label: "4709A 8th Ave", rent: 950, availability: "Now" },
    { n: 3, propertyId: "p3", roomId: "r3", label: "12 Pine St", rent: 1000, availability: "Now" },
  ];
  const pick = (text: string) => parseOfferPick(text, offers);

  it("takes a number, an ordinal or the house's own words", () => {
    expect(pick("2")).toMatchObject({ kind: "pick", offer: { n: 2 } });
    expect(pick("#3 please")).toMatchObject({ kind: "pick", offer: { n: 3 } });
    expect(pick("option 1")).toMatchObject({ kind: "pick", offer: { n: 1 } });
    expect(pick("the second one")).toMatchObject({ kind: "pick", offer: { n: 2 } });
    expect(pick("last one")).toMatchObject({ kind: "pick", offer: { n: 3 } });
    expect(pick("I like Brooklyn")).toMatchObject({ kind: "pick", offer: { n: 1 } });
    expect(pick("can I see the 8th ave one")).toMatchObject({ kind: "pick", offer: { n: 2 } });
  });

  it("takes 'tell me more about 2' and 'interested in 3', but not a count of bedrooms or people", () => {
    expect(pick("tell me more about 2")).toMatchObject({ kind: "pick", offer: { n: 2 } });
    expect(pick("actually im interested in 3")).toMatchObject({ kind: "pick", offer: { n: 3 } });
    expect(pick("interested in 3 bedrooms")).not.toMatchObject({ kind: "pick" });
    expect(pick("about 2 people")).not.toMatchObject({ kind: "pick" });
  });

  it("a bare tour with several offers asks which; with one it is that one", () => {
    expect(pick("TOUR")).toEqual({ kind: "which" });
    expect(pick("can I schedule a tour?")).toEqual({ kind: "which" });
    expect(parseOfferPick("TOUR", [offers[0]!])).toMatchObject({ kind: "pick", offer: { n: 1 } });
  });

  it("recognizes a decline and ignores chatter", () => {
    expect(pick("none of those")).toEqual({ kind: "decline" });
    expect(pick("no thanks")).toEqual({ kind: "decline" });
    expect(pick("no")).toEqual({ kind: "decline" });
    expect(pick("what is the weather")).toEqual({ kind: "none" });
    expect(parseOfferPick("2", [])).toEqual({ kind: "none" });
  });
});

describe("matchOffers: the stranger's tier mix", () => {
  const tagged = (id: string, tier: LineTier, manager: string, rent: number, street: string): LineListing => ({
    ...publicListingProjection(storedListing(id, { manager, neighborhood: "University District", beds: 4, rent, street, name: `${street} House` })),
    workspaceId: `ws-${manager}`,
    lineTier: tier,
  });
  const p = profile({ budgetMax: 1300 });

  it("one managed, one free-manager and one paid-manager home when each has a fit, cheapest first", () => {
    const catalog = [
      tagged("free-1", "free", "lena", 1000, "1 Free St"),
      tagged("free-2", "free", "ben", 1010, "2 Free St"),
      tagged("paid-1", "paid", "marcus", 1200, "3 Paid St"),
      tagged("svc-1", "managed", "svc", 1250, "4 Managed St"),
      tagged("svc-2", "managed", "svc2", 1260, "5 Managed St"),
      tagged("svc-3", "managed", "svc3", 1270, "6 Managed St"),
    ];
    const offers = matchOffers(catalog, p, TODAY);
    expect(offers.map((o) => o.tier).sort()).toEqual(["free", "managed", "paid"]);
    expect(offers.map((o) => o.row.propertyId)).toEqual(["free-1", "paid-1", "svc-1"]);
  });

  it("never two homes from the same manager; the best fits fill in when a tier has no fit", () => {
    const catalog = [
      tagged("a-1", "managed", "svc", 900, "1 A St"),
      tagged("a-2", "managed", "svc", 910, "2 A St"),
      tagged("b-1", "free", "lena", 950, "3 B St"),
      tagged("b-2", "free", "ben", 960, "4 B St"),
      tagged("b-3", "free", "cy", 970, "5 B St"),
      tagged("b-4", "free", "dee", 980, "6 B St"),
    ];
    const offers = matchOffers(catalog, p, TODAY);
    expect(offers).toHaveLength(3);
    expect(offers.map((o) => o.row.propertyId)).toEqual(["a-1", "b-1", "b-2"]);
  });

  it("exactly four homes from four managers are all offered; an untagged listing counts as managed", () => {
    const four = [tagged("t1", "managed", "m1", 900, "1 T St"), tagged("t2", "free", "m2", 910, "2 T St"), tagged("t3", "paid", "m3", 920, "3 T St"), tagged("t4", "free", "m4", 930, "4 T St")];
    expect(matchOffers(four, p, TODAY)).toHaveLength(4);
    const plain = matchOffers(CATALOG, profile({}), TODAY);
    expect(plain.every((o) => o.tier === "managed")).toBe(true);
  });

  it("counts every fitting room, and an offer never carries a phone number", () => {
    const catalog = [tagged("n1", "paid", "marcus", 1000, "1 N St"), tagged("n2", "free", "lena", 1010, "2 N St")];
    expect(countFittingRooms(catalog, p, TODAY)).toBe(2);
    const picks = matchOffers(catalog, p, TODAY);
    const offers = picks.map((x, i) => offerFromRow(x.row, i + 1, x.tier));
    const bubbles = buildOfferBubbles(offers, picks.map((x) => x.row), "https://proplane.ai");
    for (const body of [buildOfferText(offers, "https://proplane.ai"), ...bubbles.map((b) => b.body)]) {
      expect(body).not.toMatch(/\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}/);
    }
    expect(offers.map((o) => o.tier)).toEqual(["paid", "free"]);
    expect(offers[0]).toMatchObject({ roomName: "Room A" });
  });
});
