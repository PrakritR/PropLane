/**
 * @vitest-environment jsdom
 *
 * The four lease types (Long-term, Short-term, Custom, Month-to-month): the type the applicant picks decides the
 * lease term and the generated charge schedule, through the one generation path the manager portal runs on
 * approval. Month-to-month carries an OPTIONAL surcharge, charged only on a month-to-month lease and never on a Seattle listing.
 */
import { beforeEach, describe, expect, it } from "vitest";
import {
  readHouseholdCharges,
  recordApprovedApplicationCharges,
  removeResidentHouseholdPaymentData,
} from "@/lib/household-charges";
import { cachePublicExtraListings } from "@/lib/demo-property-pipeline";
import { createDefaultListingSubmission, normalizeManagerListingSubmissionV1 } from "@/lib/manager-listing-submission";
import { LISTING_ROOM_CHOICE_SEP } from "@/lib/rental-application/data";
import { buildLeaseHtml } from "@/lib/lease-templates/build-lease-html";
import { SEATTLE_LEASE_CONFIG } from "@/lib/lease-templates/types";
import type { LeaseGenerationContext } from "@/lib/generated-lease";
import {
  LEASE_TYPES,
  leaseTermIsOfferedType,
  leaseTypeIdForStoredTerm,
  leaseTypeIdsFromStored,
  storedTermForLeaseType,
} from "@/lib/rental-application/lease-terms";
import { applicantTermOptions, onlyOfferedStoredTerm, storedTermForApplicant } from "@/lib/rental-application/applicant-lease-term";
import { validateRentalWizardStep } from "@/lib/rental-application/validate";
import { createInitialRentalWizardState } from "@/lib/rental-application/state";
import { recurringMonthlyFeesForLease } from "@/lib/custom-lease-billing";
import { resolveListingFees } from "@/lib/listing-fees";
import type { MockProperty } from "@/data/types";
import type { DemoApplicantRow } from "@/lib/manager-applications-storage";

const MANAGER_ID = "mgr-lease-types";
const PROPERTY_ID = "prop-lease-types";

function seedListing(): MockProperty {
  const sub = createDefaultListingSubmission();
  sub.rooms = [
    {
      ...sub.rooms[0]!,
      id: "room-1",
      name: "Room 1",
      floor: "Main",
      availability: "Available now",
      moveInAvailableDate: "2026-01-01",
      monthlyRent: 1200,
      utilitiesEstimate: "",
    },
  ];
  sub.shortTermRentalsAllowed = true;
  sub.shortTermDailyCost = "40";
  sub.allowedLeaseTerms = ["Long-term", "Short-Term Stay", "Custom", "Month-to-Month"];
  // A listing saved while the surcharge existed: both the scalar and the fee row still carry $25.
  const legacy = {
    ...sub,
    monthToMonthSurcharge: "25",
    customFees: [{ id: "fee-mtm", label: "Month-to-month surcharge", amount: "25", cadence: "monthly", presetId: "mtm_surcharge" }],
  };
  const property: MockProperty = {
    id: PROPERTY_ID,
    title: "Pike Place Loft",
    tagline: "Flexible stays",
    address: "1500 Pike St, Seattle, WA",
    zip: "98101",
    neighborhood: "Belltown",
    beds: 1,
    baths: 1,
    rentLabel: "$1,200/mo",
    available: "Now",
    petFriendly: false,
    buildingId: "b1",
    buildingName: "Pike Place Loft",
    unitLabel: "Room 1",
    adminPublishLive: true,
    managerUserId: MANAGER_ID,
    listingSubmission: normalizeManagerListingSubmissionV1(legacy as never),
  };
  cachePublicExtraListings([property], { silent: true });
  return property;
}

function application(email: string, leaseTerm: string, leaseStart: string, leaseEnd: string, rentalType = "standard"): DemoApplicantRow {
  const roomChoice = `${PROPERTY_ID}${LISTING_ROOM_CHOICE_SEP}room-1`;
  return {
    id: `app-${email}`,
    name: "Dana Tenant",
    email,
    property: "Pike Place Loft",
    propertyId: PROPERTY_ID,
    assignedPropertyId: PROPERTY_ID,
    assignedRoomChoice: roomChoice,
    managerUserId: MANAGER_ID,
    application: { propertyId: PROPERTY_ID, roomChoice1: roomChoice, leaseTerm, leaseStart, leaseEnd, rentalType, fullLegalName: "Dana Tenant" },
  } as unknown as DemoApplicantRow;
}

