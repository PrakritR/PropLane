/** @vitest-environment jsdom */
import { beforeEach, describe, expect, it } from "vitest";
import { applicantRoomOptionLabel } from "@/components/marketing/rental-wizard-steps";
import { applicantListingQuote, applicantPaymentAtSigningPriceLabel } from "@/lib/rental-application/listing-fees-display";
import { buildListingQuote } from "@/lib/listing-quote";
import { createDefaultListingSubmission, normalizeManagerListingSubmissionV1 } from "@/lib/manager-listing-submission";
import { SHORT_TERM_LEASE_TERM } from "@/lib/rental-application/lease-terms";
import { cachePublicExtraListings } from "@/lib/demo-property-pipeline";
import { readHouseholdCharges, recordApprovedApplicationCharges } from "@/lib/household-charges";
import { createInitialRentalWizardState } from "@/lib/rental-application/state";
import { validateRentalWizardStep } from "@/lib/rental-application/validate";
import { buildLeaseBillingSnapshot } from "@/lib/lease-billing-snapshot";
import { buildLeaseHtml } from "@/lib/lease-templates/build-lease-html";
import { SEATTLE_LEASE_CONFIG } from "@/lib/lease-templates/types";
import type { DemoApplicantRow } from "@/data/demo-portal";

function listing() {
  const base = createDefaultListingSubmission();
  const sub = normalizeManagerListingSubmissionV1({ ...base, shortTermRentalsAllowed: true,
    shortTermDailyCost: "95", shortTermDeposit: "700", shortTermMoveInFee: "0", applicationFee: "50",
    rooms: [{ ...base.rooms[0]!, id: "room", name: "Guest room", monthlyRent: 1000,
      shortTermRent: "55", shortTermDeposit: "250", shortTermMoveInFee: "0" }],
  });
  return { ...sub, paymentAtSigningIncludes: [], paymentAtSigningByLeaseType: { [SHORT_TERM_LEASE_TERM]: [] } };
}
const input = { roomChoice1: "quote-house::room", leaseTerm: SHORT_TERM_LEASE_TERM,
  leaseStart: "2027-10-21", leaseEnd: "2027-10-22" };

beforeEach(() => { window.sessionStorage.clear(); window.localStorage.clear(); });

