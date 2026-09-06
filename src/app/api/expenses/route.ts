import { NextResponse } from "next/server";
import { assertManagerFinancialsAccess, getReportsAuthContext } from "@/lib/reports/auth";
import {
  chartAccountLabel,
  isCategoryDeductible,
  resolveExpenseTaxDeductible,
  SYSTEM_CHART_ACCOUNTS,
} from "@/lib/reports/categories";
import { recordManualExpense, updateManualExpense } from "@/lib/reports/manual-entries.server";

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

    const { data, error } = await auth.db
      .from("manager_expense_entries")
      .select("*")
      .eq("manager_user_id", auth.userId)
      .order("expense_date", { ascending: false })
      .limit(500);

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

    const { error } = await auth.db
      .from("manager_expense_entries")
      .delete()
      .eq("id", id)
      .eq("manager_user_id", auth.userId);

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ ok: true });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Failed to delete expense.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
