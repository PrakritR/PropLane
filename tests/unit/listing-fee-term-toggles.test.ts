import { describe, expect, it } from "vitest";
import {
  applyListingLtFeeAmountForRow,
  applyListingLtFeeToggle,
  applyListingStFeeAmount,
  applyListingStFeeToggle,
  deriveListingLtFeeToggles,
  deriveListingStFeeToggles,
  listingPresetFeeAmountIfEnabled,
  readListingFeeCellAmount,
  validateListingLtFeeToggles,
  validateListingStFeeToggles,
} from "@/lib/listing-fee-term-toggles";
import { createDefaultListingSubmission, normalizeManagerListingSubmissionV1 } from "@/lib/manager-listing-submission";
import { validateListingWizardStep } from "@/lib/listing-wizard-validation";

describe("listing fee term toggles", () => {
  it("derives ST toggles from stored submission amounts", () => {
    const sub = createDefaultListingSubmission();
    sub.shortTermDailyCost = "85";
    sub.shortTermApplicationFee = "50";
    sub.applicationFee = "40";
    sub.shortTermDeposit = "";
    sub.shortTermMoveInFee = "0";

    expect(deriveListingStFeeToggles(sub)).toMatchObject({
      rent: true,
      applicationFee: true,
      securityDeposit: false,
      moveInFee: true,
    });
  });

  it("derives LT toggles from stored submission amounts", () => {
    const sub = createDefaultListingSubmission();
    sub.securityDeposit = "900";
    sub.moveInFee = "0";
    sub.rooms[0]!.monthlyRent = 800;

    expect(deriveListingLtFeeToggles(sub)).toMatchObject({
      rent: true,
      securityDeposit: true,
      moveInFee: true,
    });
  });

  it("clears ST fields when toggled off", () => {
    const sub = createDefaultListingSubmission();
    sub.shortTermDailyCost = "120";
    sub.shortTermApplicationFee = "40";
    sub.applicationFee = "55";

    const next = applyListingStFeeToggle(sub, "rent", false);
    expect(next.shortTermDailyCost).toBe("");
    expect(next.shortTermApplicationFee).toBe("40");
    expect(next.applicationFee).toBe("55");
  });

  it("clears short-term application fee independently of long-term", () => {
    const sub = createDefaultListingSubmission();
    sub.shortTermApplicationFee = "30";
    sub.applicationFee = "55";

    const next = applyListingStFeeToggle(sub, "applicationFee", false, { ...deriveListingLtFeeToggles(sub), applicationFee: true });
    expect(next.shortTermApplicationFee).toBe("");
    expect(next.applicationFee).toBe("55");
  });

  it("clears LT entire-home rent when toggled off", () => {
    const sub = createDefaultListingSubmission();
    sub.listingPlaceCategoryId = "entire_home";
    sub.entireHomeMonthlyRent = 4200;

    const next = applyListingLtFeeToggle(sub, "rent", false);
    expect(next.entireHomeMonthlyRent).toBe(0);
  });

  it("maps ST rent amount to shortTermDailyCost", () => {
    const sub = createDefaultListingSubmission();
    const next = applyListingStFeeAmount(sub, "rent", "95");
    expect(next.shortTermDailyCost).toBe("95");
  });

  it("maps ST deposit amount to shortTermDeposit", () => {
    const sub = createDefaultListingSubmission();
    const next = applyListingStFeeAmount(sub, "securityDeposit", "500");
    expect(next.shortTermDeposit).toBe("500");
  });

  it("reads entire-home LT rent from entireHomeMonthlyRent", () => {
    const sub = createDefaultListingSubmission();
    sub.entireHomeMonthlyRent = 4500;
    expect(readListingFeeCellAmount(sub, "entireHomeMonthlyRent")).toBe("4500");
  });

  it("requires nightly rate only when ST rent toggle is on", () => {
    const sub = createDefaultListingSubmission();
    sub.shortTermRentalsAllowed = true;

    expect(validateListingStFeeToggles(sub, { ...deriveListingStFeeToggles(sub), rent: false }, true)).toEqual({});

    const errs = validateListingStFeeToggles(sub, { ...deriveListingStFeeToggles(sub), rent: true }, true);
    expect(errs.shortTermDailyCost).toMatch(/nightly/i);
  });

  it("requires LT fee amounts only when LT toggles are on", () => {
    const sub = createDefaultListingSubmission();
    sub.securityDeposit = "";

    const toggles = { ...deriveListingLtFeeToggles(sub), securityDeposit: true };
    const errs = validateListingLtFeeToggles(sub, toggles, true);
    expect(errs.securityDeposit).toMatch(/required/i);
  });
});

