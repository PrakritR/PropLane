import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { loadManagerBillingIdentity } from "@/lib/manager-stripe-customer.server";
import { resolveTestWorkspaceClassification } from "@/lib/test-workspaces/index.server";
import { proplaneBalanceEnabled } from "@/lib/proplane-balance/flag";
import { getStripe } from "@/lib/stripe";
import type { ReportRow } from "./types";

type Range = { from: string; to: string };
export function accountMovement(input: { id: string; date: string; amountCents: number; description: string; category: string; accountType: string; source: string }): ReportRow {
  if (!Number.isSafeInteger(input.amountCents)) throw new Error("Invalid account movement amount.");
  return { ...input, amount: input.amountCents / 100, categoryCode: input.category, property: "Account · all workspaces", propertyId: null, who: input.category === "withdrawal" ? "Bank" : "PropLane", entryType: input.amountCents < 0 ? "expense" : "refund" };
}

/** Account billing is not property income. Call only after owner authorization. */
export async function loadAccountFinancialActivity(db: SupabaseClient, owner: string, range: Range): Promise<ReportRow[]> {
  const rows: ReportRow[] = [];
  const inRange = (date: string) => date.slice(0, 10) >= range.from && date.slice(0, 10) <= range.to;
  for (const [table, ownerColumn] of [["manager_comms_credit_purchases", "manager_user_id"], ["comms_pool_credit_purchases", "funder_user_id"]]) {
    for (let offset = 0; ; offset += 500) {
      const { data, error } = await db.from(table).select("id, credit_cents, status, paid_at").eq(ownerColumn, owner).in("status", ["paid", "reversed"]).order("id").range(offset, offset + 499);
      if (error) throw new Error(error.message);
      for (const row of data ?? []) {
        if (!row.paid_at || !inRange(row.paid_at)) continue;
        rows.push(accountMovement({ id: `${table}-${row.id}`, date: row.paid_at, amountCents: -Number(row.credit_cents), description: "Communication credit", category: "communication_credit", accountType: "expense", source: "Card" }));
      }
      if (!data || data.length < 500) break;
    }
  }
  for (const [table, ownerColumn] of [["manager_comms_credit_adjustments", "manager_user_id"], ["comms_pool_credit_adjustments", "funder_user_id"]]) {
    for (let offset = 0; ; offset += 500) {
      const { data, error } = await db.from(table).select("id, amount_cents, reason, created_at").eq(ownerColumn, owner).order("id").range(offset, offset + 499);
      if (error) throw new Error(error.message);
      for (const row of data ?? []) {
        if (!inRange(row.created_at) || Number(row.amount_cents) >= 0) continue;
        // Negative credit adjustments are reversals; purchase credits are already listed above.
        rows.push(accountMovement({ id: `${table}-${row.id}`, date: row.created_at, amountCents: -Number(row.amount_cents), description: `Communication credit · ${row.reason}`, category: "communication_credit", accountType: "expense", source: "Card reversal" }));
      }
      if (!data || data.length < 500) break;
    }
  }
  const internalWithdrawals = new Map<string, ReportRow>();
  if (proplaneBalanceEnabled()) {
    const { data: account, error } = await db.from("proplane_balance_accounts").select("id").eq("owner_kind", "workspace").eq("owner_key", owner).eq("currency", "usd").maybeSingle();
    if (error) throw new Error(error.message);
    if (account) for (let offset = 0; ; offset += 500) {
      const { data, error: entryError } = await db.from("proplane_balance_entries").select("id, created_at, amount_cents, stripe_object_id, idempotency_key").eq("account_id", account.id).eq("kind", "withdrawal").order("id").range(offset, offset + 499);
      if (entryError) throw new Error(entryError.message);
      for (const entry of data ?? []) {
        // A claim is not money moved; reversed sentinels are failed transfers.
        if (!entry.stripe_object_id?.startsWith("tr_") || !inRange(entry.created_at)) continue;
        const row = { ...accountMovement({ id: `balance-${entry.id}`, date: entry.created_at, amountCents: Number(entry.amount_cents), description: "Withdrawal to connected account", category: "withdrawal", accountType: "asset", source: "PropLane balance" }), balanceReferences: entry.idempotency_key };
        rows.push(row);
        internalWithdrawals.set(entry.idempotency_key, row);
      }
      if (!data || data.length < 500) break;
    }
  }
  for (let offset = 0; ; offset += 500) {
    const { data, error } = await db.from("stripe_payouts").select("id, amount_cents, fee_cents, status, created_at, destination_last4, stripe_payout_id, initiated_in_app, row_data").eq("manager_user_id", owner).eq("currency", "usd").in("status", ["paid", "pending", "in_transit"]).order("id").range(offset, offset + 499);
    if (error) throw new Error(error.message);
    for (const row of data ?? []) {
      if (!row.stripe_payout_id || !inRange(row.created_at)) continue;
      const correlated = internalWithdrawals.get(row.row_data?.proplaneBalanceWithdrawal);
      if (correlated) {
        correlated.description = `Withdrawal · ${row.status}${row.destination_last4 ? ` · •••• ${row.destination_last4}` : ""}`;
        continue;
      }
      rows.push({ ...accountMovement({ id: `payout-${row.id}`, date: row.created_at, amountCents: -(Number(row.amount_cents) - (row.initiated_in_app ? Number(row.fee_cents ?? 0) : 0)), description: `Withdrawal · ${row.status}${row.destination_last4 ? ` · •••• ${row.destination_last4}` : ""}`, category: "withdrawal", accountType: "asset", source: "PropLane" }), balanceReferences: row.stripe_payout_id });
      if (Number(row.fee_cents)) rows.push(accountMovement({ id: `payout-fee-${row.id}`, date: row.created_at, amountCents: -Number(row.fee_cents), description: "Withdrawal fee", category: "bank_fees", accountType: "expense", source: "PropLane" }));
    }
    if (!data || data.length < 500) break;
  }
  // Classified test identities never call customer providers. Real billing reads
  // verify the owner/customer mapping before listing (and paginate every invoice).
  if ((await resolveTestWorkspaceClassification(owner, db)).kind === "normal") {
    const identity = await loadManagerBillingIdentity(db, owner);
    if (identity.customerId) {
      for await (const invoice of getStripe().invoices.list({ customer: identity.customerId, status: "paid", limit: 100 })) {
        const paidAt = invoice.status_transitions.paid_at;
        if (!paidAt || invoice.currency !== "usd" || !invoice.parent?.subscription_details) continue;
        const date = new Date(paidAt * 1000).toISOString();
        if (!inRange(date)) continue;
        rows.push(accountMovement({ id: `plan-${invoice.id}`, date, amountCents: -invoice.amount_paid, description: "PropLane plan", category: "software_subscription", accountType: "expense", source: "Card" }));
      }
    }
  }
  return rows;
}
