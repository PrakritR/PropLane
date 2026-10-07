/**
 * What an owner's numbers are, and what they can never contain.
 *
 *  - the summary is built from the manager's own Profitability rows, so net for
 *    a house and month equals the manager's report by construction;
 *  - the payload is an allowlist: asserted free of name / email / phone keys;
 *  - the request can narrow to a granted house and nothing else.
 */
import { describe, expect, it } from "vitest";

import { buildProfitabilityReport } from "@/lib/reports/profitability";
import { dollarsToCents } from "@/lib/reports/money";
import {
  assertOwnerPayloadRedacted,
  forbiddenOwnerPayloadKeys,
  ownerMonthKeys,
  parseOwnerPeriod,
} from "@/lib/property-owner/projection";
import { buildOwnerSummary, profitabilityRowFromCells } from "@/lib/property-owner/summary";
import { loadOwnerSummary, OwnerScopeError } from "@/lib/property-owner/summary.server";
import type { OwnerGrant } from "@/lib/property-owner/access.server";

const HOUSE_A = "house-a";
const HOUSE_B = "house-b";

function report(groupBy: "month" | "property" = "month") {
  return buildProfitabilityReport({
    from: "2026-05-01",
    to: "2026-10-31",
    groupBy,
    ledgerPayments: [
      { propertyId: HOUSE_A, postedDate: "2026-10-03", categoryCode: "rent_income", amountCents: 1_425_000, stripeFeeCents: 0, netCents: 1_410_000 },
      { propertyId: HOUSE_A, postedDate: "2026-10-09", categoryCode: "late_fees", amountCents: 15_000, stripeFeeCents: 0, netCents: 15_000 },
      { propertyId: HOUSE_A, postedDate: "2026-09-03", categoryCode: "rent_income", amountCents: 1_510_000, stripeFeeCents: 0, netCents: 1_510_000 },
      { propertyId: HOUSE_B, postedDate: "2026-10-04", categoryCode: "rent_income", amountCents: 960_000, stripeFeeCents: 0, netCents: 960_000 },
    ],
    expenses: [
      { propertyId: HOUSE_A, expenseDate: "2026-10-12", amountCents: 184_000 },
      { propertyId: HOUSE_B, expenseDate: "2026-10-14", amountCents: 615_000 },
    ],
    vendorPayouts: [{ propertyId: HOUSE_A, paidAt: "2026-10-20T10:00:00.000Z", amountCents: 50_000 }],
    commsUsage: [],
    commsAllowance: { readable: true, cents: null },
    propertyLabel: (id) => (id === HOUSE_A ? "4521 Fremont Ave N" : "1208 E Pike St"),
  });
}

function inputs() {
  const rows = report().report.rows.map((r) => profitabilityRowFromCells(r));
  return [HOUSE_A, HOUSE_B].map((propertyId) => ({
    propertyId,
    label: propertyId === HOUSE_A ? "4521 Fremont Ave N" : "1208 E Pike St",
    profitability: rows,
    rentDueByMonth: { "2026-10": propertyId === HOUSE_A ? 1_510_000 : 960_000 },
    units: 6,
    occupied: 5,
  }));
}

describe("owner numbers equal the manager's Profitability report", () => {
  it("per house and month: net, rent, other income, fees and repairs+services", () => {
    const manager = report().report.rows;
    const summary = buildOwnerSummary("2026-10", inputs());
    for (const property of summary.properties) {
      for (const month of property.months) {
        const managerRow = manager.find((r) => r.propertyId === property.propertyId && r.monthKey === month.month);
        if (!managerRow) {
          expect(month.netCents, `${property.propertyId} ${month.month}`).toBe(0);
          continue;
        }
        expect(month.netCents, `${property.propertyId} ${month.month} net`).toBe(dollarsToCents(String(managerRow.net)));
        expect(month.rentCollectedCents).toBe(dollarsToCents(String(managerRow.grossRent)));
        expect(month.otherIncomeCents).toBe(dollarsToCents(String(managerRow.otherIncome)));
        expect(month.feesCents).toBe(dollarsToCents(String(managerRow.processingFees)));
        expect(month.repairsServicesCents).toBe(
          dollarsToCents(String(managerRow.vendorPayouts)) + dollarsToCents(String(managerRow.expenses)),
        );
        // Net is internally consistent: income less the two expense columns.
        expect(month.netCents).toBe(month.rentCollectedCents + month.otherIncomeCents - month.feesCents - month.repairsServicesCents);
      }
    }
  });

  it("the Overview totals are the sum of the houses, and year to date sums January through the month", () => {
    const summary = buildOwnerSummary("2026-10", inputs());
    const a = summary.properties.find((p) => p.propertyId === HOUSE_A)!;
    const b = summary.properties.find((p) => p.propertyId === HOUSE_B)!;
    expect(summary.totals.netMonthCents).toBe(a.netCents + b.netCents);
    expect(summary.totals.rentCollectedCents).toBe(a.rentCollectedCents + b.rentCollectedCents);
    expect(summary.totals.rentDueCents).toBe(1_510_000 + 960_000);
    expect(summary.totals.units).toBe(12);
    expect(a.netYtdCents).toBe(a.months.filter((m) => m.month.startsWith("2026")).reduce((s, m) => s + m.netCents, 0));
    expect(summary.chart).toHaveLength(12);
    expect(summary.chart.at(-1)!.month).toBe("2026-10");
  });

  it("a month with no rows is zero, never missing", () => {
    const summary = buildOwnerSummary("2026-10", inputs());
    expect(summary.properties[0]!.months).toHaveLength(12);
    expect(summary.properties[0]!.months[0]!.netCents).toBe(0);
  });
});

