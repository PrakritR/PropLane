/**
 * @vitest-environment jsdom
 *
 * Seattle rent rule: on a Seattle listing every recurring monthly cost is RENT. The
 * month-to-month surcharge, the custom-lease surcharge, parking / HOA / other monthly and
 * every monthly custom fee are folded into the one rent figure the resident is quoted and
 * billed, and the lease prints the composition. Nothing monthly bills as its own charge.
 *
 * Everywhere else the ledger is byte-for-byte what it was: fees bill as their own lines and
 * only an `includeInRent` custom fee folds. The negative controls below pin that.
 *
 * The parity test is the important one — the rent the placement (and so the lease document)
 * quotes is the rent the ledger bills. Before this rule the two already disagreed on any room
 * with a short-lease surcharge or a folded fee.
 */
import { beforeEach, describe, expect, it } from "vitest";
import {
  readHouseholdCharges,
  readRecurringRentProfilesForManager,
  recordApprovedApplicationCharges,
  removeResidentHouseholdPaymentData,
} from "@/lib/household-charges";
import { cachePublicExtraListings } from "@/lib/demo-property-pipeline";
import { applyListingFeesToSubmission, leaseDocumentFeeLines, type ListingFeeRow } from "@/lib/listing-fees";
import { buildLeaseHtml } from "@/lib/lease-templates/build-lease-html";
import { SEATTLE_LEASE_CONFIG, WASHINGTON_LEASE_CONFIG } from "@/lib/lease-templates/types";
import {
  createDefaultListingSubmission,
  normalizeManagerListingSubmissionV1,
  type ManagerListingSubmissionV1,
} from "@/lib/manager-listing-submission";
import {
  MONTH_TO_MONTH_SURCHARGE_FEE_ID,
  monthlyFeesBilledSeparately,
  monthlyRentFoldInLines,
  monthlyRentFoldInTotal,
} from "@/lib/rent-fold-in";
import { CUSTOM_LEASE_SURCHARGE_FEE_ID } from "@/lib/custom-lease-billing";
import { resolvePlacementValuesForRow } from "@/lib/rental-application/placement-values";
import { LISTING_ROOM_CHOICE_SEP } from "@/lib/rental-application/data";
import { listingFoldsAllMonthlyFeesIntoRent } from "@/lib/seattle-rent-rule";
import type { LeaseGenerationContext } from "@/lib/generated-lease";
import type { MockProperty } from "@/data/types";
import type { DemoApplicantRow } from "@/lib/manager-applications-storage";

const MANAGER_ID = "mgr-seattle-rent-rule";
const BASE_RENT = 1000;

type City = "seattle" | "tacoma" | "san_francisco";

const ADDRESS: Record<City, { address: string; city: string; state: string; zip: string }> = {
  seattle: { address: "4709 8th Ave NE", city: "Seattle", state: "WA", zip: "98105" },
  tacoma: { address: "1200 Pacific Ave", city: "Tacoma", state: "WA", zip: "98402" },
  san_francisco: { address: "500 Valencia St", city: "San Francisco", state: "CA", zip: "94110" },
};

const FEES: ListingFeeRow[] = [
  { id: "fee-mtm", presetId: "mtm_surcharge", label: "Month-to-month surcharge", amount: "25", frequency: "monthly" },
  { id: "fee-custom-lease", presetId: "custom_lease_surcharge", label: "Custom lease", amount: "100", frequency: "monthly" },
  { id: "fee-parking", presetId: "parking_monthly", label: "Parking", amount: "60", frequency: "monthly" },
  { id: "fee-storage", presetId: "custom", label: "Storage locker", amount: "15", frequency: "monthly" },
];

function listing(city: City, opts?: { includeStorageInRent?: boolean; fees?: ListingFeeRow[] }): ManagerListingSubmissionV1 {
  let sub = createDefaultListingSubmission();
  sub = { ...sub, ...ADDRESS[city], buildingName: `${ADDRESS[city].city} House` };
  sub.rooms = [{ ...sub.rooms[0]!, id: "room-1", name: "Room A", monthlyRent: BASE_RENT, utilitiesEstimate: "" }];
  sub.securityDeposit = "";
  sub.moveInFee = "";
  sub.applicationFee = "";
  sub.allowedLeaseTerms = ["12-Month", "Month-to-Month", "Custom"];
  const fees = (opts?.fees ?? FEES).map((fee) =>
    fee.id === "fee-storage" && opts?.includeStorageInRent ? { ...fee, includeInRent: true } : fee,
  );
  return normalizeManagerListingSubmissionV1(applyListingFeesToSubmission(sub, fees));
}

