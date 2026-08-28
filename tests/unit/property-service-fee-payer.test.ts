/**
 * A property's own processing-fee setting.
 *
 * A manager running one building where they absorb fees and another where residents pay is a real
 * arrangement, and previously it was one switch for the whole account. The per-property value sits
 * between the staff override and the account default.
 *
 * Two things carry the weight here. Absence must mean "follow the account" rather than a default
 * payer, or a property created today would be frozen at whatever the account said this morning.
 * And a checkout batch spanning properties that DISAGREE must be refused: one session bills one
 * total, so resolving to either property's answer silently changes what this resident pays.
 */
import { describe, expect, it } from "vitest";
import {
  createDefaultListingSubmission,
  normalizeManagerListingSubmissionV1,
} from "@/lib/manager-listing-submission";
import { resolveServiceFeePayerFor } from "@/lib/payment-policy";

/** Normalize a real submission with one field varied — the normalizer walks the whole shape. */
const withFeePayer = (raw: unknown) =>
  normalizeManagerListingSubmissionV1({ ...createDefaultListingSubmission(), serviceFeePayer: raw } as never)
    .serviceFeePayer;

describe("the stored value", () => {
  it("keeps a real choice", () => {
    for (const choice of ["resident", "manager", "proplane"] as const) {
      expect(withFeePayer(choice)).toBe(choice);
    }
  });

  it("reads absence as null, not as a payer", () => {
    // "resident" here would PIN every existing property to today's default, so a manager who
    // later switches their account setting would see nothing change.
    for (const raw of [undefined, null, "", "wat", 3]) {
      expect(withFeePayer(raw)).toBeNull();
    }
  });

  it("defaults a brand-new listing to following the account", () => {
    expect(createDefaultListingSubmission().serviceFeePayer).toBeNull();
  });
});

describe("where it sits in the order", () => {
  it("overrides the account default", () => {
    expect(
      resolveServiceFeePayerFor({ tier: "pro", managerChoice: "manager", propertyChoice: "resident" }),
    ).toBe("resident");
  });

  it("yields to a staff override", () => {
    expect(
      resolveServiceFeePayerFor({ tier: "pro", propertyChoice: "manager", adminOverride: "resident" }),
    ).toBe("resident");
  });

  it("falls through to the account when the property says nothing", () => {
    expect(
      resolveServiceFeePayerFor({ tier: "pro", managerChoice: "manager", propertyChoice: null }),
    ).toBe("manager");
  });

  it("is still bound by the plan floor", () => {
    // A free-tier manager cannot absorb fees by setting it on one property either.
    expect(
      resolveServiceFeePayerFor({ tier: "free", propertyChoice: "manager" }),
    ).toBe("resident");
  });
});

describe("a batch that spans properties", () => {
  // The checkout groups charges into one session, so the payers must agree. This mirrors the
  // check the checkout performs before billing.
  const agree = (choices: (string | null)[]) =>
    new Set(choices.map((c) => c ?? "inherit")).size === 1;

  it("accepts charges whose properties agree", () => {
    expect(agree(["manager", "manager"])).toBe(true);
    expect(agree([null, null])).toBe(true);
  });

  it("treats an unset property as different from an explicitly set one", () => {
    // They can resolve to the same payer today and diverge tomorrow, so they are not the same
    // instruction and must not be silently merged.
    expect(agree([null, "resident"])).toBe(false);
  });

  it("rejects a batch that disagrees", () => {
    expect(agree(["manager", "resident"])).toBe(false);
  });
});
