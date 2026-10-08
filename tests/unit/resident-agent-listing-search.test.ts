// The resident personal agent's housing search: public listings only, an allowlisted card, every manager.
import { describe, expect, it, vi } from "vitest";
import type { MockProperty } from "@/data/types";

vi.mock("@/lib/supabase/service", () => ({ createSupabaseServiceRoleClient: vi.fn() }));
vi.mock("server-only", () => ({}));

import { publicListingProjection } from "@/lib/public-listings.server";
import { RESIDENT_SEARCH_RESULT_LIMIT, searchResidentListings } from "@/lib/resident-agent/listing-search";
import { searchListingsTool } from "@/lib/tools/domains/resident-personal-agent";
import type { ResidentPersonalAgentContext } from "@/lib/tools/resident-personal-agent-context";

const SECRETS = ["Lockbox code 4821", "welcome-home-2026", "001000", "secret-invite", "Owner lives upstairs", "AxisHome-5G"];

/** A stored listing as a manager saved it: public copy PLUS private house data, then run through the public projection. */
function stored(id: string, over: { manager: string; neighborhood: string; beds: number; rent: number; street: string; terms?: string[]; short?: boolean; name?: string }): MockProperty {
  const name = over.name ?? `${over.neighborhood} House`;
  return {
    id,
    title: name,
    tagline: "Bright",
    address: `${over.street}, Seattle, WA 98107`,
    zip: "98107",
    neighborhood: over.neighborhood,
    beds: over.beds,
    baths: 1,
    rentLabel: `from $${over.rent}/mo`,
    available: "Now",
    petFriendly: false,
    buildingId: `b-${id}`,
    buildingName: name,
    unitLabel: "Room A",
    managerUserId: over.manager,
    contactSmsPhone: "+12065550100",
    contactWorkEmail: `${over.manager}@mail.proplane.app`,
    adminPublishLive: true,
    listingSubmission: {
      v: 1,
      buildingName: name,
      address: `${over.street}, Seattle, WA 98107`,
      zip: "98107",
      neighborhood: over.neighborhood,
      homeStructureNote: "",
      tagline: "Bright",
      petFriendly: false,
      houseOverview: "Lovely",
      marketingNotes: "",
      houseRulesText: "",
      amenitiesText: "",
      housePhotoDataUrls: [],
      leaseTermsBody: "12-Month",
      allowedLeaseTerms: over.terms ?? ["12-Month"],
      shortTermRentalsAllowed: over.short === true,
      applicationFee: "45",
      securityDeposit: "500",
      moveInFee: "100",
      paymentAtSigningIncludes: [],
      houseCostsDetail: "",
      parkingMonthly: "0",
      hoaMonthly: "0",
      otherMonthlyFees: "0",
      quickFacts: [],
      bundles: [],
      sharedSpaces: [],
      bathrooms: [],
      rooms: [
        {
          id: `${id}-r1`,
          name: "Room A",
          floor: "2",
          monthlyRent: over.rent,
          occupancyCapacity: 1,
          availability: "Now",
          moveInAvailableDate: "2026-08-01",
          moveInInstructions: "Lockbox code 4821, keys under the mat",
          manualUnavailableRanges: [],
          detail: "Sunny",
          furnishing: "Furnished",
          roomAmenitiesText: "Desk",
          photoDataUrls: [],
          videoDataUrl: null,
          utilitiesEstimate: "60",
          utilitiesPaymentModel: "manager_billed",
          securityDeposit: "650",
        },
      ],
      wifiNetworkName: "AxisHome-5G",
      wifiPassword: "welcome-home-2026",
      generalHouseInfo: "Owner lives upstairs",
      houseInfo: {
        v: 1,
        access: { doorCode: "001000", gateCode: "", keyPickup: "", parking: "", notes: "" },
        wifi: { network: "AxisHome-5G", password: "welcome-home-2026", notes: "" },
        contacts: { groupChatUrl: "https://chat.whatsapp.com/secret-invite", emergency: "" },
      },
    },
  } as unknown as MockProperty;
}

