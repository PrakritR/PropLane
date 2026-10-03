import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
vi.mock("server-only", () => ({}));
vi.mock("@/lib/manager-stripe-customer.server", () => ({ loadManagerBillingIdentity: vi.fn(async () => ({ customerId: "cus_owner" })) }));
vi.mock("@/lib/test-workspaces/index.server", () => ({ resolveTestWorkspaceClassification: vi.fn(async () => ({ kind: "normal" })) }));
vi.mock("@/lib/stripe", () => ({ getStripe: () => ({ invoices: { list: async function* () {
  yield { id: "in_1", amount_paid: 1900, currency: "usd", status_transitions: { paid_at: 1788393600 }, parent: { subscription_details: {} } };
  yield { id: "in_non_plan", amount_paid: 500, currency: "usd", status_transitions: { paid_at: 1788393600 }, parent: null };
} } }) }));
import { accountMovement, loadAccountFinancialActivity } from "@/lib/reports/account-financial-activity.server";
import { summarizeFinancialActivity } from "@/lib/reports/financial-activity-totals";
function database() {
  const tables: Record<string, Record<string, unknown>[]> = {
    manager_comms_credit_purchases: [{ id: "credit", credit_cents: 500, status: "paid", paid_at: "2026-09-03" }],
    manager_comms_credit_adjustments: [{ id: "purchase", amount_cents: 500, reason: "purchase", created_at: "2026-09-03" }, { id: "refund", amount_cents: -100, reason: "refund", created_at: "2026-09-04" }],
    stripe_payouts: [{ id: "payout", stripe_payout_id: "po_1", amount_cents: 10000, fee_cents: 100, initiated_in_app: true, status: "paid", created_at: "2026-09-04", destination_last4: "1234" }],
  };
  const scopes: string[][] = [];
  return { scopes, db: { from: (table: string) => {
    const query = { select: () => query, eq: (key: string, value: string) => { scopes.push([table, key, value]); return query; }, in: () => query, order: () => query, range: async (start: number, end: number) => ({ data: (tables[table] ?? []).slice(start, end + 1), error: null }) };
    return query;
  } } as unknown as SupabaseClient };
}
describe("owner account cash movements", () => {
  it("counts each purchase once, credits reversals, excludes transfer principal from profit", async () => {
    const { db, scopes } = database();
    const rows = await loadAccountFinancialActivity(db, "owner", { from: "2026-09-01", to: "2026-09-30" });
    expect(rows).toHaveLength(5);
    expect(rows.find(row => row.id === "payout-payout")?.amountCents).toBe(-9900);
    expect(summarizeFinancialActivity(rows).months["2026-09"].expenseCents).toBe(2400);
    expect(rows.every(row => row.propertyId === null)).toBe(true);
    expect(scopes.filter(([, key]) => key.endsWith("user_id")).every(([, , value]) => value === "owner")).toBe(true);
  });
  it("applies dates consistently across independent sources", async () => {
    expect(await loadAccountFinancialActivity(database().db, "owner", { from: "2027-01-01", to: "2027-02-01" })).toEqual([]);
  });
  it("rejects nonintegral and unsafe provider amounts", () => {
    const row = { id: "a", date: "2026-09-03", description: "Plan", category: "plan", accountType: "expense", source: "Card" };
    expect(() => accountMovement({ ...row, amountCents: 0.5 })).toThrow();
    expect(() => accountMovement({ ...row, amountCents: Number.MAX_SAFE_INTEGER + 1 })).toThrow();
  });
});
