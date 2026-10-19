import "server-only";

import type Stripe from "stripe";
import type { SupabaseClient } from "@supabase/supabase-js";
import { loadManagerReportDisplayContext } from "@/lib/reports/display-context";
import {
  nextMonthKey,
  pacificMonthKey,
  pacificMonthStartIso,
  describeManagedFee,
  type ManagedFeeTerms,
} from "@/lib/owner-management/fee-math";
import { listPendingExpensesForOwner, type PendingExpense } from "@/lib/managed-finance/vendor-bills.server";
import { listPoliciesForWorkspace, PolicyError, type PolicyRow } from "@/lib/owner-management/policies.server";
import {
  availableToWithdraw,
  ownerParty,
  readPartyBalance,
  readPartyLines,
  vendorParty,
  type LedgerLineRow,
} from "@/lib/managed-finance/ledger.server";
import { buildOwnerStatement, buildVendorStatement, type Statement, type StatementLine, type StatementRow } from "@/lib/managed-finance/statement";
import { resolvePayoutDestination } from "@/lib/managed-finance/withdrawals.server";
import { workspaceOccupancy } from "@/lib/managed-finance/occupancy.server";

/** What the Finances pages show: balance, available, pending, the statement for a month, withdrawals and approvals. */

export type FinanceBalance = { balanceCents: number; availableCents: number; pendingCents: number; reserveCents: number };
export type WithdrawalView = { id: string; amountCents: number; status: string; createdAt: string; payoutPending: boolean };

export type OwnerFinancesView = {
  workspace: { id: string; name: string };
  policy: { id: string; status: PolicyRow["status"]; feeLine: string; terms: ManagedFeeTerms; signedAt: string | null };
  month: string;
  balance: FinanceBalance;
  statement: Statement & { rows: Array<StatementRow & { propertyLabel?: string | null }> };
  pendingApprovals: PendingExpense[];
  withdrawals: WithdrawalView[];
  payoutReady: boolean | null;
  occupancy: { houses: number; units: number; occupied: number } | null;
};

function toStatementLines(lines: LedgerLineRow[]): StatementLine[] {
  return lines.map((l) => ({
    journalId: l.journalId, amountCents: l.amountCents, availableOn: l.availableOn, postedAt: l.postedAt, kind: l.kind,
    detail: l.detail, sourceType: l.sourceType, sourceId: l.sourceId,
  }));
}

export function monthWindow(month: string): { fromIso: string; toIso: string } {
  return { fromIso: pacificMonthStartIso(month), toIso: pacificMonthStartIso(nextMonthKey(month)) };
}

export function parseMonth(raw: string | null | undefined, now: Date = new Date()): string {
  return raw && /^\d{4}-(0[1-9]|1[0-2])$/.test(raw) ? raw : pacificMonthKey(now);
}

async function withdrawalsFor(db: SupabaseClient, kind: "owner" | "vendor", party: string, workspaceId: string | null): Promise<WithdrawalView[]> {
  let q = db.from("party_withdrawals").select("id, amount_cents, status, created_at, stripe_payout_id").eq("party_kind", kind).eq("party_id", party).order("created_at", { ascending: false }).limit(25);
  if (workspaceId) q = q.eq("workspace_id", workspaceId);
  const { data, error } = await q;
  if (error) return [];
  return ((data ?? []) as Array<Record<string, unknown>>).map((r) => ({
    id: String(r.id), amountCents: Number(r.amount_cents), status: String(r.status), createdAt: String(r.created_at),
    payoutPending: r.status === "completed" && !r.stripe_payout_id,
  }));
}

/** The owner of record's Finances for one managed workspace. The workspace is proven by the policy lookup, never trusted. */
export async function loadOwnerFinances(
  db: SupabaseClient,
  stripe: Stripe | null,
  input: { ownerUserId: string; workspaceId: string; month?: string | null },
  now: Date = new Date(),
): Promise<OwnerFinancesView> {
  const policies = await listPoliciesForWorkspace(db, input.workspaceId);
  const mine = policies.filter((p) => p.ownerUserId === input.ownerUserId && p.signedAt);
  if (mine.length === 0) throw new PolicyError(404, "Not found.");
  const current = mine.find((p) => p.status === "active") ?? mine[0]!;
  const month = parseMonth(input.month, now);
  const { fromIso, toIso } = monthWindow(month);
  const party = ownerParty(input.ownerUserId);

  const [balance, lines, pending, withdrawals, wsRow] = await Promise.all([
    readPartyBalance(db, "owner_payable", party, input.workspaceId),
    readPartyLines(db, { account: "owner_payable", partyId: party, workspaceId: input.workspaceId }),
    listPendingExpensesForOwner(db, input.ownerUserId, input.workspaceId),
    withdrawalsFor(db, "owner", party, input.workspaceId),
    db.from("portal_workspaces").select("name, owner_user_id").eq("id", input.workspaceId).maybeSingle(),
  ]);
  const ws = (wsRow.data ?? {}) as { name?: string; owner_user_id?: string };
  const statement = buildOwnerStatement(toStatementLines(lines), fromIso, toIso);
  const display = ws.owner_user_id ? await loadManagerReportDisplayContext(db, ws.owner_user_id).catch(() => null) : null;
  const rows = statement.rows.map((r) => ({ ...r, propertyLabel: r.propertyId ? display?.propertyLabel(r.propertyId) ?? null : null }));
  const reserve = current.status === "active" ? current.terms.reserveTargetCents : 0;
  let payoutReady: boolean | null = null;
  if (stripe) {
    const dest = await resolvePayoutDestination(stripe, db, input.ownerUserId).catch(() => null);
    payoutReady = dest ? !("error" in dest) : null;
  }
  const occupancy = await workspaceOccupancy(db, input.workspaceId, month);
  return {
    workspace: { id: input.workspaceId, name: ws.name ?? "Your workspace" },
    policy: { id: current.id, status: current.status, feeLine: describeManagedFee(current.terms), terms: current.terms, signedAt: current.signedAt },
    month,
    balance: { balanceCents: balance.owedCents, availableCents: availableToWithdraw(balance, reserve), pendingCents: balance.pendingCents, reserveCents: reserve },
    statement: { ...statement, rows },
    pendingApprovals: pending,
    withdrawals,
    payoutReady,
    occupancy,
  };
}

