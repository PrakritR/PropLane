import type { SupabaseClient } from "@supabase/supabase-js";
import { orFilterForIdentity } from "@/lib/supabase/or-filter";
import type { HouseholdCharge } from "@/lib/household-charges";
import { householdChargeDueDate } from "@/lib/household-charges";
import { centsToUsd } from "@/lib/reports/money";
import type { ReportResult } from "@/lib/reports/types";
import { householdChargeAmountCents } from "@/lib/stripe-household-charge";

/**
 * The shape returned when the caller carries no resident identity: a real,
 * zeroed summary rather than an unscoped query. Same columns as the live path,
 * so the assistant renders it normally instead of erroring.
 */
function emptyResidentBalanceSummary(): ReportResult {
  return {
    id: "resident-balance-summary",
    title: "Balance summary",
    columns: [
      { key: "label", label: "Item" },
      { key: "value", label: "Amount", align: "right" },
    ],
    rows: [
      { label: "Balance due", value: centsToUsd(0) },
      { label: "Open charges", value: "0" },
      { label: "Paid to date", value: centsToUsd(0) },
      { label: "Next charge", value: "None scheduled" },
      { label: "Last payment", value: "No payments recorded" },
    ],
    meta: { balanceCents: 0, openCharges: 0, paidCents: 0 },
  };
}

/**
 * Resident balance summary for the resident agent tool — not a manager report.
 * The orphaned `resident-balance` report id was removed from the reports API;
 * this keeps the assistant balance read aligned with pending household charges.
 */
export async function queryResidentBalance(
  db: SupabaseClient,
  residentUserId: string,
  residentEmail: string,
  managerUserId?: string,
): Promise<ReportResult> {
  // No identity means no rows. The interpolated form used to emit
  // `resident_user_id.eq.,resident_email.eq.` here, which is malformed rather
  // than restrictive — and this filter is a tenant boundary.
  const scope = orFilterForIdentity([
    ["resident_user_id", residentUserId],
    ["resident_email", residentEmail],
  ]);
  if (!scope) return emptyResidentBalanceSummary();
  let chargeQuery = db
    .from("portal_household_charge_records")
    .select("row_data")
    .or(scope);
  let ledgerQuery = db
    .from("ledger_entries")
    .select("entry_type, amount_cents, posted_date")
    .or(scope);
  if (managerUserId) {
    chargeQuery = chargeQuery.eq("manager_user_id", managerUserId);
    ledgerQuery = ledgerQuery.eq("manager_user_id", managerUserId);
  }
  const [{ data: chargeRows }, { data: ledgerRows }] = await Promise.all([
    chargeQuery,
    ledgerQuery.order("posted_date", { ascending: true }),
  ]);

  const charges = ((chargeRows ?? []) as { row_data: unknown }[]).map((r) => r.row_data as HouseholdCharge);
  const outstanding = charges.filter((c) => String(c.status ?? "") === "pending");
  const balanceCents = outstanding.reduce((sum, c) => sum + householdChargeAmountCents(c), 0);
  const paidCents = charges
    .filter((c) => String(c.status ?? "") === "paid")
    .reduce((sum, c) => sum + householdChargeAmountCents(c), 0);

  const next = outstanding
    .map((c) => ({ charge: c, due: householdChargeDueDate(c) }))
    .filter((c): c is { charge: HouseholdCharge; due: Date } => c.due !== null)
    .sort((a, b) => a.due.getTime() - b.due.getTime())[0];
  const nextDueLabel = next ? next.charge.dueDateLabel || next.due.toISOString().slice(0, 10) : "";

  const lastPayment = (
    (ledgerRows ?? []) as {
      entry_type: string;
      amount_cents: number | string | null;
      posted_date: string | null;
    }[]
  )
    .filter((e) => e.entry_type === "payment")
    .at(-1);

  const rows = [
    { label: "Balance due", value: centsToUsd(balanceCents) },
    { label: "Open charges", value: String(outstanding.length) },
    { label: "Paid to date", value: centsToUsd(paidCents) },
    {
      label: "Next charge",
      value: next
        ? `${next.charge.title || next.charge.kind || "Charge"} — ${next.charge.balanceLabel || next.charge.amountLabel || "—"} due ${nextDueLabel}`
        : "None scheduled",
    },
    {
      label: "Last payment",
      value: lastPayment
        ? `${centsToUsd(Number(lastPayment.amount_cents ?? 0))} on ${lastPayment.posted_date ?? "—"}`
        : "No payments recorded",
    },
  ];

  return {
    id: "resident-balance-summary",
    title: "Balance summary",
    columns: [
      { key: "label", label: "Item" },
      { key: "value", label: "Amount", align: "right" },
    ],
    rows,
    meta: { balanceCents, openCharges: outstanding.length, paidCents },
  };
}
