import { NextResponse } from "next/server";
import { requireVendorApiAccess, resolveVendorPortalUserId } from "@/lib/auth/vendor-api-access";
import { pacificCalendarDateYmd } from "@/lib/pacific-time";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { readVendorBalanceSnapshot } from "@/lib/vendor-banking/balance-snapshot.server";
import { listVendorBankingLedgerEntries } from "@/lib/vendor-banking/ledger.server";
import {
  deriveVendorOverview,
  type OverviewExpense,
  type OverviewInvoice,
  type VendorFinancesOverview,
} from "@/lib/vendor-banking/overview";
import { vendorWithdrawableCents } from "@/lib/vendor-banking/finances";
import { listVendorLinkedManagers } from "@/lib/vendor-invoice-submit.server";

export const runtime = "nodejs";

/**
 * Finances > Overview. Every figure is computed here from the signed-in vendor's own rows
 * (ledger, invoices, expenses) and sent as integer cents; the client does no arithmetic.
 * When Stripe cannot answer (no key locally, an unreachable account) the balance falls back to
 * the PropLane ledger and `stripeUnavailable` says so - the page never errors because of it.
 */
export async function GET() {
  try {
    const access = await requireVendorApiAccess();
    if (!access.ok) {
      return NextResponse.json({ error: access.status === 401 ? "Unauthorized." : "Forbidden." }, { status: access.status });
    }
    const auth = await resolveVendorPortalUserId();
    if (!auth.ok) return NextResponse.json({ error: "Forbidden." }, { status: auth.status });
    const userId = auth.userId;
    const db = createSupabaseServiceRoleClient();
    const today = pacificCalendarDateYmd();

    const [ledger, invoiceRows, expenseRows, linkedManagers, stripeRead] = await Promise.all([
      listVendorBankingLedgerEntries(db, userId),
      db
        .from("vendor_invoices")
        .select("id, manager_user_id, status, total_cents, paid_at")
        .eq("vendor_user_id", userId),
      db
        .from("vendor_expense_entries")
        .select("amount_cents, expense_date, work_order_id")
        .eq("vendor_user_id", userId),
      listVendorLinkedManagers(db, userId).catch(() => []),
      readVendorBalanceSnapshot(db, userId).then(
        (snapshot) => ({ ok: true as const, snapshot }),
        () => ({ ok: false as const }),
      ),
    ]);
    if (invoiceRows.error) return NextResponse.json({ error: invoiceRows.error.message }, { status: 500 });
    if (expenseRows.error) return NextResponse.json({ error: expenseRows.error.message }, { status: 500 });

    // An expense belongs to a manager through the service it is tied to (the vendor's own services only).
    const workOrderIds = [...new Set((expenseRows.data ?? []).map((row) => String(row.work_order_id ?? "")).filter(Boolean))];
    const managerByWorkOrder = new Map<string, string>();
    if (workOrderIds.length > 0) {
      const { data } = await db
        .from("portal_work_order_records")
        .select("id, manager_user_id")
        .in("id", workOrderIds)
        .eq("vendor_user_id", userId);
      for (const row of data ?? []) {
        if (row.manager_user_id) managerByWorkOrder.set(String(row.id), String(row.manager_user_id));
      }
    }

    const invoices: OverviewInvoice[] = (invoiceRows.data ?? []).map((row) => ({
      id: String(row.id),
      managerUserId: (row.manager_user_id as string | null) ?? null,
      status: String(row.status ?? ""),
      totalCents: Number(row.total_cents ?? 0),
      paidAt: (row.paid_at as string | null) ?? null,
    }));
    const expenses: OverviewExpense[] = (expenseRows.data ?? []).map((row) => ({
      amountCents: Number(row.amount_cents ?? 0),
      expenseDate: String(row.expense_date ?? "").slice(0, 10),
      managerUserId: managerByWorkOrder.get(String(row.work_order_id ?? "")) ?? null,
    }));

    const figures = deriveVendorOverview({
      ledger: ledger.map((entry) => ({
        kind: entry.kind,
        amountCents: entry.amountCents,
        source: entry.source,
        sourceId: entry.sourceId,
        managerUserId: entry.managerUserId,
        createdAt: entry.createdAt,
      })),
      invoices,
      expenses,
      today,
    });

    // Names: the vendor's linked-manager labels first, then profile names for any other payer.
    const labels = new Map(linkedManagers.map((manager) => [manager.managerUserId, manager.label]));
    const missing = figures.byManager.map((row) => row.managerUserId).filter((id): id is string => Boolean(id) && !labels.has(id as string));
    if (missing.length > 0) {
      const { data } = await db.from("profiles").select("id, full_name").in("id", missing);
      for (const profile of data ?? []) {
        const name = typeof profile.full_name === "string" ? profile.full_name.trim() : "";
        if (name) labels.set(String(profile.id), name);
      }
    }

    const stripeUnavailable = !stripeRead.ok;
    const balance: VendorFinancesOverview["balance"] = stripeRead.ok
      ? {
          source: "stripe",
          availableCents: vendorWithdrawableCents(stripeRead.snapshot),
          pendingCents: Math.max(0, stripeRead.snapshot.pendingCents),
          owedCents: figures.owedCents,
          paidThisYearCents: figures.paidThisYearCents,
          currency: stripeRead.snapshot.currency || "usd",
        }
      : {
          source: "ledger",
          availableCents: Math.max(0, figures.ledgerBalanceCents),
          pendingCents: null,
          owedCents: figures.owedCents,
          paidThisYearCents: figures.paidThisYearCents,
          currency: "usd",
        };

    const body: VendorFinancesOverview = {
      balance,
      stripeUnavailable,
      month: { ...figures.month, monthKey: figures.monthKey },
      byManager: figures.byManager.map((row) => ({
        ...row,
        label: row.managerUserId ? (labels.get(row.managerUserId) ?? "Manager") : "Not tied to a manager",
      })),
    };
    return NextResponse.json(body);
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Could not load your finances." }, { status: 500 });
  }
}
