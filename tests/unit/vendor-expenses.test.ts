import { describe, expect, it } from "vitest";
import {
  parseVendorExpenseBody,
  vendorExpenseSegment,
  vendorExpenseSegmentCounts,
  vendorExpensesCsv,
  parseAmountToCents,
  type VendorExpense,
} from "@/lib/vendor-expenses";
import { deriveVendorOverview, earnedContributionCents } from "@/lib/vendor-banking/overview";

describe("expense validation", () => {
  const ok = { expenseDate: "2026-10-06", amountCents: 3840, category: "fuel_travel" };

  it("accepts a complete body and normalizes the note and service link", () => {
    const parsed = parseVendorExpenseBody({ ...ok, memo: "  Gas  ", workOrderId: " wo-1 " }, { partial: false });
    expect(parsed).toEqual({
      ok: true,
      value: { ...ok, memo: "Gas", workOrderId: "wo-1" },
    });
  });

  it("never reads an owner from the body", () => {
    const parsed = parseVendorExpenseBody({ ...ok, vendor_user_id: "someone-else" }, { partial: false });
    expect(parsed.ok && "vendor_user_id" in parsed.value).toBe(false);
  });

  it("a partial patch carries only what was sent; null clears the service", () => {
    expect(parseVendorExpenseBody({ amountCents: 100 }, { partial: true })).toEqual({ ok: true, value: { amountCents: 100 } });
    expect(parseVendorExpenseBody({ workOrderId: null }, { partial: true })).toEqual({ ok: true, value: { workOrderId: null } });
  });

  it("rejects a note over the limit and amounts over a million dollars", () => {
    expect(parseVendorExpenseBody({ ...ok, memo: "x".repeat(501) }, { partial: false }).ok).toBe(false);
    expect(parseVendorExpenseBody({ ...ok, amountCents: 100_000_001 }, { partial: false }).ok).toBe(false);
  });

  it("parses dollar input to integer cents without floats", () => {
    expect(parseAmountToCents("38.40")).toBe(3840);
    expect(parseAmountToCents("$1,234.5")).toBe(123450);
    expect(parseAmountToCents("0.1")).toBe(10);
    expect(parseAmountToCents("0")).toBeNull();
    expect(parseAmountToCents("-5")).toBeNull();
    expect(parseAmountToCents("1.234")).toBeNull();
    expect(parseAmountToCents("abc")).toBeNull();
  });
});

describe("expense tabs", () => {
  const today = "2026-10-07";
  it("buckets by calendar month", () => {
    expect(vendorExpenseSegment("2026-10-01", today)).toBe("this-month");
    expect(vendorExpenseSegment("2026-09-30", today)).toBe("last-month");
    expect(vendorExpenseSegment("2026-08-31", today)).toBe("earlier");
    expect(vendorExpenseSegment("2025-12-15", today)).toBe("earlier");
  });

  it("last month wraps across a year boundary", () => {
    expect(vendorExpenseSegment("2025-12-20", "2026-01-05")).toBe("last-month");
    expect(vendorExpenseSegment("2025-11-20", "2026-01-05")).toBe("earlier");
  });

  it("counts every expense exactly once", () => {
    const counts = vendorExpenseSegmentCounts(
      [{ expenseDate: "2026-10-06" }, { expenseDate: "2026-10-02" }, { expenseDate: "2026-09-09" }, { expenseDate: "2026-01-01" }],
      today,
    );
    expect(counts).toEqual({ "this-month": 2, "last-month": 1, earlier: 1 });
  });

  it("exports CSV with exact dollars and quoted notes", () => {
    const expense: VendorExpense = {
      id: "e1", expenseDate: "2026-10-06", amountCents: 3805, category: "materials", memo: 'Drywall, "mud"',
      workOrderId: null, workOrderTitle: "Patch", propertyLabel: "Alder", hasReceipt: true, createdAt: "",
    };
    expect(vendorExpensesCsv([expense]).split("\n")[1]).toBe('2026-10-06,Materials,38.05,Patch,Alder,"Drywall, ""mud""",Yes');
  });
});

