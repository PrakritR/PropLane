/**
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it } from "vitest";
import { cachePublicExtraListings } from "@/lib/demo-property-pipeline";
import {
  createDefaultListingSubmission,
  normalizeManagerListingSubmissionV1,
  type ManagerRoomSubmission,
} from "@/lib/manager-listing-submission";
import { resolveManualResidentAssignment, resolveManualResidentPlacementValues } from "@/lib/rental-application/placement-values";
import { SHORT_TERM_LEASE_TERM } from "@/lib/rental-application/lease-terms";
import type { MockProperty } from "@/data/types";

const MANAGER_ID = "mgr-manual-resident";

function room(over: Partial<ManagerRoomSubmission>): ManagerRoomSubmission {
  const base = createDefaultListingSubmission().rooms[0]!;
  return {
    ...base,
    id: "room-1",
    name: "Room A",
    monthlyRent: 900,
    utilitiesEstimate: "150",
    securityDeposit: "900",
    moveInFee: "200",
    shortTermRent: "225",
    shortTermDeposit: "100",
    shortTermMoveInFee: "50",
    ...over,
  } as ManagerRoomSubmission;
}

function seed(propertyId: string, r: ManagerRoomSubmission, listingExtras?: Record<string, string>): MockProperty {
  const sub = createDefaultListingSubmission();
  sub.rooms = [r];
  sub.securityDeposit = "800";
  sub.moveInFee = "150";
  sub.shortTermDailyCost = "200";
  sub.shortTermDeposit = "75";
  sub.shortTermMoveInFee = "25";
  if (listingExtras) {
    for (const [k, v] of Object.entries(listingExtras)) {
      (sub as Record<string, unknown>)[k] = v;
    }
  }
  const property: MockProperty = {
    id: propertyId,
    title: "Test House",
    tagline: "",
    address: "4709A 8th Ave NE, Seattle, WA",
    zip: "98105",
    neighborhood: "U District",
    beds: 1,
    baths: 1,
    rentLabel: "$900/mo",
    available: "Now",
    petFriendly: false,
    buildingId: "b1",
    buildingName: "Test House",
    unitLabel: "Room A",
    adminPublishLive: true,
    managerUserId: MANAGER_ID,
    listingSubmission: normalizeManagerListingSubmissionV1(sub),
  };
  cachePublicExtraListings([property], { silent: true });
  return property;
}

beforeEach(() => {
  window.sessionStorage.clear();
});

describe("resolveManualResidentPlacementValues", () => {
  it("fills long-term rent, utilities, and room-first fees", () => {
    const propertyId = "prop-lt";
    seed(propertyId, room({}));

    const v = resolveManualResidentPlacementValues({
      propertyId,
      roomId: "room-1",
      leaseTerm: "12 months",
      leaseTermCustomMode: false,
    });
    expect(v?.rentalType).toBe("standard");
    expect(v?.rent).toBe("900");
    expect(Number(v?.utilities)).toBeGreaterThan(0);
    expect(v?.securityDeposit).toBe("900");
    expect(v?.moveInFee).toBe("200");
  });

  it("fills short-term daily rate with zero utilities and room short-term fees", () => {
    const propertyId = "prop-st";
    seed(propertyId, room({}));

    const v = resolveManualResidentPlacementValues({
      propertyId,
      roomId: "room-1",
      leaseTerm: SHORT_TERM_LEASE_TERM,
      leaseTermCustomMode: false,
    });
    expect(v?.rentalType).toBe("short_term");
    expect(v?.rent).toBe("225");
    expect(v?.utilities).toBe("0");
    expect(v?.securityDeposit).toBe("100");
    expect(v?.moveInFee).toBe("50");
  });

  it("uses listing short-term defaults when the room has no short-term overrides", () => {
    const propertyId = "prop-st-listing";
    seed(
      propertyId,
      room({ shortTermRent: "", shortTermDeposit: "", shortTermMoveInFee: "" }),
    );

    const v = resolveManualResidentPlacementValues({
      propertyId,
      roomId: "room-1",
      leaseTerm: SHORT_TERM_LEASE_TERM,
      leaseTermCustomMode: false,
    });
    expect(v?.rent).toBe("200");
    expect(v?.securityDeposit).toBe("75");
    expect(v?.moveInFee).toBe("25");
  });

  it("fills entire-home pricing without a room id", () => {
    const propertyId = "prop-entire";
    const sub = createDefaultListingSubmission();
    sub.listingPlaceCategoryId = "entire_home";
    sub.entireHomeMonthlyRent = 3200;
    sub.rooms = [room({ monthlyRent: 0 })];
    const property: MockProperty = {
      id: propertyId,
      title: "Whole House",
      tagline: "",
      address: "1 Main St",
      zip: "98105",
      neighborhood: "U District",
      beds: 3,
      baths: 2,
      rentLabel: "$3200/mo",
      available: "Now",
      petFriendly: false,
      buildingId: "b1",
      buildingName: "Whole House",
      unitLabel: "",
      adminPublishLive: true,
      managerUserId: MANAGER_ID,
      listingSubmission: normalizeManagerListingSubmissionV1(sub),
    };
    cachePublicExtraListings([property], { silent: true });

    const assignment = resolveManualResidentAssignment({
      propertyId,
      roomId: "",
      bundleId: "",
    });
    expect(assignment.assignedRoomChoice).toBe(propertyId);
    expect(assignment.bundleId).toBeUndefined();

    const v = resolveManualResidentPlacementValues({
      propertyId,
      roomId: "",
      leaseTerm: "12 months",
      leaseTermCustomMode: false,
    });
    expect(v?.rent).toBe("3200");
  });

  it("fills bundle pricing when a lease bundle is selected", () => {
    const propertyId = "prop-bundle";
    const sub = createDefaultListingSubmission();
    sub.rooms = [
      room({ id: "room-a", name: "Room A", monthlyRent: 900, utilitiesEstimate: "100" }),
      room({ id: "room-b", name: "Room B", monthlyRent: 850, utilitiesEstimate: "100" }),
    ];
    sub.bundles = [
      {
        id: "bundle-1",
        label: "2-room bundle",
        price: "1500",
        roomsLine: "Room A + Room B",
        includedRoomIds: ["room-a", "room-b"],
        shortTermEnabled: false,
        shortTermNightlyRent: "",
      },
    ];
    const property: MockProperty = {
      id: propertyId,
      title: "Bundle House",
      tagline: "",
      address: "2 Main St",
      zip: "98105",
      neighborhood: "U District",
      beds: 2,
      baths: 1,
      rentLabel: "$1500/mo",
      available: "Now",
      petFriendly: false,
      buildingId: "b2",
      buildingName: "Bundle House",
      unitLabel: "",
      adminPublishLive: true,
      managerUserId: MANAGER_ID,
      listingSubmission: normalizeManagerListingSubmissionV1(sub),
    };
    cachePublicExtraListings([property], { silent: true });

    const assignment = resolveManualResidentAssignment({
      propertyId,
      roomId: "",
      bundleId: "bundle-1",
    });
    expect(assignment.bundleId).toBe("bundle-1");
    expect(assignment.assignedRoomChoice).toBeUndefined();

    const v = resolveManualResidentPlacementValues({
      propertyId,
      roomId: "",
      bundleId: "bundle-1",
      leaseTerm: "12 months",
      leaseTermCustomMode: false,
    });
    expect(v?.rent).toBe("1500");
    expect(Number(v?.utilities)).toBeGreaterThan(0);
  });
});