function seed(propertyId: string, sub: ManagerListingSubmissionV1): MockProperty {
  const property: MockProperty = {
    id: propertyId,
    title: sub.buildingName || "House",
    tagline: "",
    address: `${sub.address}, ${sub.city}, ${sub.state} ${sub.zip}`,
    zip: sub.zip,
    neighborhood: "",
    beds: 1,
    baths: 1,
    rentLabel: `$${BASE_RENT}/mo`,
    available: "Now",
    petFriendly: false,
    buildingId: "b1",
    buildingName: sub.buildingName,
    unitLabel: "Room A",
    adminPublishLive: true,
    managerUserId: MANAGER_ID,
    listingSubmission: sub,
  };
  cachePublicExtraListings([property], { silent: true });
  return property;
}

type Tenancy = { leaseTerm: string; leaseStart: string; leaseEnd?: string; managerRentOverride?: string };

// Lease terms: a standard calendar 12-month lease, a month-to-month tenancy, and a lease on
// custom dates (mid-month start), which is what the custom-lease surcharge is for.
const CALENDAR_12: Tenancy = { leaseTerm: "12-Month", leaseStart: "2026-06-01", leaseEnd: "2027-05-31" };
const MONTH_TO_MONTH: Tenancy = { leaseTerm: "Month-to-Month", leaseStart: "2026-06-01" };
const CUSTOM_DATES: Tenancy = { leaseTerm: "12-Month", leaseStart: "2026-06-15", leaseEnd: "2027-06-14" };

function applicant(propertyId: string, email: string, tenancy: Tenancy): DemoApplicantRow {
  const roomChoice = `${propertyId}${LISTING_ROOM_CHOICE_SEP}room-1`;
  return {
    id: `app-${email}`,
    name: "Alex Resident",
    email,
    property: "House",
    propertyId,
    assignedPropertyId: propertyId,
    assignedRoomChoice: roomChoice,
    bucket: "approved",
    stage: "Approved",
    managerUserId: MANAGER_ID,
    application: {
      propertyId,
      roomChoice1: roomChoice,
      rentalType: "standard",
      fullLegalName: "Alex Resident",
      ...tenancy,
    },
  } as unknown as DemoApplicantRow;
}

function approve(city: City, tenancy: Tenancy, tag: string, opts?: Parameters<typeof listing>[1]) {
  const email = `${tag}@example.com`;
  const propertyId = `prop-${tag}`;
  removeResidentHouseholdPaymentData(email);
  const sub = listing(city, opts);
  seed(propertyId, sub);
  const row = applicant(propertyId, email, tenancy);
  recordApprovedApplicationCharges(row, MANAGER_ID, true);
  const charges = readHouseholdCharges().filter((c) => c.residentEmail.toLowerCase() === email);
  const profile = readRecurringRentProfilesForManager(MANAGER_ID).find((p) => p.residentEmail === email);
  const feeCharges = charges.filter((c) => c.kind === "other_cost" && c.customFeeId);
  const firstRent = charges.find((c) => c.kind === "first_month_rent");
  const recurringRent = charges.filter((c) => c.kind === "rent");
  return { email, propertyId, sub, row, charges, profile, feeCharges, firstRent, recurringRent };
}

function amount(label: string | undefined): number {
  return Number(String(label ?? "0").replace(/[^0-9.]/g, ""));
}

beforeEach(() => {
  window.sessionStorage.clear();
});

