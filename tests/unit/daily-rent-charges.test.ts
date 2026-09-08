/**
 * @vitest-environment jsdom
 *
 * End-to-end charge generation for a room priced BY THE DAY, against the same
 * `recordApprovedApplicationCharges` path the manager portal runs on approval.
 *
 * Covers the half of the daily-rent-rate feature the other suites do not: that an
 * approved application on a `rentBasis: "daily"` room produces rent charges billed as
 * (real days in the month × daily rate) for the first month, every recurring month,
 * and the partial last month — and that an otherwise identical MONTHLY room still
 * produces exactly the legacy flat/prorated amounts.
 */
import { beforeEach, describe, expect, it } from "vitest";
import {
  readHouseholdCharges,
  recordApprovedApplicationCharges,
  removeResidentHouseholdPaymentData,
} from "@/lib/household-charges";
import { cachePublicExtraListings } from "@/lib/demo-property-pipeline";
import {
  createDefaultListingSubmission,
  normalizeManagerListingSubmissionV1,
  type ManagerRoomSubmission,
} from "@/lib/manager-listing-submission";
import { LISTING_ROOM_CHOICE_SEP } from "@/lib/rental-application/data";
import type { MockProperty } from "@/data/types";
import type { DemoApplicantRow } from "@/lib/manager-applications-storage";

const MANAGER_ID = "mgr-daily-charges";

function room(over: Partial<ManagerRoomSubmission>): ManagerRoomSubmission {
  const base = createDefaultListingSubmission().rooms[0]!;
  return {
    ...base,
    id: "room-1",
    name: "Room 1",
    floor: "Main",
    availability: "Available now",
    moveInAvailableDate: "2026-01-01",
    utilitiesEstimate: "",
    ...over,
  } as ManagerRoomSubmission;
}

function seedListing(propertyId: string, r: ManagerRoomSubmission): MockProperty {
  const sub = createDefaultListingSubmission();
  sub.rooms = [r];
  const property: MockProperty = {
    id: propertyId,
    title: "Pike Place Loft",
    tagline: "Flexible stays",
    address: "1500 Pike St, Seattle, WA",
    zip: "98101",
    neighborhood: "Belltown",
    beds: 1,
    baths: 1,
    rentLabel: "$40/day",
    available: "Now",
    petFriendly: false,
    buildingId: "b1",
    buildingName: "Pike Place Loft",
    unitLabel: "Room 1",
    adminPublishLive: true,
    managerUserId: MANAGER_ID,
    listingSubmission: normalizeManagerListingSubmissionV1(sub),
  };
  cachePublicExtraListings([property], { silent: true });
  return property;
}

function applicantRow(propertyId: string, roomId: string, email: string, leaseEnd?: string): DemoApplicantRow {
  return {
    id: `app-${email}`,
    name: "Dana Tenant",
    email,
    property: "Pike Place Loft",
    propertyId,
    assignedPropertyId: propertyId,
    assignedRoomChoice: `${propertyId}${LISTING_ROOM_CHOICE_SEP}${roomId}`,
    managerUserId: MANAGER_ID,
    application: {
      propertyId,
      roomChoice1: `${propertyId}${LISTING_ROOM_CHOICE_SEP}${roomId}`,
      leaseStart: "2026-03-10",
      leaseEnd,
      fullLegalName: "Dana Tenant",
    },
  } as unknown as DemoApplicantRow;
}

/** Every rent-ish charge the resident/manager would see, in due order. */
function rentCharges(email: string) {
  return readHouseholdCharges()
    .filter((c) => c.residentEmail.toLowerCase() === email.toLowerCase())
    .filter((c) => c.kind.includes("rent"))
    .map((c) => ({
      month: c.rentMonth ?? "—",
      title: c.title,
      amount: c.amountLabel,
      due: c.dueDateLabel ?? "",
    }))
    .sort((a, b) => a.month.localeCompare(b.month));
}

beforeEach(() => {
  window.sessionStorage.clear();
});

describe("daily-priced room — approved-application charges", () => {
  it("bills the first month by real days × daily rate, then every month by that month's day count", () => {
    const email = "daily-tenant@example.com";
    removeResidentHouseholdPaymentData(email);
    const propertyId = "prop-daily-charges";
    seedListing(propertyId, room({ monthlyRent: 0, rentBasis: "daily", dailyRentPrice: 40 }));

    // Lease Mar 10 2026 → Jun 12 2026.
    recordApprovedApplicationCharges(applicantRow(propertyId, "room-1", email, "2026-06-12"), MANAGER_ID, true, { leaseExecuted: true });
    const charges = rentCharges(email);

    // March: Mar 10–31 = 22 billable days × $40 = $880.
    const march = charges.find((c) => c.month === "2026-03" || c.title.includes("first month"));
    expect(march?.amount).toBe("$880.00");
    expect(march?.title).toContain("22 days × $40/day");

    // April (30 days) → $1,200; May (31 days) → $1,240 — real day counts, not a flat rate.
    expect(charges.find((c) => c.month === "2026-04")?.amount).toBe("$1,200.00");
    expect(charges.find((c) => c.month === "2026-04")?.title).toContain("30 days × $40/day");
    expect(charges.find((c) => c.month === "2026-05")?.amount).toBe("$1,240.00");
    expect(charges.find((c) => c.month === "2026-05")?.title).toContain("31 days × $40/day");

    // June is a partial last month: 12 days × $40 = $480.
    const june = charges.find((c) => c.month === "2026-06" || c.title.includes("last month"));
    expect(june?.amount).toBe("$480.00");
    expect(june?.title).toContain("12 days × $40/day");
  });

  it("bills a lease that starts and ends inside one month exactly once", () => {
    const email = "daily-short@example.com";
    removeResidentHouseholdPaymentData(email);
    const propertyId = "prop-daily-short";
    seedListing(propertyId, room({ monthlyRent: 0, rentBasis: "daily", dailyRentPrice: 40 }));

    // Mar 10 → Mar 20 2026 = 11 days, one charge only.
    recordApprovedApplicationCharges(applicantRow(propertyId, "room-1", email, "2026-03-20"), MANAGER_ID, true, { leaseExecuted: true });
    const charges = rentCharges(email);
    expect(charges).toHaveLength(1);
    expect(charges[0]!.amount).toBe("$440.00");
    expect(charges[0]!.title).toContain("11 days × $40/day");
  });
});

describe("monthly-priced room — unchanged legacy behavior", () => {
  it("still bills the flat monthly rent with fractional first/last-month proration", () => {
    const email = "monthly-tenant@example.com";
    removeResidentHouseholdPaymentData(email);
    const propertyId = "prop-monthly-charges";
    seedListing(propertyId, room({ monthlyRent: 1200 }));

    recordApprovedApplicationCharges(applicantRow(propertyId, "room-1", email, "2026-06-12"), MANAGER_ID, true, { leaseExecuted: true });
    const charges = rentCharges(email);

    // March: 22/31 × $1,200 = $851.61 (auto proration, exactly as before).
    const march = charges.find((c) => c.month === "2026-03" || c.title.toLowerCase().includes("first month"));
    expect(march?.amount).toBe("$851.61");
    expect(march?.title).not.toContain("/day");

    // Full months bill the flat monthly rent, with no day-count language.
    expect(charges.find((c) => c.month === "2026-04")?.amount).toBe("$1,200.00");
    expect(charges.find((c) => c.month === "2026-04")?.title).toBe("Rent — April 2026");
    expect(charges.find((c) => c.month === "2026-05")?.amount).toBe("$1,200.00");
  });
});