describe("applicant stay quote", () => {
  it("labels the selected resident slot nightly rate and a weekly-only offer", () => {
    const sub = listing();
    const form = { ...createInitialRentalWizardState(), ...input, rentalType: "short_term" as const };
    sub.rooms[0] = { ...sub.rooms[0]!, occupancyCapacity: 2, stayResidentPricing: "per_resident",
      stayResidentPrices: [{ shortTermRent: "55" }, { shortTermRent: "65" }] };
    expect(applicantRoomOptionLabel("Guest room · $1,000/mo", "quote-house::room::r2", form, sub)).toBe("Guest room · $65/night");
    sub.shortTermDailyCost = "";
    sub.rooms[0] = { ...sub.rooms[0]!, stayResidentPricing: "per_resident", shortTermRent: "", weeklyRentPrice: 350,
      stayResidentPrices: [{ shortTermRent: "", weeklyRentPrice: 350 }] };
    expect(applicantRoomOptionLabel("Guest room · $1,000/mo", "quote-house::room::r1", form, sub)).toBe("Guest room · $350/week");
  });

  it.each([["2027-10-22", 55], ["2027-10-23", 110]])("quotes checkout-exclusive nights through %s", (leaseEnd, total) => {
    const quote = applicantListingQuote(listing(), { ...input, leaseEnd })!;
    expect(quote.stayTotal).toBe(total);
    expect(quote.monthlyRent).toBe(0);
    expect(quote.signingLines.find((line) => line.key === "room_rent:room")).toMatchObject({ amount: total, dueAtSigning: false, dueLabel: "Before check-in" });
    expect(quote.signingLines.find((line) => line.key === "security_deposit")).toMatchObject({ amount: 250, dueAtSigning: false, dueLabel: "Before check-in" });
    expect(quote.applicationFees).toEqual([{ id: "application_fee", label: "Application fee", amount: 50 }]);
  });

  it.each([["", ""], ["2027-10-21", ""], ["2027-10-21", "2027-10-21"], ["2027-10-22", "2027-10-21"]])("does not invent a total for %s → %s", (leaseStart, leaseEnd) => {
    const quote = applicantListingQuote(listing(), { ...input, leaseStart, leaseEnd })!;
    expect(quote.stayTotal).toBeNull();
    expect(quote.signingLines.some((line) => line.key === "room_rent:room")).toBe(false);
  });

  it("does not show the monthly amount in generic manager quotes without dates", () => {
    const quote = buildListingQuote(listing(), { roomId: "room", leaseTerm: SHORT_TERM_LEASE_TERM });
    expect(quote.stayTotal).toBeNull();
    expect(quote.signingLines.find((line) => line.label === "Stay total")).toMatchObject({ amount: 0, amountPending: true });
  });

  it("refuses unknown rooms and bundle shares without a placed roster", () => {
    expect(applicantListingQuote(listing(), { ...input, roomChoice1: "quote-house::missing" })).toBeNull();
    expect(applicantListingQuote(listing(), { ...input, bundleId: "group-bundle" })).toBeNull();
  });

  it("preserves whole-home long-term rent while short stays use the ledger's premises room", () => {
    const sub = listing();
    sub.listingPlaceCategoryId = "entire_home";
    sub.rentalModelStamp = "entire_home";
    sub.entireHomeMonthlyRent = 4000;
    expect(applicantListingQuote(sub, { roomChoice1: "quote-house", leaseTerm: "Long-term" })?.monthlyRent).toBe(4000);
    expect(applicantListingQuote(sub, { ...input, roomChoice1: "quote-house" })?.stayTotal).toBe(55);
  });

  it("never reports zero signing dollars when dates are missing", () => {
    expect(applicantPaymentAtSigningPriceLabel(listing(), { ...input, leaseStart: "", leaseEnd: "" })).toBe("—");
  });

  it("does not inherit a listing deposit that the room-based ledger never bills", () => {
    const sub = listing(); sub.rooms[0]!.shortTermDeposit = "";
    expect(applicantListingQuote(sub, input)!.securityDeposit).toBe(0);
  });

  it("separates template lease fees from check-in charges and excludes long-only custom fees", () => {
    const sub = listing();
    sub.rooms[0]!.termPricing = { [SHORT_TERM_LEASE_TERM]: { leaseFee: "35", applicationFee: "20", moveInFee: "15" } };
    sub.customFees = [...sub.customFees, { id: "linen", label: "Linen", amount: "100", shortTermAmount: "12", frequency: "monthly", presetId: "custom" }, { id: "parking", label: "Parking", amount: "80", frequency: "monthly", presetId: "custom" }];
    const quote = applicantListingQuote(sub, input)!;
    expect(quote.signingTotal).toBe(35);
    expect(quote.signingLines.find((line) => line.key === "lease_fee")).toMatchObject({ amount: 35, dueLabel: "Before lease signing" });
    expect(quote.signingLines.find((line) => line.key === "move_in_fee")?.amount).toBe(15);
    expect(quote.signingLines.find((line) => line.key === "fee:linen")?.amount).toBe(12);
    expect(quote.signingLines.some((line) => line.key === "fee:parking")).toBe(false);
    expect(quote.applicationFees[0]?.amount).toBe(20);
  });

  it.each([["2027-10-28", 350], ["2027-10-29", null]])("weekly-only pricing is complete only for exact weeks through %s", (leaseEnd, expected) => {
    const sub = listing();
    sub.shortTermDailyCost = "";
    sub.customFees = sub.customFees.filter((fee) => fee.presetId !== "short_term_nightly");
    sub.rooms[0]!.shortTermRent = "";
    sub.rooms[0]!.weeklyRentPrice = 350;
    const property = { id: "quote-house", title: "QA Guest house", managerUserId: "weekly-manager", listingSubmission: sub };
    cachePublicExtraListings([property], { silent: true });
    const selection = { ...input, leaseEnd };
    const quote = applicantListingQuote(sub, selection)!;
    expect(quote.stayTotal).toBe(expected);
    const application = { ...createInitialRentalWizardState(), ...selection, propertyId: property.id,
      rentalType: "short_term" as const, fullLegalName: "QA Weekly", applyingAsGroup: "no" as const, shortTermRulesAck: true };
    const row = { id: `weekly-${leaseEnd}`, name: "QA Weekly", email: `weekly-${leaseEnd}@example.test`,
      propertyId: property.id, managerUserId: "weekly-manager", assignedRoomChoice: input.roomChoice1, application } as DemoApplicantRow;
    recordApprovedApplicationCharges(row, "weekly-manager", true, { leaseExecuted: true });
    const charge = readHouseholdCharges().find((entry) => entry.residentEmail === row.email && entry.kind === "stay_total");
    const snapshot = buildLeaseBillingSnapshot(row, "weekly-manager");
    const errors = validateRentalWizardStep(1, application, { property });
    const html = buildLeaseHtml({ application, submission: sub, landlordLegalName: "QA Manager", generatedAtIso: "2027-10-01T00:00:00Z" }, SEATTLE_LEASE_CONFIG);
    if (expected === null) {
      expect(charge).toBeUndefined();
      expect(snapshot.stayRent).toBeUndefined();
      expect(snapshot.totalBeforeCheckIn).toBeUndefined();
      expect(errors.leaseEnd).toContain("weekly rate");
      expect(html).not.toContain("<strong>Rent for Stay:</strong> $350.00");
    } else {
      expect(charge?.amountLabel).toBe("$350.00");
      expect(snapshot.stayRent).toBe(350);
      expect(errors.leaseEnd).toBeUndefined();
      expect(html).toContain("$350.00");
    }
  });

  it("keeps weekly and resident-slot prices equal in quote, approval charges and generated lease", () => {
    const sub = listing();
    sub.rooms[0] = { ...sub.rooms[0]!, occupancyCapacity: 2, stayResidentPricing: "per_resident",
      stayResidentPrices: [{ shortTermRent: "55", weeklyRentPrice: 300 }, { shortTermRent: "65", weeklyRentPrice: 350 }] };
    const property = { id: "slot-house", title: "QA Guest house", managerUserId: "quote-manager", listingSubmission: sub };
    cachePublicExtraListings([property], { silent: true });
    const choice = { ...input, roomChoice1: "slot-house::room::r2", residentSlot: 2, leaseEnd: "2027-10-29" };
    const quote = applicantListingQuote(sub, choice)!;
    expect(quote.stayTotal).toBe(415); // one week at $350 + one night at $65
    const application = { ...choice, residentSlot: undefined, propertyId: property.id, rentalType: "short_term" as const, fullLegalName: "QA Resident" };
    const row = { id: "quote-app", name: "QA Resident", email: "quote@example.test", propertyId: property.id,
      managerUserId: "quote-manager", assignedRoomChoice: choice.roomChoice1, application } as DemoApplicantRow;
    recordApprovedApplicationCharges(row, "quote-manager", true, { leaseExecuted: true });
    expect(readHouseholdCharges().find((charge) => charge.residentEmail === row.email && charge.kind === "stay_total")?.amountLabel).toBe("$415.00");
    expect(buildLeaseBillingSnapshot(row, "quote-manager").stayRent).toBe(415);
    const html = buildLeaseHtml({ application, submission: sub, landlordLegalName: "QA Manager", generatedAtIso: "2027-10-01T00:00:00Z" }, SEATTLE_LEASE_CONFIG);
    expect(html).toContain("$415.00");
    expect(html).not.toContain("$520.00");
  });
});
