import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { updateManualExpense } from "@/lib/reports/manual-entries.server";
vi.mock("@/lib/analytics/posthog", () => ({ track: vi.fn() }));

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
  it("scopes the expense update and permits clearing optional associations", async () => {
    const { db, update, eq } = database();
    expect(await updateManualExpense(db, "manager", { id: "expense", propertyId: null, vendorId: null, amountCents: 1200, expenseDate: "2026-02-28" })).toMatchObject({ ok: true });
    expect(update).toHaveBeenCalledWith(expect.objectContaining({ property_id: null, vendor_id: null, amount_cents: 1200, expense_date: "2026-02-28" }));
    expect(eq).toHaveBeenCalledWith("manager_user_id", "manager");
    expect(eq).toHaveBeenCalledWith("id", "expense");
  });
});