export type VendorFinancesView = {
  month: string;
  balance: FinanceBalance;
  statement: Statement;
  withdrawals: WithdrawalView[];
  payoutReady: boolean | null;
};

export async function loadVendorFinances(
  db: SupabaseClient,
  stripe: Stripe | null,
  input: { vendorUserId: string; month?: string | null },
  now: Date = new Date(),
): Promise<VendorFinancesView> {
  const party = vendorParty(input.vendorUserId);
  const month = parseMonth(input.month, now);
  const { fromIso, toIso } = monthWindow(month);
  const [balance, lines, withdrawals] = await Promise.all([
    readPartyBalance(db, "vendor_payable", party, null),
    readPartyLines(db, { account: "vendor_payable", partyId: party }),
    withdrawalsFor(db, "vendor", party, null),
  ]);
  let payoutReady: boolean | null = null;
  if (stripe) {
    const dest = await resolvePayoutDestination(stripe, db, input.vendorUserId).catch(() => null);
    payoutReady = dest ? !("error" in dest) : null;
  }
  return {
    month,
    balance: { balanceCents: balance.owedCents, availableCents: availableToWithdraw(balance, 0), pendingCents: balance.pendingCents, reserveCents: 0 },
    statement: buildVendorStatement(toStatementLines(lines), fromIso, toIso),
    withdrawals,
    payoutReady,
  };
}

export type PlatformFinancesView = {
  platformCashCents: number;
  owedToOwnersCents: number;
  owedToVendorsCents: number;
  inFlightCents: number;
  depositLiabilityCents: number;
  disputeHoldCents: number;
  feeRevenueCents: number;
  processingRecoveryCents: number;
  disputeExpenseCents: number;
  revenueByMonth: Array<{ workspaceId: string | null; workspaceName: string; month: string; revenueCents: number }>;
  stripeAvailableCents: number | null;
  stripePendingCents: number | null;
  flags: Array<{ check: string; subject: string; day: string }>;
  balanced: boolean;
};

export async function loadPlatformFinances(db: SupabaseClient, stripe: Stripe | null): Promise<PlatformFinancesView> {
  const [totals, revenue, flags, unbalanced] = await Promise.all([
    db.rpc("platform_ledger_totals"),
    db.rpc("platform_fee_revenue_by_month"),
    db.from("owner_ledger_flags").select("check_name, subject, day").order("day", { ascending: false }).limit(20),
    db.rpc("party_ledger_unbalanced_journals"),
  ]);
  const t = new Map(((totals.data ?? []) as Array<{ account: string; total: number | string }>).map((r) => [r.account, Number(r.total)]));
  const revRows = (revenue.data ?? []) as Array<{ workspace_id: string | null; month_key: string; revenue_cents: number | string }>;
  const ids = [...new Set(revRows.map((r) => r.workspace_id).filter(Boolean) as string[])];
  const { data: names } = ids.length ? await db.from("portal_workspaces").select("id, name").in("id", ids) : { data: [] };
  const nameOf = new Map(((names ?? []) as Array<{ id: string; name: string }>).map((n) => [n.id, n.name]));
  let stripeAvailable: number | null = null;
  let stripePending: number | null = null;
  if (stripe) {
    try {
      const b = await stripe.balance.retrieve();
      stripeAvailable = b.available.filter((x) => x.currency === "usd").reduce((s, x) => s + x.amount, 0);
      stripePending = b.pending.filter((x) => x.currency === "usd").reduce((s, x) => s + x.amount, 0);
    } catch { /* shown as unknown */ }
  }
  return {
    platformCashCents: t.get("platform_cash") ?? 0,
    owedToOwnersCents: -(t.get("owner_payable") ?? 0),
    owedToVendorsCents: -(t.get("vendor_payable") ?? 0),
    inFlightCents: -(t.get("withdrawal_in_flight") ?? 0),
    depositLiabilityCents: -(t.get("tenant_deposit_liability") ?? 0),
    disputeHoldCents: -(t.get("dispute_hold") ?? 0),
    feeRevenueCents: -(t.get("proplane_fee_revenue") ?? 0),
    processingRecoveryCents: -(t.get("processing_recovery") ?? 0),
    disputeExpenseCents: t.get("platform_dispute_expense") ?? 0,
    revenueByMonth: revRows
      .map((r) => ({ workspaceId: r.workspace_id, workspaceName: (r.workspace_id && nameOf.get(r.workspace_id)) || "Workspace", month: r.month_key, revenueCents: Number(r.revenue_cents) }))
      .sort((a, b) => b.month.localeCompare(a.month) || a.workspaceName.localeCompare(b.workspaceName)),
    stripeAvailableCents: stripeAvailable,
    stripePendingCents: stripePending,
    flags: ((flags.data ?? []) as Array<{ check_name: string; subject: string; day: string }>).map((f) => ({ check: f.check_name, subject: f.subject, day: f.day })),
    balanced: ((unbalanced.data ?? []) as unknown[]).length === 0,
  };
}
