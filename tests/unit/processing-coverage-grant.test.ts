import { describe, expect, it } from "vitest";
import { normalizeProcessingCoverageCode } from "@/lib/processing-coverage-codes";
import { isProcessingCoverageCode } from "@/lib/processing-coverage-codes.server";
import { persistListingServiceFeePayer, resolveServiceFeePayerFor } from "@/lib/payment-policy";
import { waiverGrantedFromPromoCodeServer as waiverGrantedFromPromoCode } from "@/lib/payment-policy.server";
import { isWaiverGrantedManagerPurchase } from "@/lib/manager-access";
import { PRO_MONTHLY_FIRST_FREE_PROMO_CODE } from "@/lib/stripe-promos";

/**
 * PropLane covering Stripe's processing fee is something WE pay for, so exactly
 * one kind of code may switch it on. Before this, the account check was
 * `Boolean(promo_code)` and 19 of 61 production accounts had free processing —
 * two of them off a plain subscription discount nobody meant to be coverage.
 */
describe("processing coverage codes are their own namespace", () => {
  it("accepts only codes PropLane issues for coverage", () => {
    expect(isProcessingCoverageCode("FREE100")).toBe(true);
    expect(isProcessingCoverageCode("WAIVEPROCESS1")).toBe(true);
    expect(isProcessingCoverageCode("free 100")).toBe(true);
  });

  it("rejects a subscription promo, which is a discount on the manager's own plan", () => {
    expect(isProcessingCoverageCode(PRO_MONTHLY_FIRST_FREE_PROMO_CODE)).toBe(false);
    // The two codes that were silently buying coverage in production.
    expect(isProcessingCoverageCode("FIRST20")).toBe(false);
    expect(isProcessingCoverageCode("ONBOARD_FREE_PRO")).toBe(false);
  });

  it("rejects a manager's own application-fee waiver code", () => {
    // Managers invent these themselves and hand them to applicants; one must
    // never be able to make PropLane pay anything.
    for (const invented of ["WELCOME50", "JHASDA", "SPRING"]) {
      expect(isProcessingCoverageCode(invented)).toBe(false);
    }
  });

  it("rejects empty and whitespace rather than treating them as a grant", () => {
    for (const blank of ["", "   ", null, undefined]) {
      expect(isProcessingCoverageCode(blank)).toBe(false);
    }
  });

  it("normalizes case and punctuation", () => {
    expect(normalizeProcessingCoverageCode(" free-100 ")).toBe("FREE100");
  });
});

describe("coverage and paid access are different questions", () => {
  it("a subscription promo still grants ACCESS but never coverage", () => {
    // Narrowing the access predicate too would have revoked the plan these
    // accounts were legitimately given, which is a separate promise.
    expect(isWaiverGrantedManagerPurchase("ONBOARD_FREE_PRO")).toBe(true);
    expect(waiverGrantedFromPromoCode("ONBOARD_FREE_PRO")).toBe(false);
  });

  it("a real coverage code answers both", () => {
    expect(isWaiverGrantedManagerPurchase("FREE100")).toBe(true);
    expect(waiverGrantedFromPromoCode("FREE100")).toBe(true);
  });
});

describe("an unresolved grant never spends PropLane's money", () => {
  it("stores resident when PropLane was chosen with no code and no known grant", () => {
    expect(persistListingServiceFeePayer("proplane", "")).toEqual({
      serviceFeePayer: "resident",
      serviceFeeWaiverCode: undefined,
    });
    // And a code the caller has NOT had the server verify is not a grant either:
    // the browser cannot answer this, so "unresolved" must read as "no".
    expect(persistListingServiceFeePayer("proplane", "FREE100")).toEqual({
      serviceFeePayer: "resident",
      serviceFeeWaiverCode: undefined,
    });
    // With the server's verdict passed in, it is kept.
    expect(persistListingServiceFeePayer("proplane", "FREE100", undefined, true)).toEqual({
      serviceFeePayer: "proplane",
      serviceFeeWaiverCode: "FREE100",
    });
  });

  it("resolves to resident when the grant lookup could not confirm coverage", () => {
    expect(
      resolveServiceFeePayerFor({ tier: "business", propertyChoice: "proplane", waiverGranted: false }),
    ).toBe("resident");
    expect(
      resolveServiceFeePayerFor({ tier: "business", propertyChoice: "proplane" }),
    ).toBe("resident");
  });

  it("honours coverage when the grant is real", () => {
    expect(
      resolveServiceFeePayerFor({ tier: "free", propertyChoice: "proplane", waiverGranted: true }),
    ).toBe("proplane");
  });

  it("no plan tier buys coverage on its own", () => {
    for (const tier of ["free", "pro", "business"] as const) {
      expect(resolveServiceFeePayerFor({ tier, propertyChoice: "proplane" })).toBe("resident");
    }
  });
});
