import { describe, expect, it } from "vitest";
import { shouldSimplifyResidentPaymentsHeader } from "@/lib/resident-payments-tabs";

// C261: the Payments header (Upcoming/Due/Paid tabs + the utility button)
// only earns its keep once there is more than one charge to sort through.
describe("shouldSimplifyResidentPaymentsHeader", () => {
  it("simplifies with no charges at all", () => {
    expect(shouldSimplifyResidentPaymentsHeader(0)).toBe(true);
  });

  it("simplifies with exactly one charge, regardless of its status", () => {
    expect(shouldSimplifyResidentPaymentsHeader(1)).toBe(true);
  });

  it("keeps the full header once there is more than one charge", () => {
    expect(shouldSimplifyResidentPaymentsHeader(2)).toBe(false);
    expect(shouldSimplifyResidentPaymentsHeader(5)).toBe(false);
  });
});
