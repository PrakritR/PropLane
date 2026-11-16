import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { isMissingSchemaError } from "@/lib/one-number/config.server";
import { LedgerError, readLedgerPages } from "@/lib/managed-finance/ledger.server";
import { describeManagedFee } from "@/lib/owner-management/fee-math";
import { mapPolicyRow, POLICY_COLUMNS } from "@/lib/owner-management/policies.server";
import { loadSplitRulesForWorkspaces, activeRulesNow } from "@/lib/managed-finance/splits.server";
import type { SplitRule } from "@/lib/managed-finance/splits";

/**
 * Admin > Money > Payouts: every PropLane-held balance, the split rules per managed workspace, held and failed payouts with their
 * reasons, and the audit trail. Read-only; every write goes through `/api/admin/payouts` (staff audit row first).
 */

type Row = Record<string, unknown>;
const str = (v: unknown): string => (typeof v === "string" ? v.trim() : v == null ? "" : String(v).trim());

export type AdminPartyBalance = {
  partyId: string;
  kind: "owner" | "vendor";
  label: string;
  workspaceId: string | null;
  workspaceName: string;
  owedCents: number;
  availableCents: number;
  pendingCents: number;
  holdId: string | null;
  holdReason: string | null;
};

export type AdminPayoutProblem = {
  id: string;
  partyLabel: string;
  workspaceName: string;
  amountCents: number;
  status: string;
  reason: string;
  createdAt: string;
};

export type AdminWorkspaceSplits = {
  workspaceId: string;
  workspaceName: string;
  feeLine: string;
  billApprovalThresholdCents: number;
  /** No explicit setting: the fee policy's repair threshold applies. */
  billApprovalThresholdIsDefault: boolean;
  rules: Array<SplitRule & { payeeLabel: string; propertyLabel: string | null }>;
  endedRuleCount: number;
};

export type AdminPayoutsView = {
  totals: { feeEarnedCents: number; owedToPartiesCents: number; availableCents: number; pendingCents: number };
  parties: AdminPartyBalance[];
  problems: AdminPayoutProblem[];
  holds: Array<{ id: string; partyLabel: string; workspaceName: string; reason: string; placedAt: string }>;
  workspaces: AdminWorkspaceSplits[];
  audit: Array<{ id: string; action: string; actorLabel: string; workspaceName: string; detail: Record<string, unknown>; createdAt: string }>;
};

/** One scan of every payable / fee line, folded per party and workspace. Paged (a bare limit would shorten a balance). */
export function foldPartyBalances(
  lines: ReadonlyArray<{ account: string; party_id: string | null; workspace_id: string | null; amount_cents: number | string; available_on: string | null }>,
  nowMs: number,
): { parties: Map<string, { account: string; partyId: string; workspaceId: string | null; owed: number; matured: number }>; feeRevenueCents: number } {
  const parties = new Map<string, { account: string; partyId: string; workspaceId: string | null; owed: number; matured: number }>();
  let fee = 0;
  for (const l of lines) {
    const cents = Number(l.amount_cents);
    if (l.account === "proplane_fee_revenue") {
      fee += -cents;
      continue;
    }
    if ((l.account !== "owner_payable" && l.account !== "vendor_payable") || !l.party_id) continue;
    // A vendor's balance spans workspaces (one party), an owner's is per workspace.
    const workspaceId = l.account === "owner_payable" ? l.workspace_id : null;
    const key = `${l.account}|${l.party_id}|${workspaceId ?? ""}`;
    const row = parties.get(key) ?? { account: l.account, partyId: l.party_id, workspaceId, owed: 0, matured: 0 };
    row.owed += -cents;
    if (!l.available_on || Date.parse(l.available_on) <= nowMs) row.matured += -cents;
    parties.set(key, row);
  }
  return { parties, feeRevenueCents: fee };
}

/** A date no `available_on` can reach: the rollup already decided matured vs pending, and the fold reads that from the date. */
const NEVER_MATURES = "9999-12-31T00:00:00.000Z";

export type BalanceRollupRow = { account: string; party_id: string | null; workspace_id: string | null; matured_cents: number | string; pending_cents: number | string };

/**
 * Every PropLane-held balance, grouped in the DATABASE (`party_ledger_balance_rollup`). The fold below then collapses a
 * party's workspaces and separates the fee revenue, over one row per (account, party, workspace) instead of one row per
 * ledger line: scanning the whole table for this page was a request that grows without bound and, past the page budget,
 * answered with short balances. A missing function falls back to the paged scan so a database behind this migration still
 * reports a balance.
 */
