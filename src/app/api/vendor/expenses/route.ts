import { NextResponse } from "next/server";
import { resolveVendorPortalUserId } from "@/lib/auth/vendor-api-access";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { parseVendorExpenseBody } from "@/lib/vendor-expenses";
import {
  VENDOR_EXPENSE_SELECT,
  findOwnService,
  listVendorExpenses,
  loadServiceLabels,
  mapExpenseRow,
} from "@/lib/vendor-expenses.server";

export const runtime = "nodejs";

/**
 * Outgoing payments (vendor-portal-ia-1007): the signed-in vendor's own expense log. Private —
 * managers never read these rows. `vendor_expense_entries` is SELECT-only for clients, so every
 * write goes through here with the service-role client pinned to the session's user id. A
 * `vendor_user_id` in the body is ignored; the owner is always the signed-in vendor.
 */
async function requireVendor() {
  const auth = await resolveVendorPortalUserId();
  if (!auth.ok) {
    return { ok: false as const, status: auth.status, error: auth.status === 401 ? "Unauthorized." : "Forbidden." };
  }
  return { ok: true as const, userId: auth.userId, db: createSupabaseServiceRoleClient() };
}

export async function GET() {
  try {
    const gate = await requireVendor();
    if (!gate.ok) return NextResponse.json({ error: gate.error }, { status: gate.status });
    const result = await listVendorExpenses(gate.db, gate.userId);
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: 500 });
    return NextResponse.json({ expenses: result.expenses });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Could not load expenses." }, { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    const gate = await requireVendor();
    if (!gate.ok) return NextResponse.json({ error: gate.error }, { status: gate.status });

    const parsed = parseVendorExpenseBody(await req.json().catch(() => null), { partial: false });
    if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });
    const input = parsed.value;

    if (input.workOrderId) {
      // The service must be assigned to this vendor, or the request is refused outright.
      const service = await findOwnService(gate.db, gate.userId, input.workOrderId);
      if (!service) return NextResponse.json({ error: "Choose one of your own services." }, { status: 400 });
    }

    const { data, error } = await gate.db
      .from("vendor_expense_entries")
      .insert({
        vendor_user_id: gate.userId,
        expense_date: input.expenseDate,
        amount_cents: input.amountCents,
        category: input.category,
        memo: input.memo ?? null,
        work_order_id: input.workOrderId ?? null,
      })
      .select(VENDOR_EXPENSE_SELECT)
      .single();
    if (error || !data) {
      return NextResponse.json({ error: error?.message ?? "Could not save the expense." }, { status: 500 });
    }

    const row = data as Record<string, unknown>;
    const labels = await loadServiceLabels(gate.db, gate.userId, [String(row.work_order_id ?? "")]);
    return NextResponse.json({ expense: mapExpenseRow(row, labels) }, { status: 201 });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Could not save the expense." }, { status: 500 });
  }
}
