import { describe, expect, it, vi } from "vitest";

// The projection itself is pure; the module it lives in reaches for Supabase at
// import time for the catalog query it also exports.
vi.mock("@/lib/supabase/service", () => ({ createSupabaseServiceRoleClient: vi.fn() }));

import { publicListingProjection } from "@/lib/public-listings.server";
import type { MockProperty } from "@/data/types";

/** A stored listing carrying both prospect-facing copy and manager-internal data. */
function storedListing(): MockProperty {
  return {
    id: "mgr-1",
    title: "Ballard House",
    tagline: "Bright rooms",
    address: "1 Main St",
    zip: "98107",
    neighborhood: "Ballard",
    beds: 3,
    baths: 2,
    rentLabel: "from $900/mo",
    available: "Now",
    petFriendly: true,
    buildingId: "b1",
    buildingName: "Ballard House",
    unitLabel: "Room A",
    managerUserId: "mgr-user",
    adminPublishLive: true,
    listingSubmission: {
      v: 1,
      buildingName: "Ballard House",
      address: "1 Main St",
      zip: "98107",
      neighborhood: "Ballard",
      homeStructureNote: "3-story",
      tagline: "Bright rooms",
      petFriendly: true,
      houseOverview: "Lovely",
      houseRulesText: "No smoking",
      amenitiesText: "Laundry",
      housePhotoDataUrls: ["https://cdn/photo.jpg"],
      leaseTermsBody: "12-Month",
      applicationFee: "45",
      securityDeposit: "500",
      moveInFee: "100",
      paymentAtSigningIncludes: [],
      houseCostsDetail: "",
      parkingMonthly: "0",
      hoaMonthly: "0",
      otherMonthlyFees: "0",
      quickFacts: [{ id: "q1", label: "Built", value: "1998" }],
      bundles: [{ id: "b1", label: "Rooms A+B", price: "$1700", strikethrough: "", promo: "", roomsLine: "" }],
      sharedSpaces: [],
      bathrooms: [],
      rooms: [
        {
          id: "r1",
          name: "Room A",
          floor: "2",
          monthlyRent: 900,
          // Shared room: a prospect must be able to see how many beds are left.
          occupancyCapacity: 2,
          availability: "Now",
          moveInAvailableDate: "2026-08-01",
          // Manager/resident-internal: door codes and key handoff.
          moveInInstructions: "Lockbox code 4821, keys under the mat",
          moveInPhotoDataUrls: ["https://cdn.example/move-in-photo.jpg"],
          moveInVideoDataUrl: "https://cdn.example/move-in-video.mp4",
          manualUnavailableRanges: [],
          detail: "Sunny",
          furnishing: "Furnished",
          roomAmenitiesText: "Desk",
          photoDataUrls: [],
          videoDataUrl: null,
          utilitiesEstimate: "60",
        },
      ],
      // None of the following may reach a prospect.
      wifiNetworkName: "AxisHome-5G",
      wifiPassword: "welcome-home-2026",
      generalHouseInfo: "Owner lives upstairs",
      houseMoveInInstructions: "Garage remote in kitchen drawer",
      leaseConfigMode: "custom",
      leaseCustomKind: "document",
      leaseTemplateDocName: "Attorney lease 2026.pdf",
      leaseTemplateDocUrl: "/api/portal/lease-template?path=abc/1.pdf",
      customLeaseTerms: "Tenant waives...",
      propertyLeaseTemplates: [
        {
          id: "t1",
          kind: "custom",
          label: "Corporate lease",
          leaseTemplateDocUrl: "/api/portal/lease-template?path=abc/2.pdf",
        },
      ],
      serviceRequestOptions: [
        {
          id: "s1",
          name: "Parking",
          description: "",
          price: "100",
          deposit: "0",
          available: true,
          residentEmails: ["resident@example.com"],
          createdAt: "2026-01-01",
        },
      ],
      lateFeeAmount: "75",
      achPaymentLink: "https://bank.example/pay/secret-token",
    },
  } as unknown as MockProperty;
}

/** Every key in the projected payload, at any depth. */
function allKeys(value: unknown, out = new Set<string>()): Set<string> {
  if (!value || typeof value !== "object") return out;
  if (Array.isArray(value)) {
    for (const item of value) allKeys(item, out);
    return out;
  }
  for (const [key, child] of Object.entries(value)) {
    out.add(key);
    allKeys(child, out);
  }
  return out;
}