describe("the owner payload is redacted", () => {
  it("carries no name, email, phone, resident, vendor or ledger key, even when the source row does", () => {
    const polluted = inputs().map((h) => ({
      ...h,
      profitability: h.profitability.map((r) => ({ ...r, residentName: "Jo Tenant", residentEmail: "jo@example.com", phone: "555", vendorName: "Acme Plumbing" })),
      unitRows: [{ unit: "Room 1", status: "occupied" as const, rentCents: 240_000, leaseEnd: "2027-06-30", resident: "Jo Tenant", email: "jo@example.com" } as never],
    }));
    const summary = buildOwnerSummary("2026-10", polluted);
    const json = JSON.stringify(summary);
    expect(forbiddenOwnerPayloadKeys(summary)).toEqual([]);
    expect(() => assertOwnerPayloadRedacted(summary)).not.toThrow();
    for (const needle of ["Jo Tenant", "jo@example.com", "Acme Plumbing", "residentName", "vendorName", "\"email\"", "\"phone\""]) {
      expect(json.includes(needle), needle).toBe(false);
    }
  });

  it("the guard itself catches a leaking key", () => {
    expect(forbiddenOwnerPayloadKeys({ rows: [{ residentName: "x" }] })).toEqual(["residentName"]);
    expect(forbiddenOwnerPayloadKeys({ a: { email: "x" } })).toEqual(["email"]);
    expect(forbiddenOwnerPayloadKeys({ unit: "Room 1", label: "4521 Fremont", netCents: 1 })).toEqual([]);
    expect(() => assertOwnerPayloadRedacted({ vendorId: "v" })).toThrow();
  });
});

describe("the request can only narrow to a granted house", () => {
  const grants: OwnerGrant[] = [
    { linkId: "l", managerUserId: "m", houses: [{ propertyId: HOUSE_A, performance: true, statements: true, documents: true, messages: false }] },
  ];
  // A db that fails the test if it is touched: scope is decided before any read.
  const untouchable = new Proxy({}, { get: () => { throw new Error("db touched before scope was checked"); } }) as never;

  it("refuses a house that is not granted, as if it did not exist", async () => {
    await expect(loadOwnerSummary(untouchable, grants, { period: "2026-10", propertyId: HOUSE_B })).rejects.toBeInstanceOf(OwnerScopeError);
    await expect(loadOwnerSummary(untouchable, grants, { period: "2026-10", propertyId: "../etc" })).rejects.toBeInstanceOf(OwnerScopeError);
  });

  it("refuses a house granted for statements only (no performance key)", async () => {
    const statementsOnly: OwnerGrant[] = [
      { linkId: "l", managerUserId: "m", houses: [{ propertyId: HOUSE_B, performance: false, statements: true, documents: false, messages: false }] },
    ];
    await expect(loadOwnerSummary(untouchable, statementsOnly, { period: "2026-10", propertyId: HOUSE_B })).rejects.toBeInstanceOf(OwnerScopeError);
  });

  it("refuses a period that is not a month", async () => {
    await expect(loadOwnerSummary(untouchable, grants, { period: "2026-13" })).rejects.toBeInstanceOf(OwnerScopeError);
    await expect(loadOwnerSummary(untouchable, grants, { period: "last year" })).rejects.toBeInstanceOf(OwnerScopeError);
  });

  it("parses periods and walks months", () => {
    expect(parseOwnerPeriod("2026-10")).toBe("2026-10");
    expect(parseOwnerPeriod("2026-1")).toBeNull();
    expect(ownerMonthKeys("2026-02", 3)).toEqual(["2025-12", "2026-01", "2026-02"]);
  });
});
