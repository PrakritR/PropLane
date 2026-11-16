import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { updateManualExpense } from "@/lib/reports/manual-entries.server";
import { createFinanceFakeDb } from "../helpers/finance-fake-db";
vi.mock("@/lib/analytics/posthog", () => ({ track: vi.fn() }));
vi.mock("server-only", () => ({}));

function database(owned = true) {
  const update = vi.fn().mockReturnThis();
  const eq = vi.fn().mockReturnThis();
  const query = { update, eq, select: vi.fn().mockReturnThis(), maybeSingle: vi.fn(async () => ({ data: owned ? { id: "expense", category_code: "maintenance" } : null, error: null })) };
  return { db: { from: vi.fn(() => query) } as unknown as SupabaseClient, update, eq };
}

describe("manual expense updates", () => {
  it.each([
    { amountCents: 1.5 }, { amountCents: Infinity }, { amountCents: 0 },
    { expenseDate: "2026-02-30" }, { expenseDate: "" }, { categoryCode: " " },
    { taxDeductible: "yes" }, { memo: 123 },
  ])("rejects invalid values before updating: %j", async (patch) => {
    const { db, update } = database();
    const result = await updateManualExpense(db, "manager", { id: "expense", ...patch } as Parameters<typeof updateManualExpense>[2]);
    expect(result).toMatchObject({ ok: false, status: 400 });
    expect(update).not.toHaveBeenCalled();
  });
  it.each(["propertyId", "vendorId"])("rejects a foreign %s", async (field) => {
    const { db, update, eq } = database(false);
    expect(await updateManualExpense(db, "manager", { id: "expense", [field]: "foreign" })).toMatchObject({ ok: false, status: 400 });
    expect(eq).toHaveBeenCalledWith("manager_user_id", "manager");
    expect(update).not.toHaveBeenCalled();
  });
  it("scopes the expense update to its owner and permits clearing optional associations", async () => {
    // The update now also re-derives the entry's GL journal, so this runs against the in-memory database.
    const fake = createFinanceFakeDb({
      manager_expense_entries: [
        { id: "expense", manager_user_id: "manager", category_code: "maintenance", amount_cents: 1000, expense_date: "2026-02-01", property_id: "p1", vendor_id: "v1", payment_status: "paid" },
      ],
    });
    expect(await updateManualExpense(fake as never, "someone-else", { id: "expense", amountCents: 1200 })).toMatchObject({ ok: false, status: 404 });
    expect(fake.table("manager_expense_entries")[0]).toMatchObject({ amount_cents: 1000 });
    expect(await updateManualExpense(fake as never, "manager", { id: "expense", propertyId: null, vendorId: null, amountCents: 1200, expenseDate: "2026-02-28" })).toMatchObject({ ok: true });
    expect(fake.table("manager_expense_entries")[0]).toMatchObject({ property_id: null, vendor_id: null, amount_cents: 1200, expense_date: "2026-02-28" });
    expect(fake.table("gl_journal_lines").reduce((n, l) => n + Number(l.debit_cents), 0)).toBe(1200);
  });
});
