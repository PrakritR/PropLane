import { describe, expect, it } from "vitest";
import { buildLeaseHtml } from "@/lib/lease-templates/build-lease-html";
import { SEATTLE_LEASE_CONFIG, CALIFORNIA_LEASE_CONFIG } from "@/lib/lease-templates/types";
import { createDefaultListingSubmission, emptyRoom, normalizeManagerListingSubmissionV1, type PaymentAtSigningOptionId } from "@/lib/manager-listing-submission";
import { applyListingFeesToSubmission, applyPaymentAtSigningSelection } from "@/lib/listing-fees";
import type { LeaseGenerationContext } from "@/lib/generated-lease";

function context(): LeaseGenerationContext {
  return {
    application: { fullLegalName: "Test Resident", roomChoice1: "property::room", leaseTerm: "12-Month", leaseStart: "2026-09-01", leaseEnd: "2027-08-31" },
    leasedRoom: undefined,
    listingProperty: undefined,
    submission: { ...createDefaultListingSubmission(), address: "Test property", securityDeposit: "400", moveInFee: "150", rooms: [{ ...emptyRoom(0), id: "room", name: "Selected room", monthlyRent: 825, utilitiesEstimate: "200" }] },
    landlordLegalName: "Test Manager",
    generatedAtIso: "2026-08-01T00:00:00.000Z",
  };
}

const options: PaymentAtSigningOptionId[] = ["security_deposit", "move_in_fee", "first_month_rent", "first_month_utilities"];
const amounts = [400, 150, 825, 200];

