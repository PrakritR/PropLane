/**
 * @vitest-environment jsdom
 */
import { describe, expect, it } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  readHouseholdCharges,
  recordApprovedApplicationCharges,
  removeResidentHouseholdPaymentData,
} from "@/lib/household-charges";
import { cachePublicExtraListings } from "@/lib/demo-property-pipeline";
import { buildLeaseHtml } from "@/lib/lease-templates/build-lease-html";
import { SEATTLE_LEASE_CONFIG } from "@/lib/lease-templates/types";
import {
  createDefaultListingSubmission,
  emptyRoom,
  normalizeManagerListingSubmissionV1,
  type ManagerListingSubmissionV1,
  type ManagerRoomSubmission,
} from "@/lib/manager-listing-submission";
import { LISTING_ROOM_CHOICE_SEP } from "@/lib/rental-application/data";
import type { LeaseGenerationContext } from "@/lib/generated-lease";
import type { MockProperty } from "@/data/types";
import type { DemoApplicantRow } from "@/lib/manager-applications-storage";

/**
 * The executed lease document and the resident's charge ledger are two renderings of ONE
 * calculation (see AGENTS.md: they "can never quote different numbers"). A term that begins
 * AND ends inside one calendar month is the case where they used to disagree: the ledger
 * billed the days from the start through month end AND a separate "last month" charge for the
 * days from the 1st through the end date, so a 16-day stay was billed 46/30 of a month, while
 * the document only ever named the first of those two lines.
 */
const MANAGER_ID = "mgr-lease-ledger-parity";
const PROPERTY_ID = "prop-lease-ledger-parity";
const RESIDENT_EMAIL = "parity-resident@example.com";
const LEASE_START = "2026-09-10";
const LEASE_END = "2026-09-25";
const MONTHLY_RENT = 900;
const MONTHLY_UTILITIES = 150;

function room(): ManagerRoomSubmission {
  return {
    ...emptyRoom(0),
    id: "room-1",
    name: "Room 1",
    monthlyRent: MONTHLY_RENT,
    utilitiesEstimate: String(MONTHLY_UTILITIES),
  };
}

function submission(): ManagerListingSubmissionV1 {
  return {
    ...createDefaultListingSubmission(),
    buildingName: "8th Ave House",
    address: "4709A 8th Ave NE, Seattle, WA 98105",
    city: "Seattle",
    state: "WA",
    zip: "98105",
    securityDeposit: "400",
    moveInFee: "150",
    applicationFee: "",
    rooms: [room()],
    allowedLeaseTerms: ["12-Month"],
    paymentAtSigningIncludes: [
      "security_deposit",
      "move_in_fee",
      "first_month_rent",
      "first_month_utilities",
    ],
  };
}

function seedListing(): MockProperty {
  const property: MockProperty = {
    id: PROPERTY_ID,
    title: "8th Ave House",
    tagline: "Rooms near campus",
    address: "4709A 8th Ave NE, Seattle, WA 98105",
    zip: "98105",
    neighborhood: "University District",
    beds: 1,
    baths: 1,
    rentLabel: "$900/mo",
    available: "Now",
    petFriendly: false,
    buildingId: "b1",
    buildingName: "8th Ave House",
    unitLabel: "Room 1",
    adminPublishLive: true,
    managerUserId: MANAGER_ID,
    listingSubmission: normalizeManagerListingSubmissionV1(submission()),
  };
  cachePublicExtraListings([property], { silent: true });
  return property;
}

function applicant(): DemoApplicantRow {
  return {
    id: "app-lease-ledger-parity",
    name: "Parity Resident",
    email: RESIDENT_EMAIL,
    property: "8th Ave House",
    propertyId: PROPERTY_ID,
    assignedPropertyId: PROPERTY_ID,
    assignedRoomChoice: `${PROPERTY_ID}${LISTING_ROOM_CHOICE_SEP}room-1`,
    managerUserId: MANAGER_ID,
    application: {
      propertyId: PROPERTY_ID,
      roomChoice1: `${PROPERTY_ID}${LISTING_ROOM_CHOICE_SEP}room-1`,
      leaseTerm: "12-Month",
      leaseStart: LEASE_START,
      leaseEnd: LEASE_END,
      fullLegalName: "Parity Resident",
    },
  } as unknown as DemoApplicantRow;
}