describe("publicListingProjection", () => {
  it("drops every manager- and resident-internal field, at any depth", () => {
    const keys = allKeys(publicListingProjection(storedListing()));
    for (const secret of [
      "wifiPassword",
      "wifiNetworkName",
      "generalHouseInfo",
      "houseMoveInInstructions",
      "leaseTemplateDocUrl",
      "leaseTemplateDocName",
      "propertyLeaseTemplates",
      "customLeaseTerms",
      "leaseConfigMode",
      "leaseCustomKind",
      "serviceRequestOptions",
      "residentEmails",
      "lateFeeAmount",
      "achPaymentLink",
      "moveInInstructions",
      "moveInPhotoDataUrls",
      "moveInVideoDataUrl",
      "houseMoveInPhotoDataUrls",
      "houseMoveInVideoDataUrl",
    ]) {
      expect(keys.has(secret), `${secret} must not reach an anonymous caller`).toBe(false);
    }
  });

  it("denies by default: a field added to the submission later is not published", () => {
    const listing = storedListing();
    (listing.listingSubmission as unknown as Record<string, unknown>).someFutureField = "value";
    (listing as unknown as Record<string, unknown>).internalOwnerNote = "seller is motivated";

    const projected = publicListingProjection(listing);
    expect(allKeys(projected).has("someFutureField")).toBe(false);
    expect(allKeys(projected).has("internalOwnerNote")).toBe(false);
  });

  it("keeps the building compliance inputs off the public payload", () => {
    // These landed on the submission AFTER the allowlist was written (the
    // disclosure-trigger work), and deny-by-default kept them private without
    // anyone editing this projection. They are regulatory inputs to the lease
    // disclosure engine, not listing marketing — a registration number and an
    // occupancy date in particular are manager compliance records. Pinned here
    // so a later "make the listing richer" pass has to argue the case.
    const listing = storedListing();
    Object.assign(listing.listingSubmission as unknown as Record<string, unknown>, {
      yearBuilt: 1962,
      sharedUtilityMetering: true,
      hasPeriodicPestService: true,
      certificateOfOccupancyDate: "1962-04-01",
      rrioRegistrationNumber: "RRIO-12345",
    });

    const keys = allKeys(publicListingProjection(listing));
    for (const field of [
      "yearBuilt",
      "sharedUtilityMetering",
      "hasPeriodicPestService",
      "certificateOfOccupancyDate",
      "rrioRegistrationNumber",
    ]) {
      expect(keys.has(field), `${field} must not reach an anonymous caller`).toBe(false);
    }
  });

  it("keeps what browse, listing detail and the apply wizard read", () => {
    const projected = publicListingProjection(storedListing());
    const sub = projected.listingSubmission!;

    // Every required submission field survives — the listing renderers call
    // .trim()/.map() on these unguarded and fall back to a generic demo listing
    // when one is missing.
    for (const required of [
      "v",
      "buildingName",
      "address",
      "zip",
      "neighborhood",
      "homeStructureNote",
      "tagline",
      "petFriendly",
      "houseOverview",
      "houseRulesText",
      "amenitiesText",
      "housePhotoDataUrls",
      "leaseTermsBody",
      "applicationFee",
      "securityDeposit",
      "moveInFee",
      "paymentAtSigningIncludes",
      "houseCostsDetail",
      "parkingMonthly",
      "hoaMonthly",
      "otherMonthlyFees",
      "rooms",
      "bathrooms",
      "sharedSpaces",
      "bundles",
      "quickFacts",
    ]) {
      expect(sub, `${required} is load-bearing for the public listing`).toHaveProperty(required);
    }

    expect(projected.contactSmsPhone).toBeUndefined();
    expect(projected.managerUserId).toBe("mgr-user");
    expect(projected.adminPublishLive).toBe(true);
    expect(sub.rooms[0]).toMatchObject({ id: "r1", monthlyRent: 900, availability: "Now", occupancyCapacity: 2 });
    expect(sub.quickFacts[0]).toEqual({ id: "q1", label: "Built", value: "1998" });
  });

  it("passes through a listing with no submission", () => {
    const listing = storedListing();
    delete (listing as { listingSubmission?: unknown }).listingSubmission;
    const projected = publicListingProjection(listing);
    expect(projected.listingSubmission).toBeUndefined();
    expect(projected.title).toBe("Ballard House");
  });
});
