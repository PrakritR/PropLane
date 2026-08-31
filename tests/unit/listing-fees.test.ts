import { describe, expect, it } from "vitest";
import {
  applyListingFeesToSubmission,
  customFeeBelongsInShortTermLeaseSection,
  defaultCoreListingFeeRows,
  defaultRemovedStandardListingFeeRowsForNewListing,
  legacyListingAmountsFromFees,
  leaseDocumentFeeLines,
  listingFeeRowsForLeaseBasicsSection,
  listingFeesFromLegacyScalars,
  normalizeListingFeeRow,
  resolveListingFees,
  validateListingFeeRows,
} from "@/lib/listing-fees";
import {
  createDefaultListingSubmission,
  createNewListingWizardSubmission,
  normalizeManagerListingSubmissionV1,
} from "@/lib/manager-listing-submission";
import {
  computeLeasePaymentAtSigning,
  formatListingFeeDisplay,
  paymentAtSigningPriceLabel,
} from "@/lib/rental-application/listing-fees-display";

describe("listing fees migration", () => {
  it("builds termination fee rows from legacy scalar fields", () => {
    const sub = createDefaultListingSubmission();
    const fees = listingFeesFromLegacyScalars(sub);
    expect(fees.find((f) => f.presetId === "break_lease_fee")?.amount).toBe("900");
    expect(fees.find((f) => f.presetId === "holdover_daily")?.amount).toBe("45");
  });

  it("builds preset rows from legacy scalar fields", () => {
    const sub = createDefaultListingSubmission();
    sub.securityDeposit = "900";
    sub.moveInFee = "0";
    sub.parkingMonthly = "25";
    const fees = listingFeesFromLegacyScalars(sub);
    expect(fees.find((f) => f.presetId === "security_deposit")?.amount).toBe("900");
    expect(fees.find((f) => f.presetId === "parking_monthly")?.amount).toBe("25");
  });

  it("dual-writes legacy fields from unified fee rows", () => {
    const fees = defaultCoreListingFeeRows();
    const sec = fees.find((f) => f.presetId === "security_deposit");
    if (sec) sec.amount = "500";
    const legacy = legacyListingAmountsFromFees(fees);
    expect(legacy.securityDeposit).toBe("500");
  });

  it("derive payment at signing from dueAtSigning flags", () => {
    const sub = createDefaultListingSubmission();
    const fees = resolveListingFees(sub).map((f) =>
      f.presetId === "move_in_fee" ? { ...f, dueAtSigning: false } : f,
    );
    const next = applyListingFeesToSubmission(sub, fees);
    expect(next.paymentAtSigningIncludes).toContain("security_deposit");
    expect(next.paymentAtSigningIncludes).not.toContain("move_in_fee");
  });

  it("normalizes older submissions into unified fees", () => {
    const sub = createDefaultListingSubmission();
    sub.customFees = [];
    sub.securityDeposit = "100";
    sub.moveInFee = "0";
    sub.parkingMonthly = "0";
    sub.hoaMonthly = "0";
    sub.otherMonthlyFees = "0";
    sub.monthToMonthSurcharge = "0";
    const n = normalizeManagerListingSubmissionV1(sub);
    expect(n.customFees?.some((f) => f.presetId === "security_deposit")).toBe(true);
    expect(n.securityDeposit).toBe("100");
  });

  it("does not re-materialize fee rows the manager removed", () => {
    const sub = createDefaultListingSubmission();
    sub.securityDeposit = "900";
    sub.moveInFee = "0";
    sub.parkingMonthly = "25";
    sub.removedStandardListingFeeRows = ["parkingMonthly", "hoaMonthly"];
    const n = normalizeManagerListingSubmissionV1(sub);
    expect(n.customFees?.some((f) => f.presetId === "parking_monthly")).toBe(false);
    expect(n.customFees?.some((f) => f.presetId === "hoa_monthly")).toBe(false);
    expect(n.parkingMonthly).toBe("");
    expect(n.securityDeposit).toBe("900");
    expect(n.removedStandardListingFeeRows).toEqual(["parkingMonthly", "hoaMonthly"]);
  });

  it("new listing wizard hides every standard other fee except application", () => {
    const hidden = defaultRemovedStandardListingFeeRowsForNewListing();
    expect(hidden).not.toContain("applicationFee");
    expect(hidden).not.toContain("customLeaseSurcharge");
    expect(hidden).toContain("parkingMonthly");
    expect(hidden).toContain("holdingDeposit");

    const sub = createNewListingWizardSubmission();
    expect(sub.removedStandardListingFeeRows).toEqual(hidden);
    expect(sub.holdingDeposit).toBe("");
    expect(sub.customFees?.some((f) => f.presetId === "parking_monthly")).toBe(false);
    expect(sub.customFees?.some((f) => f.presetId === "holding_deposit")).toBe(false);
    expect(sub.customFees?.some((f) => f.presetId === "custom_lease_surcharge")).toBe(true);
  });

  it("re-shows custom lease pricing on edit when a price was saved", () => {
    const sub = createDefaultListingSubmission();
    sub.customLeaseSurcharge = "50";
    sub.removedStandardListingFeeRows = [
      "customLeaseSurcharge",
      ...defaultRemovedStandardListingFeeRowsForNewListing(),
    ];
    const normalized = normalizeManagerListingSubmissionV1(sub);
    expect(normalized.customLeaseSurcharge).toBe("50");
    expect(normalized.removedStandardListingFeeRows).not.toContain("customLeaseSurcharge");
    expect(normalized.customFees?.some((f) => f.presetId === "custom_lease_surcharge" && f.amount === "50")).toBe(
      true,
    );
  });

  it("validates required preset amounts", () => {
    const fees = defaultCoreListingFeeRows();
    const sec = fees.find((f) => f.presetId === "security_deposit");
    if (sec) sec.amount = "";
    const errs = validateListingFeeRows(fees);
    expect(Object.keys(errs).length).toBeGreaterThan(0);
  });

  it("classifies short-term custom fees for lease-basics sections", () => {
    const fee = normalizeListingFeeRow({
      id: "cf1",
      label: "Short term lease",
      amount: "100",
      frequency: "one-time",
      presetId: "custom",
    });
    expect(customFeeBelongsInShortTermLeaseSection(fee)).toBe(true);
    const sub = createDefaultListingSubmission();
    sub.shortTermRentalsAllowed = true;
    sub.customFees = [fee];
    const longTerm = listingFeeRowsForLeaseBasicsSection(sub, "long-term", (v) => `$${v}`);
    const shortTerm = listingFeeRowsForLeaseBasicsSection(sub, "short-term", (v) => `$${v}`);
    expect(longTerm.some((row) => row.title === "Custom lease")).toBe(false);
    expect(shortTerm.some((row) => row.title === "Custom lease")).toBe(true);
  });
});