function leaseContext(): LeaseGenerationContext {
  const sub = submission();
  return {
    application: {
      fullLegalName: "Parity Resident",
      email: RESIDENT_EMAIL,
      leaseTerm: "12-Month",
      leaseStart: LEASE_START,
      leaseEnd: LEASE_END,
      roomChoice1: `${PROPERTY_ID}::room-1`,
    },
    leasedRoom: undefined,
    listingProperty: {
      id: PROPERTY_ID,
      title: "8th Ave House",
      address: "4709A 8th Ave NE, Seattle, WA 98105",
      buildingName: "8th Ave House",
      unitLabel: "Room 1",
    } as LeaseGenerationContext["listingProperty"],
    submission: sub,
    generatedAtIso: "2026-09-01T00:00:00.000Z",
    leaseBilling: {
      monthlyRent: MONTHLY_RENT,
      monthlyUtilities: MONTHLY_UTILITIES,
      securityDeposit: 400,
      moveInFee: 150,
      otherCostLabel: "Other costs",
      otherCostAmount: 0,
      dueAtSigning: 1030,
    },
  } as LeaseGenerationContext;
}

function ledgerForApprovedApplication() {
  window.sessionStorage.clear();
  removeResidentHouseholdPaymentData(RESIDENT_EMAIL);
  seedListing();
  recordApprovedApplicationCharges(applicant(), MANAGER_ID, true);
  return readHouseholdCharges().filter(
    (charge) => charge.residentEmail.toLowerCase() === RESIDENT_EMAIL.toLowerCase(),
  );
}

/** Optional reviewer artifact: `EVIDENCE_DIR=/path npx vitest run <this file>`. */
function writeEvidence(name: string, contents: string) {
  const dir = process.env.EVIDENCE_DIR?.trim();
  if (!dir) return;
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, name), contents, "utf8");
}

describe("lease document \u2194 charge ledger parity (term inside one calendar month)", () => {
  it("bills the 16-day term ONCE, and for the amount the document names", () => {
    const charges = ledgerForApprovedApplication();
    // Both document styles a manager can send: the compact room lease and the long form.
    const compact = buildLeaseHtml(leaseContext(), SEATTLE_LEASE_CONFIG);
    const longForm = buildLeaseHtml(leaseContext(), {
      ...SEATTLE_LEASE_CONFIG,
      documentStyle: "standard",
    });

    // Ledger: one prorated rent line and one prorated utilities line, no last-month twins.
    const proratedRent = charges.filter((c) => c.kind === "prorated_rent");
    const proratedUtilities = charges.filter((c) => c.kind === "prorated_utilities");
    expect(proratedRent).toHaveLength(1);
    expect(proratedUtilities).toHaveLength(1);
    expect(charges.some((c) => /last month/i.test(c.title))).toBe(false);

    // 16 of 30 days: $900 -> $480.00, $150 -> $80.00.
    expect(proratedRent[0]!.amountLabel).toBe("$480.00");
    expect(proratedUtilities[0]!.amountLabel).toBe("$80.00");
    expect(proratedRent[0]!.title).toContain("16/30 days of lease term");
    expect(proratedRent[0]!.title).toContain("Prorated term rent");
    expect(proratedRent[0]!.title).not.toContain("first month");

    // Compact room lease: the same $480 / $80 and no contradictory last-month line.
    expect(compact).toContain("Prorated Rent for September 2026:</strong> $480.00");
    expect(compact).toContain("Prorated Utilities for September 2026:</strong> $80.00");
    expect(compact).toContain("Prorated term rent");
    expect(compact).toContain("Because the term begins and ends within one calendar month");
    expect(compact).not.toContain("For the first partial month");
    expect(compact).not.toContain("Prorated first month");
    expect(compact).not.toContain("Last Month&apos;s Rent");

    // Long form: one "Prorated Term" section for the whole stay, no second final-month table.
    expect(longForm).toContain("Prorated Term");
    expect(longForm).toContain("the term begins and ends within one calendar month");
    expect(longForm).toContain("Prorated total due for the term");
    expect(longForm).toContain("$560.00");
    expect(longForm).not.toContain("Prorated Final Month");

    writeEvidence("intra-month-lease-compact.html", compact);
    writeEvidence("intra-month-lease-longform.html", longForm);
    writeEvidence(
      "intra-month-ledger.txt",
      [
        "Approved application -> resident charge ledger",
        `Lease: ${LEASE_START} -> ${LEASE_END} ($${MONTHLY_RENT}/mo rent, $${MONTHLY_UTILITIES}/mo utilities)`,
        "",
        ...charges.map((c) => `  - ${c.title.padEnd(52)} ${c.amountLabel}`),
      ].join("\n"),
    );
  });

  it("still bills both boundary months when the term spans several months", () => {
    // Control: the fix must not suppress the genuine final-month charge on a normal term.
    const base = leaseContext();
    const html = buildLeaseHtml(
      { ...base, application: { ...base.application, leaseEnd: "2027-09-25" } } as LeaseGenerationContext,
      { ...SEATTLE_LEASE_CONFIG, documentStyle: "standard" },
    );
    expect(html).toContain("Prorated First Month");
    expect(html).toContain("Prorated Final Month");
  });
});
