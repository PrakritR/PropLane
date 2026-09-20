/**
 * Prefilled lease charges (PLAN-0920-0423): a new listing names every charge with a
 * sensible figure, the two rent-based ones follow the Default room rent until typed over,
 * and an existing listing is never touched.
 */
import { describe, expect, it } from "vitest";
import {
  leaseChargeDefaultMark,
  leaseChargeDefaults,
  resolvedLeaseChargeValue,
  withoutLeaseChargeDefault,
} from "@/lib/lease-charge-defaults";
import {
  createDefaultListingSubmission,
  createNewListingWizardSubmission,
  normalizeManagerListingSubmissionV1,
} from "@/lib/manager-listing-submission";

describe("leaseChargeDefaults", () => {
  it("derives the early move-out fee and holdover from the rent", () => {
    const d = leaseChargeDefaults(1050);
    expect(d.longTermBreakLeaseFee).toBe("1050");
    // 1050 / 30 × 1.5 = 52.5 → 53.
    expect(d.longTermHoldoverDailyRate).toBe("53");
    expect(d.longTermReturnedPaymentFee).toBe("35");
    expect(d.longTermTrashViolationFee).toBe("50");
    expect(d.longTermDepositLaborRate).toBe("45");
    expect(d.longTermDepositReissueFee).toBe("25");
  });
  it("leaves the rent-based figures blank until there is a rent", () => {
    const d = leaseChargeDefaults(0);
    expect(d.longTermBreakLeaseFee).toBe("");
    expect(d.longTermHoldoverDailyRate).toBe("");
    expect(d.longTermReturnedPaymentFee).toBe("35");
  });
});

describe("a new listing", () => {
  it("arrives with every charge marked and the flat ones filled", () => {
    const sub = createNewListingWizardSubmission();
    expect(leaseChargeDefaultMark(sub, "longTermBreakLeaseFee")).toBe("filled");
    expect(leaseChargeDefaultMark(sub, "longTermReturnedPaymentFee")).toBe("filled");
    expect(sub.longTermReturnedPaymentFee).toBe("35");
    expect(sub.longTermBreakLeaseFee ?? "").toBe("");
  });

  it("fills the rent-based charges from the Default room rent once it is typed, on save and on screen", () => {
    const fresh = createNewListingWizardSubmission();
    const withRent = { ...fresh, houseDefaults: { ...(fresh.houseDefaults ?? {}), monthlyRent: 1455 } } as typeof fresh;
    // On screen, before any save.
    expect(resolvedLeaseChargeValue(withRent, "longTermBreakLeaseFee")).toBe("1455");
    expect(resolvedLeaseChargeValue(withRent, "longTermHoldoverDailyRate")).toBe("73");
    // On save.
    const saved = normalizeManagerListingSubmissionV1(withRent);
    expect(saved.longTermBreakLeaseFee).toBe("1455");
    expect(saved.longTermHoldoverDailyRate).toBe("73");
    expect(saved.leaseChargeDefaultKeys).toContain("longTermBreakLeaseFee");
  });

  it("stops tracking a charge the manager typed over", () => {
    const fresh = createNewListingWizardSubmission();
    const typed = {
      ...fresh,
      houseDefaults: { ...(fresh.houseDefaults ?? {}), monthlyRent: 1455 },
      longTermBreakLeaseFee: "500",
      leaseChargeDefaultKeys: withoutLeaseChargeDefault(fresh, "longTermBreakLeaseFee"),
    } as typeof fresh;
    expect(leaseChargeDefaultMark(typed, "longTermBreakLeaseFee")).toBeNull();
    expect(resolvedLeaseChargeValue(typed, "longTermBreakLeaseFee")).toBe("500");
    const saved = normalizeManagerListingSubmissionV1(typed);
    expect(saved.longTermBreakLeaseFee).toBe("500");
    // The untouched holdover still follows the rent.
    expect(saved.longTermHoldoverDailyRate).toBe("73");
  });
});

describe("an existing listing", () => {
  it("keeps its blanks: no marks, no invented charges", () => {
    const old = createDefaultListingSubmission();
    old.rooms = [{ ...old.rooms[0]!, monthlyRent: 1200 }];
    const saved = normalizeManagerListingSubmissionV1(old);
    expect(saved.leaseChargeDefaultKeys).toBeUndefined();
    expect(saved.longTermBreakLeaseFee || undefined).toBeUndefined();
    expect(saved.longTermReturnedPaymentFee || undefined).toBeUndefined();
    expect(leaseChargeDefaultMark(saved, "longTermBreakLeaseFee")).toBeNull();
  });
});
