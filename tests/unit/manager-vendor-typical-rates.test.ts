import { describe, expect, it } from "vitest";
import {
  centsFromDollarsInput,
  dollarsInputFromCents,
  expandTypicalRateCells,
  findRosterCatalogMatch,
  normalizeTypicalRates,
} from "@/lib/manager-vendor-typical-rates";
import type { ManagerVendorRow } from "@/lib/manager-vendors-storage";

function roster(partial: Partial<ManagerVendorRow> & Pick<ManagerVendorRow, "id" | "name">): ManagerVendorRow {
  return {
    managerUserId: "mgr-1",
    trade: "Plumbing",
    phone: "",
    email: "",
    notes: "",
    active: true,
    ...partial,
  };
}

describe("manager vendor typical rates", () => {
  it("keeps one hourly + service amount per house × trade", () => {
    const rates = normalizeTypicalRates([
      { propertyId: "h1", trade: "Plumbing", hourlyCents: 9500, serviceCents: 18500 },
      { propertyId: "h1", trade: "Plumbing", hourlyCents: 1, serviceCents: 1 },
      { propertyId: "h2", trade: "HVAC", hourlyCents: 12000, serviceCents: 20000 },
      { propertyId: "", trade: "Plumbing", hourlyCents: 1, serviceCents: 1 },
    ]);
    expect(rates).toEqual([
      { propertyId: "h1", trade: "Plumbing", hourlyCents: 9500, serviceCents: 18500 },
      { propertyId: "h2", trade: "HVAC", hourlyCents: 12000, serviceCents: 20000 },
    ]);
  });

  it("fills missing houses from the first rate for that trade, then catalog fallback", () => {
    expect(
      expandTypicalRateCells({
        propertyIds: ["h1", "h2"],
        trades: ["Plumbing"],
        existing: [{ propertyId: "h1", trade: "Plumbing", hourlyCents: 9500, serviceCents: 18500 }],
      }),
    ).toEqual([
      { propertyId: "h1", trade: "Plumbing", hourlyCents: 9500, serviceCents: 18500 },
      { propertyId: "h2", trade: "Plumbing", hourlyCents: 9500, serviceCents: 18500 },
    ]);
    expect(
      expandTypicalRateCells({
        propertyIds: ["h1"],
        trades: ["Plumbing"],
        fallback: { hourlyCents: 9900, serviceCents: 17500 },
      }),
    ).toEqual([{ propertyId: "h1", trade: "Plumbing", hourlyCents: 9900, serviceCents: 17500 }]);
  });

  it("round-trips dollar inputs to cents", () => {
    expect(centsFromDollarsInput("95")).toBe(9500);
    expect(centsFromDollarsInput("$185.50")).toBe(18550);
    expect(dollarsInputFromCents(9500)).toBe("95");
    expect(dollarsInputFromCents(18550)).toBe("185.50");
  });

  it("matches an existing roster row by catalog id, then phone, then name+trade", () => {
    const rows = [
      roster({ id: "a", name: "Northwest Plumbing Co", trade: "Plumbing", catalogId: "axis-catalog-plumbing-nw", phone: "(206) 555-0142" }),
      roster({ id: "b", name: "Apex", trade: "Electrical", phone: "2065550100" }),
    ];
    expect(findRosterCatalogMatch(rows, { catalogId: "axis-catalog-plumbing-nw", name: "Other", trade: "HVAC" })?.id).toBe("a");
    expect(findRosterCatalogMatch(rows, { phone: "206-555-0100", name: "X", trade: "X" })?.id).toBe("b");
    expect(findRosterCatalogMatch(rows, { name: "Northwest Plumbing Co", trade: "Plumbing" })?.id).toBe("a");
    expect(findRosterCatalogMatch(rows, { name: "New Shop", trade: "Roofing" })).toBeUndefined();
  });
});
