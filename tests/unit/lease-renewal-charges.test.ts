/**
 * @vitest-environment jsdom
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import {
  markHouseholdChargePaid,
  readHouseholdCharges,
  readRecurringRentProfilesForManager,
  recordApprovedApplicationCharges,
  removeResidentHouseholdPaymentData,
  updatePendingRentAmountForResident,
  setRecurringRentProfilePriorRent,
  renewalPriorRent,
  expectedRecurringRentAmountForMonth,
} from "@/lib/household-charges";
import { cachePublicExtraListings } from "@/lib/demo-property-pipeline";
import { createDefaultListingSubmission, normalizeManagerListingSubmissionV1 } from "@/lib/manager-listing-submission";
import { applyListingFeesToSubmission } from "@/lib/listing-fees";
import { LISTING_ROOM_CHOICE_SEP } from "@/lib/rental-application/data";
import type { MockProperty } from "@/data/types";
import type { DemoApplicantRow } from "@/lib/manager-applications-storage";

const MANAGER_ID = "mgr-renewal-charges";
const PROPERTY_ID = "prop-renewal-charges";
const EMAIL = "renewing@example.com";
const ROOM_ID = "room-a";

function seedListing() {
  let sub = createDefaultListingSubmission();
  sub.rooms = [{ ...sub.rooms[0]!, id: ROOM_ID, name: "Room A", monthlyRent: 2000, utilitiesEstimate: "150", utilitiesPaymentModel: "manager_billed" }];
  sub = applyListingFeesToSubmission(sub, [
    { id: "fee-sec", presetId: "security_deposit", label: "Security deposit", amount: "1500", frequency: "one-time", dueAtSigning: true },
  ]);
  sub.securityDeposit = "";
  const property: MockProperty = { id: PROPERTY_ID, title: "Renewal Charges House", managerUserId: MANAGER_ID, listingSubmission: normalizeManagerListingSubmissionV1(sub) };
  cachePublicExtraListings([property]);
}

function row(start: string, end: string, rent?: number): DemoApplicantRow {
  const roomChoice = `Room A${LISTING_ROOM_CHOICE_SEP}${ROOM_ID}`;
  return {
    id: "AXIS-RENEWCH",
    name: "Rene Wing",
    email: EMAIL,
    property: "Renewal Charges House",
    propertyId: PROPERTY_ID,
    assignedPropertyId: PROPERTY_ID,
    assignedRoomChoice: roomChoice,
    bucket: "approved",
    stage: "Approved",
    managerUserId: MANAGER_ID,
    ...(rent != null ? { signedMonthlyRent: rent } : {}),
    application: {
      propertyId: PROPERTY_ID,
      roomChoice1: roomChoice,
      leaseStart: start,
      leaseEnd: end,
      leaseTerm: "12 months",
      fullLegalName: "Rene Wing",
      ...(rent != null ? { managerRentOverride: String(rent) } : {}),
    },
  } as DemoApplicantRow;
}

const mine = () => readHouseholdCharges().filter((c) => c.residentEmail.toLowerCase() === EMAIL);
const _dump = (label: string) =>
  console.log(label + "\n" + mine().map((c) => `${c.kind.padEnd(26)} ${String(c.rentMonth ?? "").padEnd(8)} ${c.status.padEnd(8)} ${c.amountLabel.padEnd(10)} ${c.title}`).sort().join("\n"));

beforeEach(() => {
  removeResidentHouseholdPaymentData(EMAIL);
  seedListing();
});

/**
 * `applySignedLeaseRenewal` makes exactly these calls once both parties have signed a renewal
 * (see src/lib/lease-renewal-payments.ts). The tenancy keeps its original start; only the end,
 * the term and the rent move.
 */
function applyRenewal(args: { start: string; end: string; rent: number; originalStart: string }) {
  const renewalMonth = args.start.slice(0, 7);
  const profile = readRecurringRentProfilesForManager(MANAGER_ID).find((p) => p.residentEmail === EMAIL)!;
  setRecurringRentProfilePriorRent(EMAIL, PROPERTY_ID, renewalPriorRent(profile, renewalMonth, args.rent));
  updatePendingRentAmountForResident(EMAIL, PROPERTY_ID, args.rent, MANAGER_ID, renewalMonth);
  recordApprovedApplicationCharges(row(args.originalStart, args.end, args.rent), MANAGER_ID, true, { leaseExecuted: true });
}

function seedSignedTenancy() {
  recordApprovedApplicationCharges(row("2025-11-15", "2026-11-14"), MANAGER_ID, true, { leaseExecuted: true });
  // Everything up to September is paid; October is the current, unpaid month.
  for (const c of mine()) {
    if (c.kind === "prorated_last_month_rent" || c.kind === "prorated_last_month_utilities") continue;
    if (c.rentMonth && c.rentMonth >= "2026-10") continue;
    markHouseholdChargePaid(c.id);
  }
}

const rentFor = (month: string) => mine().filter((c) => c.kind === "rent" && c.rentMonth === month);