describe("the Seattle gate", () => {
  it("is Seattle and only Seattle", () => {
    expect(listingFoldsAllMonthlyFeesIntoRent(listing("seattle"))).toBe(true);
    expect(listingFoldsAllMonthlyFeesIntoRent(listing("tacoma"))).toBe(false);
    expect(listingFoldsAllMonthlyFeesIntoRent(listing("san_francisco"))).toBe(false);
    expect(listingFoldsAllMonthlyFeesIntoRent(null)).toBe(false);
  });

  it("reads the stored property record the way the lease does when the submission has no city", () => {
    const sub = { ...listing("seattle"), city: "", state: "" };
    expect(listingFoldsAllMonthlyFeesIntoRent(sub)).toBe(true); // ZIP + street still say Seattle
    expect(listingFoldsAllMonthlyFeesIntoRent({ ...sub, address: "", zip: "" })).toBe(false);
    expect(
      listingFoldsAllMonthlyFeesIntoRent({ ...sub, address: "", zip: "" }, { address: "4709 8th Ave NE, Seattle, WA 98105" }),
    ).toBe(true);
    // A Washington ZIP alone never promotes a listing to Seattle.
    expect(listingFoldsAllMonthlyFeesIntoRent({ address: "", city: "", state: "", zip: "98402" })).toBe(false);
  });
});

describe("which fees fold (Seattle) — the surcharges stay conditional on the tenancy", () => {
  it("month-to-month tenancy: mtm surcharge + parking + custom fee fold; the custom-lease surcharge does not", () => {
    const sub = listing("seattle");
    const lines = monthlyRentFoldInLines(sub, null, { ...MONTH_TO_MONTH, rentalType: "standard" });
    expect(lines.map((l) => l.id).sort()).toEqual(["fee-parking", "fee-storage", MONTH_TO_MONTH_SURCHARGE_FEE_ID].sort());
    expect(monthlyRentFoldInTotal(sub, null, { ...MONTH_TO_MONTH, rentalType: "standard" })).toBe(100);
    expect(monthlyFeesBilledSeparately(sub, null, { ...MONTH_TO_MONTH, rentalType: "standard" })).toEqual([]);
  });

  it("custom-date lease: custom-lease surcharge + parking + custom fee fold; the mtm surcharge does not", () => {
    const sub = listing("seattle");
    const lines = monthlyRentFoldInLines(sub, null, { ...CUSTOM_DATES, rentalType: "standard" });
    expect(lines.map((l) => l.id).sort()).toEqual(["fee-parking", "fee-storage", CUSTOM_LEASE_SURCHARGE_FEE_ID].sort());
    expect(monthlyRentFoldInTotal(sub, null, { ...CUSTOM_DATES, rentalType: "standard" })).toBe(175);
  });

  it("standard calendar lease: neither surcharge folds, the ordinary monthly fees still do", () => {
    const sub = listing("seattle");
    const lines = monthlyRentFoldInLines(sub, null, { ...CALENDAR_12, rentalType: "standard" });
    expect(lines.map((l) => l.id).sort()).toEqual(["fee-parking", "fee-storage"]);
  });

  it("never folds on a short-term stay, which is priced by the night already", () => {
    const sub = listing("seattle");
    const lines = monthlyRentFoldInLines(sub, null, { ...MONTH_TO_MONTH, rentalType: "short_term" });
    expect(lines.some((l) => l.id === MONTH_TO_MONTH_SURCHARGE_FEE_ID)).toBe(false);
  });

  it("an includeInRent fee is counted once, not twice", () => {
    const sub = listing("seattle", { includeStorageInRent: true });
    const lines = monthlyRentFoldInLines(sub, null, { ...CALENDAR_12, rentalType: "standard" });
    expect(lines.filter((l) => l.id === "fee-storage")).toHaveLength(1);
    expect(monthlyRentFoldInTotal(sub, null, { ...CALENDAR_12, rentalType: "standard" })).toBe(75);
  });
});

describe("which fees fold (everywhere else) — unchanged", () => {
  it("only an includeInRent custom fee folds; everything else bills separately", () => {
    const ctx = { ...MONTH_TO_MONTH, rentalType: "standard" };
    expect(monthlyRentFoldInLines(listing("tacoma"), null, ctx)).toEqual([]);
    expect(monthlyRentFoldInLines(listing("tacoma", { includeStorageInRent: true }), null, ctx).map((l) => l.id)).toEqual(["fee-storage"]);
    const separate = monthlyFeesBilledSeparately(listing("tacoma", { includeStorageInRent: true }), null, ctx);
    expect(separate.map((l) => l.id).sort()).toEqual(["fee-parking"]);
    // The custom-lease surcharge still arrives as its own recurring line outside Seattle.
    const custom = monthlyFeesBilledSeparately(listing("tacoma"), null, { ...CUSTOM_DATES, rentalType: "standard" });
    expect(custom.map((l) => l.id).sort()).toEqual([CUSTOM_LEASE_SURCHARGE_FEE_ID, "fee-parking", "fee-storage"].sort());
  });
});