export async function readBalanceRollupLines(
  db: SupabaseClient,
): Promise<Array<{ account: string; party_id: string | null; workspace_id: string | null; amount_cents: number; available_on: string | null }>> {
  const { data, error } = await db.rpc("party_ledger_balance_rollup");
  if (!error) {
    return ((data ?? []) as BalanceRollupRow[]).flatMap((r) => [
      { account: r.account, party_id: r.party_id, workspace_id: r.workspace_id, amount_cents: Number(r.matured_cents), available_on: null },
      { account: r.account, party_id: r.party_id, workspace_id: r.workspace_id, amount_cents: Number(r.pending_cents), available_on: NEVER_MATURES },
    ]);
  }
  const code = String((error as { code?: string | null }).code ?? "");
  const functionMissing = code === "PGRST202" || code === "42883";
  if (!functionMissing && !isMissingSchemaError(error)) throw new LedgerError(500, "Could not read the PropLane-held balances.");
  const scanned = await readLedgerPages<{ account: string; party_id: string | null; workspace_id: string | null; amount_cents: number | string; available_on: string | null }>((from, to) =>
    db.from("party_ledger_lines").select("account, party_id, workspace_id, amount_cents, available_on").in("account", ["owner_payable", "vendor_payable", "proplane_fee_revenue"]).order("created_at", { ascending: true }).order("id", { ascending: true }).range(from, to),
  );
  if (scanned === "missing_schema") return [];
  return scanned.map((r) => ({ ...r, amount_cents: Number(r.amount_cents) }));
}