function chargesFor(email: string) {
  return readHouseholdCharges()
    .filter((c) => c.residentEmail.toLowerCase() === email.toLowerCase())
    .map((c) => ({ kind: c.kind, month: c.rentMonth ?? "", title: c.title, amount: c.amountLabel }));
}

function approve(email: string, leaseTerm: string, start: string, end: string, rentalType = "standard") {
  removeResidentHouseholdPaymentData(email);
  recordApprovedApplicationCharges(application(email, leaseTerm, start, end, rentalType), MANAGER_ID, true, { leaseExecuted: true });
  return chargesFor(email);
}

beforeEach(() => {
  window.sessionStorage.clear();
  seedListing();
});

const noSurcharge = (rows: { title: string; amount: string }[]) =>
  rows.every((c) => !/surcharge/i.test(c.title) && c.amount !== "$25.00");

describe("the four lease types are one list", () => {
  it("is Long-term, Short-term, Custom, Month-to-month with their stored terms", () => {
    expect(LEASE_TYPES.map((t) => [t.id, t.label, t.term])).toEqual([
      ["long_term", "Long-term", "Long-term"],
      ["short_term", "Short-term", "Short-Term Stay"],
      ["custom", "Custom", "Custom"],
      ["month_to_month", "Month-to-month", "Month-to-Month"],
    ]);
  });

  it("reads every stored term as one of the four, retired ones included", () => {
    for (const legacy of ["3-Month", "6-Month", "9-Month", "12-Month"]) expect(leaseTypeIdForStoredTerm(legacy)).toBe("long_term");
    expect(leaseTypeIdForStoredTerm("Airbnb")).toBe("short_term");
    expect(leaseTypeIdForStoredTerm("")).toBeNull();
    expect(leaseTypeIdsFromStored(["Month-to-Month", "Custom", "12-Month"])).toEqual(["long_term", "custom", "month_to_month"]);
  });

  it("the applicant select lists only what the property enabled, in the fixed order", () => {
    expect(applicantTermOptions(["Month-to-Month", "Short-Term Stay", "Long-term", "Custom"]).map((o) => o.label)).toEqual([
      "Long-term",
      "Short-term",
      "Custom",
      "Month-to-month",
    ]);
    expect(applicantTermOptions(["Long-term", "Month-to-Month"]).map((o) => o.label)).toEqual(["Long-term", "Month-to-month"]);
    expect(applicantTermOptions(["Airbnb"]).map((o) => o.label)).toEqual(["Short-term"]);
  });

  it("preselects when exactly one type is enabled, and only then", () => {
    expect(onlyOfferedStoredTerm(["Custom"])).toBe("Custom");
    expect(onlyOfferedStoredTerm(["Long-term", "12-Month"])).toBe("Long-term");
    expect(onlyOfferedStoredTerm(["Short-Term Stay", "Airbnb"])).toBe("Short-Term Stay");
    expect(onlyOfferedStoredTerm(["Long-term", "Custom"])).toBeNull();
  });

  it("translates each pick to its stored term", () => {
    const all = ["Long-term", "Short-Term Stay", "Custom", "Month-to-Month"];
    expect(storedTermForApplicant({ offered: all, term: "long_term" })).toBe("Long-term");
    expect(storedTermForApplicant({ offered: all, term: "short_term" })).toBe("Short-Term Stay");
    expect(storedTermForApplicant({ offered: all, term: "custom" })).toBe("Custom");
    expect(storedTermForApplicant({ offered: all, term: "month_to_month" })).toBe("Month-to-Month");
    expect(storedTermForApplicant({ offered: ["Airbnb"], term: "short_term" })).toBe("Airbnb");
    expect(storedTermForLeaseType("long_term", ["12-Month"])).toBe("12-Month");
  });
});

