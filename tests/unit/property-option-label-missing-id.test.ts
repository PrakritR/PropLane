import { describe, expect, it } from "vitest";
import { safePropertyOptionLabel } from "@/lib/manager-portfolio-access";

/**
 * A cached listing can reach the property pickers without an id (a malformed
 * browser-store row). The label helper used to call `.trim()` on that id and
 * take Communication down with "Cannot read properties of undefined".
 */
describe("safePropertyOptionLabel without an id", () => {
  it("still labels the option from its human candidates", () => {
    expect(safePropertyOptionLabel(["Cedar Lane Duplex"], undefined)).toBe("Cedar Lane Duplex");
    expect(safePropertyOptionLabel(["Cedar Lane Duplex"], null)).toBe("Cedar Lane Duplex");
  });

  it("keeps treating a candidate equal to the id as a raw id", () => {
    expect(safePropertyOptionLabel(["imp-abc123", "Maple Court"], "imp-abc123")).toBe("Maple Court");
  });
});
