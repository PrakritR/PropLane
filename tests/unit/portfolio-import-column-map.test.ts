import { describe, expect, it } from "vitest";
import { applyManualColumnMapping, mapPortfolioImportHeaders } from "@/lib/portfolio-import/column-map";

describe("portfolio-import column mapping", () => {
  it("maps AppFolio-style headers exactly and detects the appfolio preset", () => {
    const headers = [
      "Property", "Address", "City", "State", "Zip", "Unit", "Tenant", "Status",
      "Sq Ft", "Email", "Phone", "Rent", "Deposit", "Lease From", "Lease To",
      "Move-in", "Past Due", "Notes",
    ];
    const { columns, preset, unmapped } = mapPortfolioImportHeaders(headers, []);
    expect(preset).toBe("appfolio");
    expect(unmapped).toEqual([]);

    const byHeader = Object.fromEntries(columns.map((c) => [c.header, c]));
    expect(byHeader["Property"].key).toBe("propertyName");
    expect(byHeader["Property"].confidence).toBe("synonym");
    expect(byHeader["Unit"].key).toBe("unitLabel");
    expect(byHeader["Tenant"].key).toBe("residentName");
    expect(byHeader["Rent"].key).toBe("monthlyRent");
    expect(byHeader["Deposit"].key).toBe("securityDeposit");
    expect(byHeader["Lease From"].key).toBe("leaseStart");
    expect(byHeader["Lease To"].key).toBe("leaseEnd");
    expect(byHeader["Move-in"].key).toBe("moveIn");
    expect(byHeader["Past Due"].key).toBe("balance");
    expect(byHeader["Notes"].key).toBe("notes");
    expect(byHeader["Notes"].confidence).toBe("exact");
  });

  it("maps Buildium-style headers and detects the buildium preset", () => {
    const headers = [
      "Property Name", "Address", "City", "State", "Zip", "Unit", "Tenants", "Status",
      "Square Feet", "Email", "Phone", "Monthly Rent", "Market Rent", "Deposits Held",
      "Lease Start", "Lease End", "Move In Date", "Balance Due", "Notes",
    ];
    const { columns, preset, unmapped } = mapPortfolioImportHeaders(headers, []);
    expect(preset).toBe("buildium");

    const byHeader = Object.fromEntries(columns.map((c) => [c.header, c]));
    expect(byHeader["Tenants"].key).toBe("residentName");
    expect(byHeader["Square Feet"].key).toBe("sqft");
    expect(byHeader["Monthly Rent"].key).toBe("monthlyRent");
    expect(byHeader["Deposits Held"].key).toBe("securityDeposit");
    expect(byHeader["Balance Due"].key).toBe("balance");

    // The invariant under test: Market Rent must never collide with monthlyRent.
    expect(byHeader["Market Rent"].key).toBeNull();
    expect(byHeader["Market Rent"].confidence).toBe("unmapped");
    expect(unmapped).toEqual([columns.findIndex((c) => c.header === "Market Rent")]);
  });

  it("never maps Deposit to monthlyRent and never maps Market Rent to monthlyRent", () => {
    const headers = ["Rent", "Deposit", "Market Rent"];
    const { columns } = mapPortfolioImportHeaders(headers, []);
    const byHeader = Object.fromEntries(columns.map((c) => [c.header, c]));
    expect(byHeader["Rent"].key).toBe("monthlyRent");
    expect(byHeader["Deposit"].key).toBe("securityDeposit");
    expect(byHeader["Deposit"].key).not.toBe("monthlyRent");
    expect(byHeader["Market Rent"].key).not.toBe("monthlyRent");
    expect(byHeader["Market Rent"].key).toBeNull();
  });

  it("falls back to generic for odd headers and reports unmapped indices with samples", () => {
    const headers = ["Bldg", "Apt", "Occupant", "Cell", "Rent/mo", "Owed"];
    const samples = [
      ["Maple Court", "1A", "Dana Whitfield", "(206) 555-0134", "1850", ""],
      ["Maple Court", "1B", "Marcus Bell", "(206) 555-0177", "1795", "350"],
    ];
    const { columns, preset, unmapped } = mapPortfolioImportHeaders(headers, samples);
    expect(preset).toBe("generic");

    const byHeader = Object.fromEntries(columns.map((c) => [c.header, c]));
    expect(byHeader["Apt"].key).toBe("unitLabel");
    expect(byHeader["Occupant"].key).toBe("residentName");
    expect(byHeader["Cell"].key).toBe("residentPhone");
    expect(byHeader["Bldg"].key).toBeNull();
    expect(byHeader["Rent/mo"].key).toBeNull();
    expect(byHeader["Owed"].key).toBeNull();

    const bldgIdx = columns.findIndex((c) => c.header === "Bldg");
    const rentIdx = columns.findIndex((c) => c.header === "Rent/mo");
    const owedIdx = columns.findIndex((c) => c.header === "Owed");
    expect(unmapped.sort()).toEqual([bldgIdx, rentIdx, owedIdx].sort());

    // Samples are captured (up to 3), blanks dropped.
    expect(columns.find((c) => c.header === "Rent/mo")?.samples).toEqual(["1850", "1795"]);
  });

  it("a presetHint always wins over detection", () => {
    const headers = ["Tenants", "Market Rent", "Deposits Held"]; // clearly buildium-shaped
    const { preset } = mapPortfolioImportHeaders(headers, [], "appfolio");
    expect(preset).toBe("appfolio");
  });

  it("applyManualColumnMapping overrides a column to manual confidence, or clears it", () => {
    const headers = ["Rent/mo", "Owed"];
    const { columns } = mapPortfolioImportHeaders(headers, []);
    expect(columns[0].key).toBeNull();

    const remapped = applyManualColumnMapping(columns, 0, "monthlyRent");
    expect(remapped[0].key).toBe("monthlyRent");
    expect(remapped[0].confidence).toBe("manual");
    // Original array is untouched.
    expect(columns[0].key).toBeNull();

    const cleared = applyManualColumnMapping(remapped, 0, null);
    expect(cleared[0].key).toBeNull();
    expect(cleared[0].confidence).toBe("unmapped");
  });
});