export async function loadAdminPayouts(db: SupabaseClient, now: Date = new Date()): Promise<AdminPayoutsView> {
  const lines = await readBalanceRollupLines(db);
  const { parties: folded, feeRevenueCents } = foldPartyBalances(lines, now.getTime());

  const userIds = new Set<string>();
  const workspaceIds = new Set<string>();
  for (const p of folded.values()) {
    userIds.add(p.partyId.split(":")[1] ?? "");
    if (p.workspaceId) workspaceIds.add(p.workspaceId);
  }
  // Managed workspaces: every workspace with a fee policy, with its rules.
  const { data: policyRows, error: policyError } = await db.from("managed_workspace_fee_policies").select(POLICY_COLUMNS).in("status", ["active"]).limit(500);
  if (policyError && !isMissingSchemaError(policyError)) throw new LedgerError(500, "Could not read the managed workspaces.");
  const policies = ((policyRows ?? []) as Row[]).map(mapPolicyRow);
  for (const p of policies) workspaceIds.add(p.workspaceId);

  const { data: holdRows } = await db.from("managed_payout_holds").select("id, party_id, workspace_id, reason, placed_at").is("released_at", null).limit(500);
  const holds = (holdRows ?? []) as Row[];
  for (const h of holds) {
    userIds.add(str(h.party_id).split(":")[1] ?? "");
    if (h.workspace_id) workspaceIds.add(str(h.workspace_id));
  }
  const { data: wdRows } = await db
    .from("party_withdrawals")
    .select("id, party_kind, party_id, workspace_id, amount_cents, status, payout_error, failure_reason, created_at")
    .or("status.in.(failed,unknown),payout_error.not.is.null")
    .order("created_at", { ascending: false })
    .limit(50);
  const wds = (wdRows ?? []) as Row[];
  for (const w of wds) {
    userIds.add(str(w.party_id).split(":")[1] ?? "");
    if (w.workspace_id) workspaceIds.add(str(w.workspace_id));
  }
  const { data: auditRows } = await db.from("payout_staff_actions").select("id, actor_user_id, action, workspace_id, party_id, detail, created_at").order("created_at", { ascending: false }).limit(40);
  const audit = (auditRows ?? []) as Row[];
  for (const a of audit) {
    if (a.actor_user_id) userIds.add(str(a.actor_user_id));
    if (a.workspace_id) workspaceIds.add(str(a.workspace_id));
  }

  const rulesByWorkspace = await loadSplitRulesForWorkspaces(db, policies.map((p) => p.workspaceId));
  for (const rules of rulesByWorkspace.values()) for (const r of rules) userIds.add(r.payeeUserId);
  const { data: thresholdRows } = await db.from("managed_payout_settings").select("workspace_id, bill_approval_threshold_cents").limit(1000);
  const thresholds = new Map(((thresholdRows ?? []) as Row[]).map((r) => [str(r.workspace_id), Number(r.bill_approval_threshold_cents)]));

  const ids = [...userIds].filter(Boolean);
  const { data: profileRows } = ids.length ? await db.from("profiles").select("id, full_name, email").in("id", ids) : { data: [] };
  const nameOf = new Map(((profileRows ?? []) as Row[]).map((p) => [str(p.id), str(p.full_name) || str(p.email) || "Account"]));
  const { data: wsRows } = workspaceIds.size ? await db.from("portal_workspaces").select("id, name").in("id", [...workspaceIds]) : { data: [] };
  const wsName = new Map(((wsRows ?? []) as Row[]).map((w) => [str(w.id), str(w.name) || "Workspace"]));
  const labelOfParty = (party: string) => nameOf.get(party.split(":")[1] ?? "") ?? "Account";

  const holdFor = (partyId: string, workspaceId: string | null) => holds.find((h) => str(h.party_id) === partyId && (!h.workspace_id || !workspaceId || str(h.workspace_id) === workspaceId));
  const partyRows: AdminPartyBalance[] = [...folded.values()].map((p) => {
    const hold = holdFor(p.partyId, p.workspaceId);
    return {
      partyId: p.partyId,
      kind: (p.account === "vendor_payable" ? "vendor" : "owner") as AdminPartyBalance["kind"],
      label: labelOfParty(p.partyId),
      workspaceId: p.workspaceId,
      workspaceName: p.workspaceId ? wsName.get(p.workspaceId) ?? "Workspace" : "All workspaces",
      owedCents: p.owed,
      availableCents: Math.max(0, Math.min(p.owed, p.matured)),
      pendingCents: Math.max(0, p.owed - p.matured),
      holdId: hold ? str(hold.id) : null,
      holdReason: hold ? str(hold.reason) : null,
    };
  }).filter((p) => p.owedCents !== 0).sort((a, b) => b.owedCents - a.owedCents);

  const workspaces: AdminWorkspaceSplits[] = policies.map((p) => {
    const all = rulesByWorkspace.get(p.workspaceId) ?? [];
    const active = activeRulesNow(all, now);
    return {
      workspaceId: p.workspaceId,
      workspaceName: wsName.get(p.workspaceId) ?? "Workspace",
      feeLine: describeManagedFee(p.terms),
      billApprovalThresholdCents: thresholds.get(p.workspaceId) ?? p.terms.repairApprovalThresholdCents,
      billApprovalThresholdIsDefault: !thresholds.has(p.workspaceId),
      rules: active.map((r) => ({ ...r, payeeLabel: nameOf.get(r.payeeUserId) ?? "Account", propertyLabel: null })),
      endedRuleCount: all.length - active.length,
    };
  }).sort((a, b) => a.workspaceName.localeCompare(b.workspaceName));

  return {
    totals: {
      feeEarnedCents: feeRevenueCents,
      owedToPartiesCents: partyRows.reduce((s, p) => s + p.owedCents, 0),
      availableCents: partyRows.reduce((s, p) => s + p.availableCents, 0),
      pendingCents: partyRows.reduce((s, p) => s + p.pendingCents, 0),
    },
    parties: partyRows,
    problems: wds.map((w) => ({
      id: str(w.id), partyLabel: labelOfParty(str(w.party_id)), workspaceName: w.workspace_id ? wsName.get(str(w.workspace_id)) ?? "Workspace" : "All workspaces",
      amountCents: Number(w.amount_cents), status: str(w.status),
      reason: str(w.failure_reason) || str(w.payout_error).replace(/^[A-Z_]+#\d+\s*/, "") || (str(w.status) === "unknown" ? "Waiting for Stripe to confirm." : "Needs a look."),
      createdAt: str(w.created_at),
    })),
    holds: holds.map((h) => ({
      id: str(h.id), partyLabel: labelOfParty(str(h.party_id)), workspaceName: h.workspace_id ? wsName.get(str(h.workspace_id)) ?? "Workspace" : "All workspaces",
      reason: str(h.reason), placedAt: str(h.placed_at),
    })),
    workspaces,
    audit: audit.map((a) => ({
      id: str(a.id), action: str(a.action), actorLabel: a.actor_user_id ? nameOf.get(str(a.actor_user_id)) ?? "Staff" : "Staff",
      workspaceName: a.workspace_id ? wsName.get(str(a.workspace_id)) ?? "Workspace" : "",
      detail: (a.detail as Record<string, unknown>) ?? {}, createdAt: str(a.created_at),
    })),
  };
}
