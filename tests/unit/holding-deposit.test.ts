import { describe, expect, it } from "vitest";

import { normalizeHoldingDepositLabel } from "@/lib/household-charges";

describe("holding deposit", () => {
  it("leaves unset holding deposits empty", () => {
    expect(normalizeHoldingDepositLabel(undefined)).toBe("");
    expect(normalizeHoldingDepositLabel("")).toBe("");
    expect(normalizeHoldingDepositLabel(null)).toBe("");
    expect(normalizeHoldingDepositLabel("   ")).toBe("");
  });

  it("preserves explicit manager amounts", () => {
    expect(normalizeHoldingDepositLabel("$250")).toBe("$250");
    expect(normalizeHoldingDepositLabel("75")).toBe("75");
  });
});