const CATALOG = [
  stored("l-ballard-a", { manager: "mgr-a", neighborhood: "Ballard", beds: 2, rent: 1850, street: "1 Market St" }),
  stored("l-ballard-b", { manager: "mgr-b", neighborhood: "Ballard", beds: 2, rent: 1975, street: "9 24th Ave" }),
  stored("l-ballard-c", { manager: "mgr-c", neighborhood: "Ballard", beds: 2, rent: 2600, street: "5 Leary Way" }),
  stored("l-cap-hill", { manager: "mgr-a", neighborhood: "Capitol Hill", beds: 1, rent: 1500, street: "3 Pike St" }),
  stored("l-short", { manager: "mgr-d", neighborhood: "Fremont", beds: 0, rent: 1200, street: "7 Fremont Ave", terms: ["Short-Term Stay"], short: true }),
].map((p) => publicListingProjection(p));

describe("searchResidentListings", () => {
  it("finds matches from several managers by area, beds and max rent", () => {
    const result = searchResidentListings(CATALOG, { area: "Ballard", beds: 2, maxRent: 2000 });
    expect(result.cards.map((c) => c.listingId)).toEqual(["l-ballard-a", "l-ballard-b"]);
    expect(result.matched).toBe(2);
    expect(result.searched).toBe(CATALOG.length);
    expect(result.cards[0]).toMatchObject({ name: "Ballard House", neighborhood: "Ballard", beds: 2, fromRent: 1850 });
  });

  it("returns cards built field by field: no manager, phone, email, workspace or private house data", () => {
    const result = searchResidentListings(CATALOG, {});
    const json = JSON.stringify(result);
    for (const secret of SECRETS) expect(json).not.toContain(secret);
    for (const key of ["managerUserId", "contactSmsPhone", "contactWorkEmail", "managerContactEmail", "workspaceId", "mgr-a", "+12065550100", "mail.proplane.app"]) {
      expect(json).not.toContain(key);
    }
    for (const card of result.cards) {
      expect(Object.keys(card).sort()).toEqual(
        ["address", "availability", "baths", "beds", "fromRent", "leaseTerms", "listingId", "name", "neighborhood", "petFriendly", "roomsMatching", "zip"].sort(),
      );
    }
  });

  it("filters by stay length and studios, and caps the result", () => {
    expect(searchResidentListings(CATALOG, { term: "short" }).cards.map((c) => c.listingId)).toEqual(["l-short"]);
    expect(searchResidentListings(CATALOG, { term: "long" }).cards.map((c) => c.listingId)).not.toContain("l-short");
    expect(searchResidentListings(CATALOG, { beds: 0 }).cards.map((c) => c.listingId)).toEqual(["l-short"]);
    const many = Array.from({ length: 10 }, (_, i) => stored(`x${i}`, { manager: `m${i}`, neighborhood: "Ballard", beds: 2, rent: 1000 + i, street: `${i} Elm St` }));
    const result = searchResidentListings(many.map((p) => publicListingProjection(p)), { area: "ballard" });
    expect(result.matched).toBe(10);
    expect(result.cards).toHaveLength(RESIDENT_SEARCH_RESULT_LIMIT);
  });

  it("matches nothing for an area no listing is in", () => {
    expect(searchResidentListings(CATALOG, { area: "Tacoma" }).cards).toEqual([]);
  });
});

describe("search_listings tool", () => {
  const ctx = (listings: MockProperty[]) =>
    ({ kind: "resident_personal_agent", userId: "res-1", loadListings: async () => listings }) as unknown as ResidentPersonalAgentContext;

  it("searches only what the public catalog loader returns", async () => {
    // The unpublished listing is simply not in the catalog the loader (getPublicListings) returns.
    const published = CATALOG.filter((p) => p.id !== "l-ballard-c");
    const out = (await searchListingsTool.handler(ctx(published), { area: "Ballard", beds: 2 })) as { cards: { listingId: string }[] };
    expect(out.cards.map((c) => c.listingId)).toEqual(["l-ballard-a", "l-ballard-b"]);
  });

  it("rejects extra properties, so a model cannot pass a manager or owner", () => {
    expect(searchListingsTool.inputSchema.safeParse({ area: "Ballard", managerUserId: "mgr-a" }).success).toBe(false);
  });
});
