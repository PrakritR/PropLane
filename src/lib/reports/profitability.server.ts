import type { SupabaseClient } from "@supabase/supabase-js";
import { track } from "@/lib/analytics/posthog";
import { includedAllowanceCents, normalizeCommsPlanTier } from "@/lib/comms-billing/allowances";
import { getEffectiveManagerSkuTier } from "@/lib/manager-access-server";
import { primeSystemChartOfAccounts } from "@/lib/reports/chart-of-accounts-store";
import { loadManagerReportDisplayContext } from "@/lib/reports/display-context";
import {
  buildProfitabilityReport,
  type ProfitabilityCommsAllowance,
  type ProfitabilityGroupBy,
  type ProfitabilityVendorPayout,
} from "@/lib/reports/profitability";
import type { ManagerReportFilters, ReportResult } from "@/lib/reports/types";

/**
 * Profitability report (PRP-278): the reads.
 *
 * One row source per column, each a table the product already writes —
 * nothing here is computed from a rate card or backfilled at read time:
 *
 *   gross rent / other income / processing fees  ledger_entries (entry_type payment)
 *   vendor payouts                               vendor_payouts (status paid) → work order property
 *   communication                                manager_comms_usage_events above the plan allowance
 *   expenses                                     manager_expense_entries
 *
 * Bounded reads (`.limit`) for the same egress reason as every other report;
 * a read error throws rather than reporting a category as 0.
 */

const ROW_LIMIT = 5000;

function defaultDateRange(from?: string, to?: string): { from: string; to: string } {
  const now = new Date();
  const toDate = to?.trim() || now.toISOString().slice(0, 10);
  const fromDate = from?.trim() || new Date(now.getFullYear(), 0, 1).toISOString().slice(0, 10);
  return { from: fromDate, to: toDate };
}

async function loadCommsAllowance(managerUserId: string): Promise<ProfitabilityCommsAllowance> {
  const tier = await getEffectiveManagerSkuTier(managerUserId);
  if (!tier.ok) return { readable: false };
  return { readable: true, cents: includedAllowanceCents(normalizeCommsPlanTier(tier.tier)) };
}

async function loadPaidVendorPayouts(
  db: SupabaseClient,
  managerUserId: string,
  range: { from: string; to: string },
  propertyId: string | undefined,
): Promise<ProfitabilityVendorPayout[]> {
  const { data, error } = await db
    .from("vendor_payouts")
    .select("work_order_id, amount_cents, updated_at, created_at")
    .eq("manager_user_id", managerUserId)
    .eq("status", "paid")
    .gte("updated_at", `${range.from}T00:00:00.000Z`)
    .lte("updated_at", `${range.to}T23:59:59.999Z`)
    .order("updated_at", { ascending: false })
    .limit(ROW_LIMIT);
  if (error) throw new Error(error.message);
  const payouts = data ?? [];
  if (payouts.length === 0) return [];

  const workOrderIds = [...new Set(payouts.map((row) => String(row.work_order_id ?? "").trim()).filter(Boolean))];
  const propertyByWorkOrder = new Map<string, string | null>();
  for (let offset = 0; offset < workOrderIds.length; offset += 200) {
    const chunk = workOrderIds.slice(offset, offset + 200);
    const { data: orders, error: orderError } = await db
      .from("portal_work_order_records")
      .select("id, property_id, assigned_property_id")
      .in("id", chunk);
    if (orderError) throw new Error(orderError.message);
    for (const order of orders ?? []) {
      const id = String(order.id ?? "");
      const property =
        String(order.property_id ?? "").trim() || String(order.assigned_property_id ?? "").trim() || null;
      propertyByWorkOrder.set(id, property);
    }
  }

  return payouts
    .map((row) => ({
      propertyId: propertyByWorkOrder.get(String(row.work_order_id ?? "").trim()) ?? null,
      paidAt: String(row.updated_at ?? row.created_at ?? ""),
      amountCents: Number(row.amount_cents) || 0,
    }))
    .filter((row) => (propertyId ? row.propertyId === propertyId : true));
}

export function parseProfitabilityGroupBy(raw: string | null | undefined): ProfitabilityGroupBy {
  return raw?.trim() === "month" ? "month" : "property";
}

export async function queryProfitability(
  db: SupabaseClient,
  managerUserId: string,
  filters: ManagerReportFilters,
): Promise<ReportResult> {
  await primeSystemChartOfAccounts(db);
  const range = defaultDateRange(filters.from, filters.to);
  const propertyId = filters.propertyId?.trim() || undefined;
  const groupBy = parseProfitabilityGroupBy(filters.groupBy);

  let ledgerQuery = db
    .from("ledger_entries")
    .select("property_id, posted_date, category_code, amount_cents, stripe_fee_cents, net_cents")
    .eq("manager_user_id", managerUserId)
    .eq("entry_type", "payment")
    .gte("posted_date", range.from)
    .lte("posted_date", range.to)
    .limit(ROW_LIMIT);
  if (propertyId) ledgerQuery = ledgerQuery.eq("property_id", propertyId);

  let expenseQuery = db
    .from("manager_expense_entries")
    .select("property_id, expense_date, amount_cents")
    .eq("manager_user_id", managerUserId)
    .gte("expense_date", range.from)
    .lte("expense_date", range.to)
    .limit(ROW_LIMIT);
  if (propertyId) expenseQuery = expenseQuery.eq("property_id", propertyId);

  const commsQuery = db
    .from("manager_comms_usage_events")
    .select("created_at, total_cents")
    .eq("manager_user_id", managerUserId)
    .gte("created_at", `${range.from.slice(0, 7)}-01T00:00:00.000Z`)
    .lte("created_at", `${range.to}T23:59:59.999Z`)
    .limit(ROW_LIMIT);

  const [display, ledger, expenses, comms, vendorPayouts, commsAllowance] = await Promise.all([
    loadManagerReportDisplayContext(db, managerUserId),
    ledgerQuery,
    expenseQuery,
    commsQuery,
    loadPaidVendorPayouts(db, managerUserId, range, propertyId),
    loadCommsAllowance(managerUserId),
  ]);
  if (ledger.error) throw new Error(ledger.error.message);
  if (expenses.error) throw new Error(expenses.error.message);
  if (comms.error) throw new Error(comms.error.message);

  const built = buildProfitabilityReport({
    from: range.from,
    to: range.to,
    groupBy,
    ledgerPayments: (ledger.data ?? []).map((row) => ({
      propertyId: row.property_id ? String(row.property_id) : null,
      postedDate: String(row.posted_date ?? ""),
      categoryCode: String(row.category_code ?? ""),
      amountCents: Number(row.amount_cents) || 0,
      stripeFeeCents: row.stripe_fee_cents == null ? null : Number(row.stripe_fee_cents),
      netCents: row.net_cents == null ? null : Number(row.net_cents),
    })),
    expenses: (expenses.data ?? []).map((row) => ({
      propertyId: row.property_id ? String(row.property_id) : null,
      expenseDate: String(row.expense_date ?? ""),
      amountCents: Number(row.amount_cents) || 0,
    })),
    vendorPayouts,
    commsUsage: (comms.data ?? []).map((row) => ({
      createdAt: String(row.created_at ?? ""),
      totalCents: Number(row.total_cents) || 0,
    })),
    commsAllowance,
    propertyFilterActive: Boolean(propertyId),
    propertyLabel: (id) => display.propertyLabel(id),
  });

  // Server-confirmed outcome, next to the successful read: ids and counts only.
  track("profitability_report_viewed", managerUserId, {
    months: built.months.length,
    propertyCount: built.propertyCount,
  });

  return built.report;
}
