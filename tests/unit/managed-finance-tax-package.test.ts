import { describe, expect, it } from "vitest";
import { buildTaxPackage, taxPackageCsv } from "@/lib/managed-finance/tax-package";
import type { StatementLine } from "@/lib/managed-finance/statement";

let n = 0;
const line = (kind: string, amount: number, postedAt: string, detail: Record<string, unknown> = {}): StatementLine => ({
  journalId: `j${++n}`, amountCents: amount, availableOn: null, postedAt, kind, detail, sourceType: null, sourceId: null,
});
const rent = (postedAt: string, owner: number, fee: number, prop = "p1") =>
  line("rent_capture", -owner, postedAt, { owner_cents: owner, fee_cents: fee, charges: [{ property_id: prop, owner_cents: owner, fee_cents: fee }] });

describe("year-end tax package", () => {
  const owner = [
    rent("2026-02-01T10:00:00Z", 90_000, 10_000),
    rent("2026-03-01T10:00:00Z", 90_000, 10_000),
    rent("2026-03-01T10:00:00Z", 45_000, 5_000, "p2"),
    line("refund", 22_500, "2026-03-10T10:00:00Z", { owner_cents: 22_500, fee_cents: 2_500, property_id: "p1" }),
    line("vendor_bill", 24_000, "2026-04-01T10:00:00Z", { property_id: "p1", title: "Leak" }),
    rent("2025-12-31T10:00:00Z", 90_000, 10_000), // last year
    line("withdrawal_reserve", 50_000, "2026-05-01T10:00:00Z"), // not income or expense
  ];
  const vendors = [
    { ...line("vendor_bill", -24_000, "2026-04-01T10:00:00Z"), partyId: "vendor:v1" },
    { ...line("vendor_bill", -40_000, "2026-06-01T10:00:00Z"), partyId: "vendor:v1" },
    { ...line("vendor_bill", -10_000, "2026-06-02T10:00:00Z"), partyId: "vendor:v2" },
    { ...line("vendor_bill", -99_000, "2025-06-02T10:00:00Z"), partyId: "vendor:v3" },
  ];
  const pkg = buildTaxPackage(2026, owner, vendors, new Map([["vendor:v1", "Mike's Plumbing"], ["vendor:v2", "Joe Cleaning"]]));
  it("totals rents before the fee, the fee, and repairs, per house, net of refunds, for the year only", () => {
    expect(pkg.houses.find((h) => h.propertyId === "p1")).toMatchObject({ rentsReceivedCents: 200_000 - 25_000, managementFeesCents: 20_000 - 2_500, repairsAndVendorsCents: 24_000 });
    expect(pkg.houses.find((h) => h.propertyId === "p2")).toMatchObject({ rentsReceivedCents: 50_000, managementFeesCents: 5_000 });
    expect(pkg.totals.rentsReceivedCents).toBe(225_000);
    expect(pkg.totals.netCents).toBe(225_000 - 22_500 - 24_000);
  });
  it("net equals what the statements say the owner earned (owner shares minus vendor charges)", () => {
    const earned = 90_000 + 90_000 + 45_000 - 22_500 - 24_000;
    expect(pkg.totals.netCents).toBe(earned);
  });
  it("lists vendors with the 1099 threshold, over this year only", () => {
    expect(pkg.vendors).toEqual([
      { partyId: "vendor:v1", name: "Mike's Plumbing", totalCents: 64_000, reportable: true },
      { partyId: "vendor:v2", name: "Joe Cleaning", totalCents: 10_000, reportable: false },
    ]);
  });
  it("exports a CSV that cannot carry a formula", () => {
    const evil = buildTaxPackage(2026, owner, [{ ...line("vendor_bill", -70_000, "2026-06-01T10:00:00Z"), partyId: "vendor:x" }], new Map([["vendor:x", "=HYPERLINK(\"x\")"]]));
    const csv = taxPackageCsv(evil, new Map([["p1", "5259 Brooklyn"]]));
    expect(csv).toContain('"5259 Brooklyn"');
    expect(csv).toContain(`"'=HYPERLINK(""x"")"`);
    expect(csv.split("\n")[0]).toBe('"House","Rents received","Management fees","Repairs and vendors","Net"');
  });
});
