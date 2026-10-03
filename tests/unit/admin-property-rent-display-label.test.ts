import { describe, expect, it } from "vitest";
import { adminPropertyRentDisplayLabel } from "@/lib/demo-admin-property-inventory";

describe("adminPropertyRentDisplayLabel", () => {
  const row = (rentRangeLabel: string | undefined, monthlyRent = 0) => ({ rentRangeLabel, monthlyRent }) as never;
  it("formats a range with commas and an en dash", () => {
    expect(adminPropertyRentDisplayLabel(row("$1050.00-1150.00/mo"))).toBe("$1,050–$1,150/mo");
  });
  it("collapses an equal range and formats one rent", () => {
    expect(adminPropertyRentDisplayLabel(row("$2400.00/mo"))).toBe("$2,400/mo");
    expect(adminPropertyRentDisplayLabel(row(undefined, 950))).toBe("$950/mo");
  });
});