describe("charges follow the chosen lease type", () => {
  it("Long-term: a fixed term, first month then monthly rent", () => {
    const rows = approve("long@example.com", "Long-term", "2026-03-01", "2027-02-28");
    expect(rows[0]).toMatchObject({ kind: "first_month_rent", amount: "$1,200.00" });
    expect(rows.filter((c) => c.kind === "rent").every((c) => c.amount === "$1,200.00")).toBe(true);
    expect(rows.some((c) => c.kind === "stay_total")).toBe(false);
    expect(noSurcharge(rows)).toBe(true);
  });

  it("Custom: the applicant's own dates, prorated at both ends", () => {
    const rows = approve("custom@example.com", "Custom", "2026-03-10", "2026-06-12");
    expect(rows.find((c) => c.kind === "prorated_rent")?.amount).toBe("$851.61");
    expect(rows.find((c) => c.kind === "prorated_last_month_rent")?.amount).toBe("$480.00");
    expect(rows.find((c) => c.month === "2026-04")?.amount).toBe("$1,200.00");
    expect(rows.some((c) => c.month === "2026-07")).toBe(false);
  });

  it("Month-to-month: rolling monthly rent, no end, and NO $25 surcharge", () => {
    const rows = approve("m2m@example.com", "Month-to-Month", "2026-03-01", "");
    expect(rows[0]).toMatchObject({ kind: "first_month_rent", amount: "$1,200.00" });
    const monthly = rows.filter((c) => c.kind === "rent");
    expect(monthly.length).toBeGreaterThan(3);
    expect(monthly.every((c) => c.amount === "$1,200.00")).toBe(true);
    expect(noSurcharge(rows)).toBe(true);
    // Same rent schedule as Long-term: the type adds no money.
    const longRows = approve("m2m-long@example.com", "Long-term", "2026-03-01", "");
    expect(rows.map((c) => c.amount)).toEqual(longRows.map((c) => c.amount));
  });

  it("Short-term: one stay total from the nightly rate", () => {
    const rows = approve("short@example.com", "Short-Term Stay", "2026-03-10", "2026-03-20", "short_term");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: "stay_total", amount: "$400.00" });
  });
});

describe("the month-to-month surcharge is optional, month-to-month only, and never in Seattle", () => {
  const tacoma = () => ({ ...seedListing().listingSubmission!, city: "Tacoma", state: "WA", zip: "98402", address: "1 Pacific Ave, Tacoma, WA 98402" });
  const seattle = () => ({ ...seedListing().listingSubmission!, city: "Seattle", state: "WA", zip: "98101", address: "1500 Pike St, Seattle, WA 98101" });

  it("outside Seattle a saved $25 lists and bills on a month-to-month lease only", () => {
    const sub = tacoma();
    expect(resolveListingFees(sub).some((fee) => fee.presetId === "mtm_surcharge")).toBe(true);
    expect(recurringMonthlyFeesForLease(sub, [], { leaseTerm: "Month-to-Month" })).toEqual([
      { id: "preset:mtm_surcharge", label: "Month-to-month surcharge", amount: 25 },
    ]);
    expect(recurringMonthlyFeesForLease(sub, [], { leaseTerm: "Long-term" })).toEqual([]);
    expect(recurringMonthlyFeesForLease(sub, [], { leaseTerm: "Month-to-Month", rentalType: "short_term" })).toEqual([]);
  });

  it("absent unless the manager set it: a blank amount bills nothing", () => {
    const sub = { ...tacoma(), monthToMonthSurcharge: "", customFees: [] };
    expect(recurringMonthlyFeesForLease(normalizeManagerListingSubmissionV1(sub), [], { leaseTerm: "Month-to-Month" })).toEqual([]);
  });

  it("a Seattle listing never bills it, even with a stale amount saved", () => {
    const sub = seattle();
    expect(recurringMonthlyFeesForLease(sub, [], { leaseTerm: "Month-to-Month" })).toEqual([]);
  });
});