describe("lease payment at signing", () => {
  it("sums only the listing checkboxes for a placed resident", () => {
    const sub = createDefaultListingSubmission();
    sub.securityDeposit = "400";
    sub.moveInFee = "200";
    sub.paymentAtSigningIncludes = ["security_deposit"];
    expect(
      computeLeasePaymentAtSigning(sub, {
        securityDeposit: 400,
        moveInFee: 200,
        monthlyRent: 800,
        monthlyUtilities: 200,
      }),
    ).toBe(400);
    expect(paymentAtSigningPriceLabel(sub)).toBe("$400.00");
  });

  it("formats bare fee amounts for lease tables", () => {
    expect(formatListingFeeDisplay("50")).toBe("$50.00");
    expect(formatListingFeeDisplay("$75")).toBe("$75");
  });

  it("falls back to deposit and move-in when signing checkboxes are absent", () => {
    expect(
      computeLeasePaymentAtSigning(undefined, {
        securityDeposit: 400,
        moveInFee: 200,
        monthlyRent: 800,
        monthlyUtilities: 200,
      }),
    ).toBe(600);
  });

  it("filters lease document monthly surcharges by lease context", () => {
    let sub = createDefaultListingSubmission();
    sub = applyListingFeesToSubmission(sub, [
      {
        id: "fee-mtm",
        presetId: "mtm_surcharge",
        label: "Month-to-month surcharge",
        amount: "25",
        frequency: "monthly",
      },
      {
        id: "fee-custom",
        presetId: "custom_lease_surcharge",
        label: "Custom lease",
        amount: "100",
        frequency: "monthly",
      },
    ]);
    const normalized = normalizeManagerListingSubmissionV1(sub);

    const fixedTerm = leaseDocumentFeeLines(normalized, "long-term", {
      leaseStart: "2026-06-01",
      leaseEnd: "2027-05-31",
      leaseTerm: "12-Month",
      rentalType: "standard",
    });
    expect(fixedTerm.monthly.map((line) => line.label)).toEqual([]);

    const mtm = leaseDocumentFeeLines(normalized, "long-term", {
      leaseStart: "2026-06-01",
      leaseEnd: "",
      leaseTerm: "Month-to-Month",
      rentalType: "standard",
    });
    expect(mtm.monthly.map((line) => line.label)).toContain("Month-to-month surcharge");

    const custom = leaseDocumentFeeLines(normalized, "long-term", {
      leaseStart: "2026-09-22",
      leaseEnd: "2026-12-01",
      leaseTerm: "Custom",
      rentalType: "standard",
    });
    expect(custom.monthly.map((line) => line.label)).toContain("Custom lease");
    expect(custom.monthly.map((line) => line.label)).not.toContain("Month-to-month surcharge");
  });
});