describe("ledger: a Seattle resident is billed ONE rent line and no monthly fee charges", () => {
  it("month-to-month: rent = base + mtm surcharge + parking + custom fee, and the surcharge finally bills", () => {
    const r = approve("seattle", MONTH_TO_MONTH, "sea-mtm");
    expect(amount(r.firstRent?.amountLabel)).toBe(BASE_RENT + 25 + 60 + 15);
    expect(r.profile?.monthlyRent).toBe(BASE_RENT + 25 + 60 + 15);
    expect(r.profile?.monthlyFees).toEqual([]);
    expect(r.feeCharges).toEqual([]);
    expect(r.recurringRent.length).toBeGreaterThan(0);
    expect(r.recurringRent.every((c) => amount(c.amountLabel) === BASE_RENT + 100)).toBe(true);
  });

  it("custom dates: rent = base + custom-lease surcharge + parking + custom fee, no preset charge row", () => {
    const r = approve("seattle", CUSTOM_DATES, "sea-custom");
    expect(r.profile?.monthlyRent).toBe(BASE_RENT + 100 + 60 + 15);
    expect(r.profile?.monthlyFees).toEqual([]);
    expect(r.charges.some((c) => c.customFeeId === CUSTOM_LEASE_SURCHARGE_FEE_ID)).toBe(false);
    expect(r.feeCharges).toEqual([]);
  });

  it("standard calendar lease: rent = base + parking + custom fee, no surcharge of either kind", () => {
    const r = approve("seattle", CALENDAR_12, "sea-cal");
    expect(r.profile?.monthlyRent).toBe(BASE_RENT + 60 + 15);
    expect(r.feeCharges).toEqual([]);
  });

  it("a rent the manager typed for this resident takes no fold-in", () => {
    const r = approve("seattle", { ...MONTH_TO_MONTH, managerRentOverride: "$1,300" }, "sea-override");
    expect(r.profile?.monthlyRent).toBe(1300);
    expect(r.feeCharges).toEqual([]);
  });
});

describe("ledger: negative control — a non-Seattle listing bills exactly as before", () => {
  it("Tacoma month-to-month: rent is the base rent, parking and the custom fee bill as their own lines", () => {
    const r = approve("tacoma", MONTH_TO_MONTH, "tac-mtm");
    expect(amount(r.firstRent?.amountLabel)).toBe(BASE_RENT);
    expect(r.profile?.monthlyRent).toBe(BASE_RENT);
    expect((r.profile?.monthlyFees ?? []).map((f) => f.id).sort()).toEqual(["fee-parking", "fee-storage"]);
    expect(new Set(r.feeCharges.map((c) => c.customFeeId))).toEqual(new Set(["fee-parking", "fee-storage"]));
  });

  it("San Francisco custom dates: the custom-lease surcharge still bills as its own recurring line", () => {
    const r = approve("san_francisco", CUSTOM_DATES, "sf-custom");
    expect(r.profile?.monthlyRent).toBe(BASE_RENT);
    expect((r.profile?.monthlyFees ?? []).some((f) => f.id === CUSTOM_LEASE_SURCHARGE_FEE_ID)).toBe(true);
    expect(r.charges.some((c) => c.customFeeId === CUSTOM_LEASE_SURCHARGE_FEE_ID)).toBe(true);
  });
});

