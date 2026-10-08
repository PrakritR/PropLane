import { NextResponse } from "next/server";
import { resolveVendorPortalUserId } from "@/lib/auth/vendor-api-access";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { parseVendorExpenseBody } from "@/lib/vendor-expenses";
import {
  VENDOR_EXPENSE_SELECT,
  findOwnService,
  loadServiceLabels,
  mapExpenseRow,
} from "@/lib/vendor-expenses.server";
import { VENDOR_DOCUMENTS_BUCKET, isVendorDocumentStoragePath } from "@/lib/vendor-documents-storage";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string }> };

async function requireVendor() {
  const auth = await resolveVendorPortalUserId();
  if (!auth.ok) {
    return { ok: false as const, status: auth.status, error: auth.status === 401 ? "Unauthorized." : "Forbidden." };
  }
  return { ok: true as const, userId: auth.userId, db: createSupabaseServiceRoleClient() };
}

/**
 * Edit an expense. Ownership is re-derived in the write itself (`vendor_user_id` = the session
 * user): another vendor's id matches no row and reads as 404, never 403. The owner column is
 * never part of the patch.
 */
export async function PATCH(req: Request, ctx: Ctx) {
  try {
    const { id } = await ctx.params;
    const gate = await requireVendor();
    if (!gate.ok) return NextResponse.json({ error: gate.error }, { status: gate.status });

    const parsed = parseVendorExpenseBody(await req.json().catch(() => null), { partial: true });
    if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });
    const input = parsed.value;

    if (input.workOrderId) {
      const service = await findOwnService(gate.db, gate.userId, input.workOrderId);
      if (!service) return NextResponse.json({ error: "Choose one of your own services." }, { status: 400 });
    }

    const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if (input.expenseDate !== undefined) patch.expense_date = input.expenseDate;
    if (input.amountCents !== undefined) patch.amount_cents = input.amountCents;
    if (input.category !== undefined) patch.category = input.category;
    if (input.memo !== undefined) patch.memo = input.memo;
    if (input.workOrderId !== undefined) patch.work_order_id = input.workOrderId;

    const { data, error } = await gate.db
      .from("vendor_expense_entries")
      .update(patch)
      .eq("id", id)
      .eq("vendor_user_id", gate.userId)
      .select(VENDOR_EXPENSE_SELECT)
      .maybeSingle();
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    if (!data) return NextResponse.json({ error: "Expense not found." }, { status: 404 });

    const row = data as Record<string, unknown>;
    const labels = await loadServiceLabels(gate.db, gate.userId, [String(row.work_order_id ?? "")]);
    return NextResponse.json({ expense: mapExpenseRow(row, labels) });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Could not save the expense." }, { status: 500 });
  }
}

/** Delete an expense and its receipt file. Another vendor's id is a 404. */
export async function DELETE(_req: Request, ctx: Ctx) {
  try {
    const { id } = await ctx.params;
    const gate = await requireVendor();
    if (!gate.ok) return NextResponse.json({ error: gate.error }, { status: gate.status });

    const { data, error } = await gate.db
      .from("vendor_expense_entries")
      .delete()
      .eq("id", id)
      .eq("vendor_user_id", gate.userId)
      .select("id, receipt_path")
      .maybeSingle();
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    if (!data) return NextResponse.json({ error: "Expense not found." }, { status: 404 });

    const receiptPath = typeof data.receipt_path === "string" ? data.receipt_path : "";
    if (receiptPath && isVendorDocumentStoragePath(receiptPath, gate.userId)) {
      // Best effort: the row is already gone, an orphaned private file is swept with the account.
      await gate.db.storage.from(VENDOR_DOCUMENTS_BUCKET).remove([receiptPath]).catch(() => undefined);
    }
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Could not delete the expense." }, { status: 500 });
  }
}