describe("lease listing and application source of truth", () => {
  it("keeps daily-priced residential leases on daily labels even for a compact jurisdiction", () => {
    const ctx = context();
    ctx.submission!.rooms[0] = { ...ctx.submission!.rooms[0]!, rentBasis: "daily", dailyRentPrice: 55 };
    const html = buildLeaseHtml(ctx, SEATTLE_LEASE_CONFIG);
    expect(html).toContain("$55.00 / day");
    expect(html).toContain("Daily base rent");
    expect(html).not.toContain("Monthly base rent");
  });

  it("omits waived fees in the full document and requires a completed condition report", () => {
    const ctx = context();
    ctx.submission!.applicationFee = "0";
    ctx.application.managerMoveInFeeOverride = "0";
    const html = buildLeaseHtml(ctx, CALIFORNIA_LEASE_CONFIG);
    expect(html).not.toContain("<th>Move-in fee");
    expect(html).not.toContain("<td>Move-in fee");
    expect(html).not.toContain("<td>Application fee");
    expect(html).toContain("Signing this Agreement does not certify blank condition entries");
  });

  it.each(Array.from({ length: 16 }, (_, mask) => mask))("honors signing selection %i, including no selections", (mask) => {
    const ctx = context();
    ctx.submission!.paymentAtSigningIncludes = options.filter((_, i) => mask & (1 << i));
    ctx.submission = normalizeManagerListingSubmissionV1(ctx.submission!);
    const html = buildLeaseHtml(ctx, SEATTLE_LEASE_CONFIG);
    const total = amounts.reduce((sum, amount, i) => sum + ((mask & (1 << i)) ? amount : 0), 0);
    expect(ctx.submission.paymentAtSigningIncludes).toEqual(options.filter((_, i) => mask & (1 << i)));
    expect(html).toContain(`<strong>Payment Due at Signing:</strong> $${total.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
    if (mask & 4) expect(html).toContain("<strong>$825.00</strong> first month&apos;s rent");
    if (mask & 8) expect(html).toContain("<strong>$200.00</strong> first month&apos;s utilities");
  });

  it("keeps every checkbox cleared across normalization and fee edits", () => {
    let sub = normalizeManagerListingSubmissionV1(context().submission!);
    for (const option of options) sub = applyPaymentAtSigningSelection(sub, option, false);
    sub = applyListingFeesToSubmission(sub, sub.customFees ?? []);
    expect(normalizeManagerListingSubmissionV1(sub).paymentAtSigningIncludes).toEqual([]);
  });

  it.each([SEATTLE_LEASE_CONFIG, CALIFORNIA_LEASE_CONFIG])("uses saved late-fee and monthly due-date settings for $headerSubtitle", (config) => {
    const ctx = context();
    ctx.submission = { ...ctx.submission!, lateFeeAmount: "63", lateFeeGraceDays: 7, rentDueDayMode: "last_of_month" };
    const html = buildLeaseHtml(ctx, config);
    expect(html).toContain("<strong>last calendar day</strong>");
    expect(html).toContain("<strong>7 days</strong>");
    expect(html).toContain("configured late fee is <strong>$63.00</strong>");
    expect(html).not.toContain("<strong>$50</strong>");
    expect(html).not.toContain("<strong>$75.00</strong>");
  });

  it.each([undefined, "", "0"])("does not replace an unset or zero late fee (%s) with a jurisdiction fee", (lateFeeAmount) => {
    const ctx = context();
    ctx.submission!.lateFeeAmount = lateFeeAmount;
    expect(buildLeaseHtml(ctx, { ...SEATTLE_LEASE_CONFIG, defaultLateFeeUsd: 75 })).not.toContain("<strong>Late fee:</strong>");
  });

  it("honors disabling automatic late fees even when the amount is saved", () => {
    const ctx = context();
    ctx.submission!.lateFeeEnabled = false;
    expect(buildLeaseHtml(ctx, SEATTLE_LEASE_CONFIG)).not.toContain("<strong>Late fee:</strong>");
  });

  it("uses application overrides for this resident while preserving the property's configured terms", () => {
    const ctx = context();
    ctx.application = { ...ctx.application, managerRentOverride: "800", managerUtilitiesOverride: "200", managerSecurityDepositOverride: "300", managerMoveInFeeOverride: "0" };
    const html = buildLeaseHtml(ctx, SEATTLE_LEASE_CONFIG);
    expect(html).toContain("<strong>Total Monthly Housing Cost:</strong> $1,000.00");
    expect(html).toContain("<strong>Security Deposit:</strong> $300.00");
    expect(html).not.toContain("<strong>Move-in Fee:</strong>");
  });

  it("omits template-only commercial terms when absent from the listing", () => {
    const html = buildLeaseHtml(context(), { ...SEATTLE_LEASE_CONFIG, defaultLongTermBreakLeaseFeeUsd: 900, defaultLongTermHoldoverDailyUsd: 45, defaultLongTermLeaseUpFeePercent: 100 });
    expect(html).not.toContain("$900.00");
    expect(html).not.toContain("$45.00 per day");
    expect(html).not.toContain("$50</strong>");
    expect(html).not.toContain("10 PM – 8 AM");
    expect(html).not.toContain("bathroom on your floor");
  });

  it("uses the short-term rate, room fees, dates and application check-in times without monthly fee leakage", () => {
    const ctx = context();
    ctx.submission = { ...ctx.submission!, shortTermRentalsAllowed: true, shortTermDailyCost: "50", shortTermDeposit: "300", shortTermMoveInFee: "25", paymentAtSigningIncludes: ["security_deposit"], customFees: [{ id: "monthly", label: "Monthly parking", frequency: "monthly", amount: "90" }] };
    ctx.application = { ...ctx.application, rentalType: "short_term", leaseTerm: "Short-Term Stay", leaseStart: "2026-09-02", leaseEnd: "2026-09-06", shortTermCheckInTime: "15:00", shortTermCheckOutTime: "11:00", managerRentOverride: "75" };
    const html = buildLeaseHtml(ctx, SEATTLE_LEASE_CONFIG);
    expect(html).toContain("$75.00 per day");
    expect(html).toContain("4 nights");
    expect(html).toContain("@ 15:00");
    expect(html).toContain("@ 11:00");
    expect(html).toContain("<strong>Payment Due at Signing:</strong> $300.00");
    expect(html).toContain("<strong>Payment Due Before Check-In:</strong> $625.00");
    expect(html).not.toContain("Monthly parking");
    expect(html).not.toContain("Owner-Occupied Residence");
    expect(html).not.toContain("$825.00");
  });
});