describe("the lease document follows the chosen type", () => {
  function leaseCtx(leaseTerm: string, leaseStart: string, leaseEnd: string): LeaseGenerationContext {
    const sub = { ...createDefaultListingSubmission(), city: "Seattle", state: "WA", zip: "98105", address: "5259 Brooklyn Ave NE, Seattle, WA 98105" };
    sub.rooms = [{ ...sub.rooms[0]!, id: "room-1", name: "Room 1", monthlyRent: 900, utilitiesEstimate: "150" }];
    const submission = { ...sub, monthToMonthSurcharge: "25", rolloverToMonthToMonth: false } as typeof sub;
    return {
      application: { fullLegalName: "Jordan Lee", email: "j@example.com", leaseTerm, leaseStart, leaseEnd, roomChoice1: "property-1::room-1" },
      leasedRoom: undefined,
      listingProperty: { id: "property-1", title: "Brooklyn House", address: "5259 Brooklyn Ave NE, Seattle, WA 98105", buildingName: "Brooklyn House", unitLabel: "Room 1" } as LeaseGenerationContext["listingProperty"],
      submission,
      generatedAtIso: "2026-09-01T00:00:00.000Z",
      leaseBilling: { monthlyRent: 900, monthlyUtilities: 150, securityDeposit: 400, moveInFee: 150, otherCostLabel: "Other costs", otherCostAmount: 0, dueAtSigning: 550 },
    };
  }

  it("Long-term and Custom print a fixed term between the chosen dates", () => {
    const long = buildLeaseHtml(leaseCtx("Long-term", "2026-10-01", "2027-09-30"), SEATTLE_LEASE_CONFIG);
    expect(long).toContain("This is a fixed-term lease beginning");
    expect(long).toContain("Oct 1, 2026 through Sep 30, 2027");
    const custom = buildLeaseHtml(leaseCtx("Custom", "2026-10-12", "2027-01-20"), SEATTLE_LEASE_CONFIG);
    expect(custom).toContain("This is a fixed-term lease beginning");
    expect(custom).toContain("Oct 12, 2026 through Jan 20, 2027");
  });

  it("Month-to-month prints a rolling tenancy with no end date and no surcharge", () => {
    const html = buildLeaseHtml(leaseCtx("Month-to-Month", "2026-10-01", ""), SEATTLE_LEASE_CONFIG);
    expect(html).toContain("This tenancy is month-to-month beginning");
    expect(html).not.toContain("This is a fixed-term lease beginning");
    expect(html).not.toMatch(/month-to-month surcharge/i);
    expect(html).not.toContain("$25");
  });
});

describe("a lease type the property did not enable is rejected", () => {
  const listing = (terms: string[]) => {
    const sub = createDefaultListingSubmission();
    sub.allowedLeaseTerms = terms;
    return { id: "prop-reject", listingSubmission: normalizeManagerListingSubmissionV1(sub) } as Pick<MockProperty, "id" | "listingSubmission">;
  };
  const leaseTermError = (terms: string[], leaseTerm: string, rentalType: "standard" | "short_term" = "standard") => {
    const property = listing(terms);
    const form = { ...createInitialRentalWizardState(), propertyId: property.id, leaseTerm, rentalType, leaseStart: "2099-01-01", leaseEnd: "2099-12-31" };
    return validateRentalWizardStep(3, form, { property }).leaseTerm;
  };

  it("pure test: only enabled types are offered", () => {
    expect(leaseTermIsOfferedType(["Long-term", "Custom"], "Custom")).toBe(true);
    expect(leaseTermIsOfferedType(["Long-term", "Custom"], "Month-to-Month")).toBe(false);
    expect(leaseTermIsOfferedType(["Long-term"], "Short-Term Stay")).toBe(false);
    expect(leaseTermIsOfferedType(["12-Month"], "Long-term")).toBe(true);
  });

  it("submitting Month-to-month on a property that did not enable it fails validation", () => {
    expect(leaseTermError(["Long-term", "Custom"], "Month-to-Month")).toBe("This lease term is not offered for the selected property.");
    expect(leaseTermError(["Long-term", "Month-to-Month"], "Month-to-Month")).toBeUndefined();
  });

  it("submitting Custom on a property that did not enable it fails validation", () => {
    expect(leaseTermError(["Long-term", "Month-to-Month"], "Custom")).toBe("This lease term is not offered for the selected property.");
    expect(leaseTermError(["Long-term", "Custom"], "Custom")).toBeUndefined();
  });

  it("submitting Short-term on a property that did not enable it fails validation", () => {
    expect(leaseTermError(["Long-term"], "Short-Term Stay", "short_term")).toBeTruthy();
  });
});