describe("listing wizard ST fee validation integration", () => {
  function filledPricingSubmission() {
    const sub = createDefaultListingSubmission();
    sub.listingPlaceCategoryId = "by_room";
    sub.allowedLeaseTerms = ["12-Month"];
    sub.securityDeposit = "900";
    sub.moveInFee = "0";
    sub.parkingMonthly = "0";
    sub.hoaMonthly = "0";
    sub.otherMonthlyFees = "0";
    sub.monthToMonthSurcharge = "0";
    sub.rooms[0]!.monthlyRent = 900;
    return sub;
  }

  it("does not require ST nightly rate when ST rent toggle is off", () => {
    const sub = filledPricingSubmission();
    sub.shortTermRentalsAllowed = true;
    sub.shortTermDailyCost = "";

    const errs = validateListingWizardStep(4, sub, {
      stFeeToggles: { ...deriveListingStFeeToggles(sub), rent: false },
      ltFeeToggles: deriveListingLtFeeToggles(sub),
    });
    expect(errs.shortTermDailyCost).toBeUndefined();
  });

  it("requires ST nightly rate when ST rent toggle is on", () => {
    const sub = filledPricingSubmission();
    sub.shortTermRentalsAllowed = true;
    sub.shortTermDailyCost = "";

    const errs = validateListingWizardStep(4, sub, {
      stFeeToggles: { ...deriveListingStFeeToggles(sub), rent: true },
      ltFeeToggles: deriveListingLtFeeToggles(sub),
    });
    expect(errs.shortTermDailyCost).toMatch(/nightly/i);
  });

  it("does not require room rent when LT rent toggle is off", () => {
    const sub = filledPricingSubmission();
    sub.rooms[0]!.monthlyRent = 0;

    const errs = validateListingWizardStep(4, sub, {
      ltFeeToggles: { ...deriveListingLtFeeToggles(sub), rent: false },
    });
    expect(errs.monthlyRent).toBeUndefined();
  });
});

/**
 * A fee edit must reach the `customFees` preset row, not just the legacy scalar (PRP-219).
 * `resolveListingFees` lets the row outrank the scalar, and
 * `normalizeManagerListingSubmissionV1` re-derives the scalar FROM the row on every load — so
 * a writer that touched only the scalar had its edit erased on the next read. Unchecking a
 * fee left the amount standing; retyping the amount was discarded.
 */
describe("fee writes reach the unified fee row", () => {
  function withOtherFeeRow(amount: string) {
    const sub = createDefaultListingSubmission();
    sub.customFees = [
      { id: "cf-other", label: "Other monthly fees", amount, frequency: "monthly", presetId: "other_monthly" },
    ] as never;
    return normalizeManagerListingSubmissionV1(sub);
  }

  function otherFeeRowAmount(sub: ReturnType<typeof withOtherFeeRow>) {
    return (sub.customFees ?? []).find((fee) => (fee as { presetId?: string }).presetId === "other_monthly")?.amount;
  }

  it("unchecking a fee clears the row, so the amount does not come back on reload", () => {
    const off = normalizeManagerListingSubmissionV1(
      applyListingLtFeeToggle(withOtherFeeRow("150"), "otherMonthlyFees", false),
    );

    expect(otherFeeRowAmount(off)).toBe("");
    expect(off.otherMonthlyFees).toBe("");
    expect(deriveListingLtFeeToggles(off).otherMonthlyFees).toBe(false);
    expect(listingPresetFeeAmountIfEnabled(off, "other_monthly")).toBe(0);
  });

  it("editing a fee amount survives the reload instead of reverting to the stored row", () => {
    const edited = normalizeManagerListingSubmissionV1(
      applyListingLtFeeAmountForRow(withOtherFeeRow("150"), "otherMonthlyFees", "200"),
    );

    expect(otherFeeRowAmount(edited)).toBe("200");
    expect(edited.otherMonthlyFees).toBe("200");
    expect(listingPresetFeeAmountIfEnabled(edited, "other_monthly")).toBe(200);
  });

  it("clearing the short-term cell leaves the long-term fee alone", () => {
    const sub = createDefaultListingSubmission();
    sub.customFees = [
      { id: "cf-dep", label: "Security deposit", amount: "1000", frequency: "one-time", presetId: "security_deposit" },
      { id: "cf-st-dep", label: "Security deposit", amount: "500", frequency: "one-time", presetId: "short_term_deposit" },
    ] as never;
    const seeded = normalizeManagerListingSubmissionV1(sub);

    const next = normalizeManagerListingSubmissionV1(
      applyListingStFeeAmount(seeded, "securityDeposit", ""),
    );

    expect(listingPresetFeeAmountIfEnabled(next, "security_deposit")).toBe(1000);
  });
});