describe("Finances overview derivation", () => {
  const line = (over: Partial<Parameters<typeof deriveVendorOverview>[0]["ledger"][number]>) => ({
    kind: "charge", amountCents: 0, source: "invoice", sourceId: null, managerUserId: "mgr-1", createdAt: "2026-10-03T18:00:00Z", ...over,
  });

  it("earned is received net of the PropLane fee and refunds; other lines move money without earning", () => {
    expect(earnedContributionCents({ kind: "charge", amountCents: 20500, source: "invoice" })).toBe(20500);
    expect(earnedContributionCents({ kind: "platform_fee", amountCents: -500, source: "invoice" })).toBe(-500);
    expect(earnedContributionCents({ kind: "refund", amountCents: -2000, source: "refund" })).toBe(-2000);
    expect(earnedContributionCents({ kind: "withdrawal", amountCents: -9000, source: "withdrawal" })).toBe(0);
    expect(earnedContributionCents({ kind: "hold", amountCents: 100, source: "work_order" })).toBe(0);
  });

  it("builds the month strip, owed, paid-this-year and a By manager row from the vendor's rows", () => {
    const result = deriveVendorOverview({
      today: "2026-10-07",
      ledger: [
        line({ amountCents: 20500, sourceId: "inv-1" }),
        line({ kind: "platform_fee", amountCents: -500, sourceId: "inv-1" }),
        line({ amountCents: 10000, source: "work_order", sourceId: "wo-1", managerUserId: "mgr-2" }),
        line({ amountCents: 90000, sourceId: "inv-old", createdAt: "2026-03-01T18:00:00Z" }),
        line({ kind: "withdrawal", amountCents: -5000, source: "withdrawal" }),
      ],
      invoices: [
        { id: "inv-1", managerUserId: "mgr-1", status: "paid", totalCents: 20500, paidAt: "2026-10-03T18:00:00Z" },
        { id: "inv-offline", managerUserId: "mgr-1", status: "paid", totalCents: 4000, paidAt: "2026-10-05T18:00:00Z" },
        { id: "inv-open", managerUserId: "mgr-1", status: "approved", totalCents: 30000, paidAt: null },
        { id: "inv-sched", managerUserId: "mgr-2", status: "scheduled", totalCents: 7000, paidAt: null },
        { id: "inv-sub", managerUserId: "mgr-2", status: "submitted", totalCents: 999, paidAt: null },
      ],
      expenses: [
        { amountCents: 3000, expenseDate: "2026-10-02", managerUserId: "mgr-1" },
        { amountCents: 1500, expenseDate: "2026-10-04", managerUserId: null },
        { amountCents: 8000, expenseDate: "2026-09-30", managerUserId: "mgr-1" },
      ],
    });
    // 20500 - 500 + 10000 from the ledger, plus the 4000 offline invoice the ledger never saw.
    expect(result.month).toEqual({ earnedCents: 34000, spentCents: 4500, profitCents: 29500, jobs: 3 });
    expect(result.owedCents).toBe(37000);
    expect(result.paidThisYearCents).toBe(34000 + 90000);
    expect(result.ledgerBalanceCents).toBe(20500 - 500 + 10000 + 90000 - 5000);
    expect(result.byManager).toEqual([
      { managerUserId: "mgr-1", earnedCents: 24000, spentCents: 3000, profitCents: 21000 },
      { managerUserId: "mgr-2", earnedCents: 10000, spentCents: 0, profitCents: 10000 },
      { managerUserId: null, earnedCents: 0, spentCents: 1500, profitCents: -1500 },
    ]);
  });

  it("a new vendor is all zeros, not an error", () => {
    const result = deriveVendorOverview({ today: "2026-10-07", ledger: [], invoices: [], expenses: [] });
    expect(result.month).toEqual({ earnedCents: 0, spentCents: 0, profitCents: 0, jobs: 0 });
    expect(result.byManager).toEqual([]);
    expect(result.owedCents).toBe(0);
  });
});
