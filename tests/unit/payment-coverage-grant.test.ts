import { describe, expect, it } from "vitest";
import {
  listingProplaneAbsorbNeedsWaiverCode,
  listingServiceFeePayerUiValue,
  managerCanSelectProplaneServiceFee,
  persistListingServiceFeePayer,
} from "@/lib/payment-policy";

/**
 * PLAN-0913-1428 named this file for the grant/reset half of PropLane's
 * processing-fee coverage; `tests/unit/processing-coverage-grant.test.ts`
 * already covers the code namespace and `resolveServiceFeePayerFor`. This
 * covers what that file does not: the RESET path (switching away from
 * PropLane pays must never leave a stale coverage code behind) and the two
 * grant-gated eligibility checks the Pricing step reads before it lets a
 * manager pick or keep "PropLane pays". No production data — pure functions.
 */
describe("switching away from PropLane pays resets the coverage code", () => {
  it("clears a valid code the moment the payer becomes resident", () => {
    expect(persistListingServiceFeePayer("resident", "FREE100", true, true)).toEqual({
      serviceFeePayer: "resident",
      serviceFeeWaiverCode: undefined,
    });
  });

  it("clears a valid code the moment the payer becomes manager-absorbed", () => {
    expect(persistListingServiceFeePayer("manager", "FREE100", true, true)).toEqual({
      serviceFeePayer: "manager",
      serviceFeeWaiverCode: undefined,
    });
  });

  it("an unrecognized payer value resets to no payer and no code", () => {
    expect(persistListingServiceFeePayer(null, "FREE100", true, true)).toEqual({
      serviceFeePayer: null,
      serviceFeeWaiverCode: undefined,
    });
    expect(persistListingServiceFeePayer(undefined, "FREE100", true, true)).toEqual({
      serviceFeePayer: null,
      serviceFeeWaiverCode: undefined,
    });
  });

  it("a typo'd code on PropLane pays resets the payer to resident rather than keeping the payer with no code", () => {
    // codeMatches defaults to unresolved (undefined) — a non-empty code that
    // the caller never confirmed is a typo, not a grant.
    expect(persistListingServiceFeePayer("proplane", "NOTREAL", true)).toEqual({
      serviceFeePayer: "resident",
      serviceFeeWaiverCode: undefined,
    });
  });
});

describe("a stale UI value resets to resident rather than trusting what was stored", () => {
  it("PropLane pays without a grant falls back, even if that is what the listing has stored", () => {
    expect(listingServiceFeePayerUiValue("proplane", "free", false)).toBe("resident");
    expect(listingServiceFeePayerUiValue("proplane", "business", false)).toBe("resident");
  });

  it("PropLane pays is kept once the grant is real", () => {
    expect(listingServiceFeePayerUiValue("proplane", "free", true)).toBe("proplane");
  });
});

describe("PropLane pays is selectable only with a real grant, on any tier", () => {
  it("no tier alone unlocks it", () => {
    for (const tier of ["free", "pro", "business"] as const) {
      expect(managerCanSelectProplaneServiceFee(tier, false)).toBe(false);
    }
  });

  it("a grant unlocks it on every tier, including free", () => {
    for (const tier of ["free", "pro", "business"] as const) {
      expect(managerCanSelectProplaneServiceFee(tier, true)).toBe(true);
    }
  });
});

describe("the coverage-code field only asks when there is something to resolve", () => {
  it("asks when the manager picked PropLane pays and the account carries no grant", () => {
    expect(listingProplaneAbsorbNeedsWaiverCode("free", "proplane", false)).toBe(true);
  });

  it("never asks once the account grant already covers it", () => {
    expect(listingProplaneAbsorbNeedsWaiverCode("free", "proplane", true)).toBe(false);
  });

  it("never asks for a payer other than proplane", () => {
    expect(listingProplaneAbsorbNeedsWaiverCode("free", "resident", false)).toBe(false);
    expect(listingProplaneAbsorbNeedsWaiverCode("free", "manager", false)).toBe(false);
    expect(listingProplaneAbsorbNeedsWaiverCode("free", null, false)).toBe(false);
  });
});
