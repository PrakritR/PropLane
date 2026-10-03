import { describe, expect, it } from "vitest";
import { resolveChargePaidCents } from "@/lib/charge-paid-cents.server";

describe("resolveChargePaidCents", () => {
  it("prefers the ledger payment amount", () => {
    expect(resolveChargePaidCents(125_00, { amountLabel: "$50.00" })).toBe(125_00);
  });

  it("falls back to paidAmountCents then amountLabel", () => {
    expect(resolveChargePaidCents(0, { paidAmountCents: 99_00, amountLabel: "$50.00" })).toBe(99_00);
    expect(resolveChargePaidCents(null, { amountLabel: "$42.50" })).toBe(42_50);
  });
});
