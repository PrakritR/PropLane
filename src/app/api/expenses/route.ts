import { NextResponse } from "next/server";
import { assertManagerFinancialsAccess, getReportsAuthContext } from "@/lib/reports/auth";
import {
  chartAccountLabel,
  isCategoryDeductible,
  resolveExpenseTaxDeductible,
  SYSTEM_CHART_ACCOUNTS,
} from "@/lib/reports/categories";
import { recordManualExpense, updateManualExpense } from "@/lib/reports/manual-entries.server";
import {
  applyWorkspaceRowScope,
  resolveActiveWorkspaceRowScope,
  rowAllowedInWorkspaceScope,
} from "@/lib/workspaces/row-scope.server";

export const runtime = "nodejs";

export async function GET() {
  try {
    const auth = await getReportsAuthContext();
    if (!auth) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
    const gate = await assertManagerFinancialsAccess(auth);
    if (!gate.ok) return NextResponse.json({ error: gate.error }, { status: gate.status });

    const categories = SYSTEM_CHART_ACCOUNTS.filter((a) => a.accountType === "expense").map((a) => ({
      code: a.code,
      name: a.name,
      deductible: isCategoryDeductible(a.code),
    }));

    const scope = await resolveActiveWorkspaceRowScope(auth.db, auth.userId);
    const { data, error } = await applyWorkspaceRowScope(
      auth.db
        .from("manager_expense_entries")
        .select("*")
        .eq("manager_user_id", auth.userId)
        .order("expense_date", { ascending: false })
        .limit(500),
      scope,
    );

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    return NextResponse.json({
      categories,
      expenses: (data ?? []).map((e) => ({
        id: e.id,
        propertyId: e.property_id,
        categoryCode: e.category_code,
        categoryLabel: chartAccountLabel(e.category_code),
        amountCents: Number(e.amount_cents),
        expenseDate: e.expense_date,
        memo: e.memo,
        vendorId: e.vendor_id,
        sourceWorkOrderId: e.source_work_order_id ? String(e.source_work_order_id) : undefined,
        taxDeductible: resolveExpenseTaxDeductible(e.category_code, e.tax_deductible),
      })),
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Failed to load expenses.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    const auth = await getReportsAuthContext();
    if (!auth) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
    const gate = await assertManagerFinancialsAccess(auth);
    if (!gate.ok) return NextResponse.json({ error: gate.error }, { status: gate.status });

    const body = (await req.json()) as {
      propertyId?: string;
      categoryCode?: string;
      amountCents?: number;
      expenseDate?: string;
      memo?: string;
      vendorId?: string;
      taxDeductible?: boolean;
    };

    // An expense tied to a house must land in the manager's active workspace.
    // An account-level expense (no house, e.g. a portfolio software fee) has
    // no workspace to land in — it is scoped on read by the default-workspace
    // rule instead.
    if (body.propertyId) {
      const scope = await resolveActiveWorkspaceRowScope(auth.db, auth.userId);
      if (scope.propertyIds !== null && !scope.propertyIds.includes(body.propertyId)) {
        return NextResponse.json({ error: "This property is outside your active workspace." }, { status: 400 });
      }
    }

    const result = await recordManualExpense(auth.db, auth.userId, body);
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json({ expense: result.entry });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Failed to create expense.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function PATCH(req: Request) {
  try {
    const auth = await getReportsAuthContext();
    if (!auth) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
    const gate = await assertManagerFinancialsAccess(auth);
    if (!gate.ok) return NextResponse.json({ error: gate.error }, { status: gate.status });

    const body = (await req.json()) as {
      id?: string;
      taxDeductible?: boolean;
      categoryCode?: string;
      amountCents?: number;
      expenseDate?: string;
      memo?: string | null;
      vendorId?: string | null;
      propertyId?: string | null;
    };
    const id = typeof body?.id === "string" ? body.id.trim() : "";
    if (!id) return NextResponse.json({ error: "id required." }, { status: 400 });

    // An update must refuse a row outside the active workspace — whether the
    // expense is already there, or the patch would move it there. Same
    // "not found" shape as a missing id: the workspace boundary never leaks
    // which expenses exist elsewhere.
    const scope = await resolveActiveWorkspaceRowScope(auth.db, auth.userId);
    if (scope.propertyIds !== null) {
      const { data: existing, error: existingError } = await auth.db
        .from("manager_expense_entries")
        .select("property_id")
        .eq("id", id)
        .eq("manager_user_id", auth.userId)
        .maybeSingle();
      if (existingError) return NextResponse.json({ error: existingError.message }, { status: 500 });
      if (!existing || !rowAllowedInWorkspaceScope(scope, existing.property_id)) {
        return NextResponse.json({ error: "Expense not found." }, { status: 404 });
      }
      if (body.propertyId !== undefined && !rowAllowedInWorkspaceScope(scope, body.propertyId)) {
        return NextResponse.json({ error: "This property is outside your active workspace." }, { status: 400 });
      }
    }

    const result = await updateManualExpense(auth.db, auth.userId, { ...body, id });
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json({ expense: result.entry });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Failed to update expense.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function DELETE(req: Request) {
  try {
    const auth = await getReportsAuthContext();
    if (!auth) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
    const gate = await assertManagerFinancialsAccess(auth);
    if (!gate.ok) return NextResponse.json({ error: gate.error }, { status: gate.status });

    const { searchParams } = new URL(req.url);
    const id = searchParams.get("id")?.trim();
    if (!id) return NextResponse.json({ error: "id required." }, { status: 400 });

    // A delete must refuse a row outside the active workspace, same as an
    // update: fold the scope directly into the delete's own predicate so a
    // row it does not match is left untouched rather than removed.
    const scope = await resolveActiveWorkspaceRowScope(auth.db, auth.userId);
    const { data, error } = await applyWorkspaceRowScope(
      auth.db.from("manager_expense_entries").delete().eq("id", id).eq("manager_user_id", auth.userId).select("id"),
      scope,
    );

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    if (!data || data.length === 0) return NextResponse.json({ error: "Expense not found." }, { status: 404 });
    return NextResponse.json({ ok: true });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Failed to delete expense.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
