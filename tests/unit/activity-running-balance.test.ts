import { describe, expect, it, vi } from "vitest";
import type { ReportRow } from "@/lib/reports/types";
vi.mock("server-only", () => ({}));
vi.mock("@/lib/test-workspaces/index.server", () => ({}));
vi.mock("@/lib/stripe", () => ({}));
import { annotateRunningBalances } from "@/lib/reports/activity-running-balance.server";
describe("provider-derived running balances", () => {
  it("walks every provider delta while annotating only exact known references", () => {
    const rows: ReportRow[] = [{ id: "receipt", balanceReferences: "ch_receipt|resident-payment:session" }, { id: "offline", amountCents: 90000 }, { id: "vendor", balanceReferences: "vendor-invoice:invoice:out" }];
    annotateRunningBalances(rows, [
      { id: "1", at: "2026-09-01", cents: 10000, reference: "ch_receipt" },
      { id: "2", at: "2026-09-02", cents: -500, reference: "bank_fee_not_in_rows" },
      { id: "3", at: "2026-09-03", cents: -2000, reference: "vendor-invoice:invoice:out" },
    ], 12500);
    expect(rows[0].runningBalanceCents).toBe(15000);
    expect(rows[1].runningBalanceCents).toBeUndefined();
    expect(rows[2].runningBalanceCents).toBe(12500);
  });
  it("does not repeat a checkout balance on each of its accounting lines", () => {
    const rows: ReportRow[] = [{ balanceReferences: "ch_1" }, { balanceReferences: "ch_1" }];
    annotateRunningBalances(rows, [{ id: "1", at: "2026-09-01", cents: 100, reference: "ch_1" }], 100);
    expect(rows.map(row => row.runningBalanceCents)).toEqual([undefined, 100]);
  });
  it("rejects fractional or overflowing cents", () => {
    expect(() => annotateRunningBalances([], [], 0.1)).toThrow();
    expect(() => annotateRunningBalances([], [{ id: "1", at: "2026", cents: -1, reference: null }], Number.MAX_SAFE_INTEGER)).toThrow();
  });
});