describe("a signed renewal moves the schedule forward without touching the term it replaces", () => {
  it("bills the old rent for the old term's unpaid months and the renewed rent from the renewal's first month", () => {
    seedSignedTenancy();
    applyRenewal({ start: "2026-11-15", end: "2027-11-14", rent: 2050, originalStart: "2025-11-15" });

    // October is still the old term: it must exist once, at the old rent.
    expect(rentFor("2026-10")).toHaveLength(1);
    expect(rentFor("2026-10")[0]!.amountLabel).toBe("$2,000.00");
    expect(rentFor("2026-10")[0]!.status).toBe("pending");
    // The month the renewal begins, and every month after it, bills the renewed rent exactly once.
    for (const month of ["2026-11", "2026-12", "2027-01"]) {
      const rows = rentFor(month);
      expect(rows.length, month).toBeLessThanOrEqual(1);
      for (const r of rows) expect(r.amountLabel, month).toBe("$2,050.00");
    }
    expect(rentFor("2026-11")).toHaveLength(1);
    const profile = readRecurringRentProfilesForManager(MANAGER_ID).find((p) => p.residentEmail === EMAIL)!;
    expect(profile.monthlyRent).toBe(2050);
    expect(profile.leaseEnd).toBe("2027-11-14");
    expect(profile.startMonth).toBe("2025-12");
    expect(profile.priorRent).toEqual({ beforeMonth: "2026-11", monthlyRent: 2000 });
  });

  it("leaves every paid charge and the deposit exactly as they were, and adds no second deposit or move-in", () => {
    seedSignedTenancy();
    const before = mine().filter((c) => c.status === "paid").map((c) => `${c.id}|${c.amountLabel}`).sort();
    applyRenewal({ start: "2026-11-15", end: "2027-11-14", rent: 2050, originalStart: "2025-11-15" });
    const after = mine().filter((c) => c.status === "paid").map((c) => `${c.id}|${c.amountLabel}`).sort();
    expect(after).toEqual(before);
    expect(mine().filter((c) => c.kind === "security_deposit")).toHaveLength(1);
    expect(mine().filter((c) => c.kind === "move_in_fee")).toHaveLength(0);
    expect(mine().filter((c) => c.kind === "prorated_rent")).toHaveLength(1);
  });

  it("moves the final partial month to the renewed end and bills it at the renewed rent", () => {
    seedSignedTenancy();
    applyRenewal({ start: "2026-11-15", end: "2027-11-14", rent: 2050, originalStart: "2025-11-15" });
    const last = mine().filter((c) => c.kind === "prorated_last_month_rent");
    expect(last).toHaveLength(1);
    expect(last[0]!.amountLabel).toBe("$956.67");
    expect(mine().filter((c) => c.kind === "rent" && c.rentMonth === "2027-11")).toHaveLength(0);
  });

  it("applying the same renewal twice creates nothing new", () => {
    seedSignedTenancy();
    applyRenewal({ start: "2026-11-15", end: "2027-11-14", rent: 2050, originalStart: "2025-11-15" });
    const once = mine().map((c) => `${c.id}|${c.status}|${c.amountLabel}`).sort();
    applyRenewal({ start: "2026-11-15", end: "2027-11-14", rent: 2050, originalStart: "2025-11-15" });
    const twice = mine().map((c) => `${c.id}|${c.status}|${c.amountLabel}`).sort();
    expect(twice).toEqual(once);
  });

  it("a renewal at the same rent leaves no prior-rent mark", () => {
    seedSignedTenancy();
    applyRenewal({ start: "2026-11-15", end: "2027-11-14", rent: 2000, originalStart: "2025-11-15" });
    const profile = readRecurringRentProfilesForManager(MANAGER_ID).find((p) => p.residentEmail === EMAIL)!;
    expect(profile.priorRent).toBeUndefined();
  });

  it("writes the repriced amount in the same money format as every other charge", () => {
    seedSignedTenancy();
    updatePendingRentAmountForResident(EMAIL, PROPERTY_ID, 2050, MANAGER_ID);
    expect(rentFor("2026-10")[0]!.amountLabel).toBe("$2,050.00");
  });
});

describe("expectedRecurringRentAmountForMonth honours the prior rent", () => {
  it("uses the prior rent before the renewal month and the renewed rent from it", () => {
    seedSignedTenancy();
    applyRenewal({ start: "2026-11-01", end: "2027-10-31", rent: 2050, originalStart: "2025-11-15" });
    const profile = readRecurringRentProfilesForManager(MANAGER_ID).find((p) => p.residentEmail === EMAIL)!;
    expect(expectedRecurringRentAmountForMonth(profile, "2026-10")).toBe(2000);
    expect(expectedRecurringRentAmountForMonth(profile, "2026-11")).toBe(2050);
    expect(expectedRecurringRentAmountForMonth(profile, "2027-05")).toBe(2050);
  });
});

describe("applySignedLeaseRenewal keeps the tenancy start", () => {
  it("does not rewrite leaseStart or moveInDate for a standard-term renewal", () => {
    const src = readFileSync(join(process.cwd(), "src/lib/lease-renewal-payments.ts"), "utf8");
    expect(src).toContain("const keepTenancyStart = !isShortTerm");
    expect(src).toContain("...(keepTenancyStart ? {} : { leaseStart: renewal.leaseStart })");
    expect(src).toContain("...(keepTenancyStart ? {} : { moveInDate: renewal.leaseStart || undefined })");
  });
});