describe("parity: the placement's rent (what the lease quotes) is the rent the ledger bills", () => {
  it.each([
    ["seattle", MONTH_TO_MONTH, "par-sea-mtm"],
    ["seattle", CUSTOM_DATES, "par-sea-custom"],
    ["seattle", CALENDAR_12, "par-sea-cal"],
    ["tacoma", MONTH_TO_MONTH, "par-tac-mtm"],
    ["san_francisco", CUSTOM_DATES, "par-sf-custom"],
  ] as [City, Tenancy, string][])("%s / %j", (city, tenancy, tag) => {
    const r = approve(city, tenancy, tag);
    const placement = resolvePlacementValuesForRow(r.row);
    expect(placement.signedMonthlyRent).toBeGreaterThan(0);
    expect(placement.signedMonthlyRent).toBe(r.profile?.monthlyRent);
    // A lease that starts on the 1st bills a full first month; a mid-month start bills a
    // prorated line instead, so only the full-month case is compared to the placement.
    if (r.firstRent) expect(placement.signedMonthlyRent).toBe(amount(r.firstRent.amountLabel));
    expect(r.recurringRent.length).toBeGreaterThan(0);
    expect(r.recurringRent.every((c) => amount(c.amountLabel) === placement.signedMonthlyRent)).toBe(true);
  });

  it("a short-lease surcharge is quoted on the placement exactly as the ledger bills it", () => {
    const tag = "par-short-lease";
    const email = `${tag}@example.com`;
    const propertyId = `prop-${tag}`;
    removeResidentHouseholdPaymentData(email);
    const sub = listing("tacoma", { fees: [] });
    sub.rooms = [{ ...sub.rooms[0]!, shortLeaseSurchargeMonthly: "150", shortLeaseMaxMonths: 3 }];
    seed(propertyId, normalizeManagerListingSubmissionV1(sub));
    const row = applicant(propertyId, email, { leaseTerm: "3-Month", leaseStart: "2026-06-01", leaseEnd: "2026-08-31" });
    recordApprovedApplicationCharges(row, MANAGER_ID, true);
    const profile = readRecurringRentProfilesForManager(MANAGER_ID).find((p) => p.residentEmail === email);
    expect(profile?.monthlyRent).toBe(BASE_RENT + 150);
    expect(resolvePlacementValuesForRow(row).signedMonthlyRent).toBe(BASE_RENT + 150);
  });
});

describe("lease document", () => {
  function leaseContext(city: City, tenancy: Tenancy, config = SEATTLE_LEASE_CONFIG): LeaseGenerationContext {
    const sub = listing(city);
    return {
      application: {
        fullLegalName: "Alex Resident",
        email: "doc@example.com",
        rentalType: "standard",
        roomChoice1: `prop-doc${LISTING_ROOM_CHOICE_SEP}room-1`,
        ...tenancy,
      },
      leasedRoom: undefined,
      listingProperty: {
        id: "prop-doc",
        title: sub.buildingName,
        address: `${sub.address}, ${sub.city}, ${sub.state} ${sub.zip}`,
        buildingName: sub.buildingName,
        unitLabel: "Room A",
      } as LeaseGenerationContext["listingProperty"],
      submission: sub,
      generatedAtIso: "2026-05-01T00:00:00.000Z",
      __config: config,
    } as unknown as LeaseGenerationContext;
  }

  it("Seattle month-to-month: fee lines fold into rent and the document prints the composition", () => {
    const sub = listing("seattle");
    const lines = leaseDocumentFeeLines(sub, "long-term", { ...MONTH_TO_MONTH, rentalType: "standard" });
    expect(lines.monthly).toEqual([]);
    expect(lines.foldedIntoRent.map((l) => l.label).sort()).toEqual(["Month-to-month surcharge", "Parking", "Storage locker"].sort());

    for (const style of ["compact_room", "standard"] as const) {
      const html = buildLeaseHtml(leaseContext("seattle", MONTH_TO_MONTH), { ...SEATTLE_LEASE_CONFIG, documentStyle: style });
      expect(html).toContain("$1,100.00");
      expect(html).toContain('data-rent-composition="true"');
      expect(html).toContain("<strong>$1,000.00</strong> base rent");
      expect(html).toMatch(/\$25\.00 month-to-month surcharge/);
      expect(html).toMatch(/\$60\.00 parking/);
      expect(html).toMatch(/\$15\.00 storage locker/);
      expect(html).toContain("not separate fees");
      // The folded fees must NOT also be listed as monthly fees.
      expect(html).not.toMatch(/Parking:<\/strong> \$60\.00/);
      expect(html).not.toMatch(/<th>Parking<\/th>/);
    }
  });

  it("Tacoma month-to-month: the same fees stay their own monthly lines and there is no composition clause", () => {
    const html = buildLeaseHtml(leaseContext("tacoma", MONTH_TO_MONTH), { ...WASHINGTON_LEASE_CONFIG, documentStyle: "standard" });
    expect(html).not.toContain('data-rent-composition="true"');
    expect(html).toMatch(/<th>Parking<\/th><td class="amount">\$60\.00\/mo<\/td>/);
    expect(html).toMatch(/\$1,?000\.00 \/ month/);
  });
});
