import "server-only";

import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { withoutOwnerLinks } from "@/lib/co-manager-team-roles";
import { isMissingSchemaError } from "@/lib/one-number/config.server";
import { LedgerError, ownerParty, postJournal, readLedgerPages, vendorParty } from "@/lib/managed-finance/ledger.server";
import { resolveManagedPayee } from "@/lib/managed-finance/payee.server";
import {
  computeSplit,
  reversalTargetCents,
  validateSplitRule,
  type SplitRule,
  type SplitRuleDraft,
} from "@/lib/managed-finance/splits";
import { loadActivePolicyForWorkspace } from "@/lib/owner-management/policies.server";

/**
 * Payout splits on the party ledger (docs/agents/owner-management.md § Payouts and splits). A settled payment's OWNER share is
 * divided by the rules in force on the payment date: one balanced `split_allocation` journal per payment debits the owner's payable
 * and credits each payee's. Idempotent on the payment (journal key + one row per allocation and rule); append-only; the owner keeps
 * the remainder. Nothing here moves money at Stripe.
 */

type Row = Record<string, unknown>;
const str = (v: unknown): string => (typeof v === "string" ? v.trim() : v == null ? "" : String(v).trim());
const MAX_RULES = 500;

export function splitJournalKey(paymentIntentId: string, chargeId: string): string {
  return `split:${paymentIntentId}:${chargeId}`;
}
export function splitReversalKey(refundId: string, allocationId: string): string {
  return `split-reversal:${refundId}:${allocationId}`;
}

function toRule(r: Row): SplitRule {
  return {
    id: str(r.id),
    workspaceId: str(r.workspace_id),
    propertyId: str(r.property_id) || null,
    ruleKind: r.rule_kind === "fixed" ? "fixed" : "percent",
    appliesTo: Array.isArray(r.applies_to) ? (r.applies_to as unknown[]).map(str) : [],
    payeeKind: r.payee_kind === "vendor" ? "vendor" : "member",
    payeeUserId: str(r.payee_user_id),
    bps: r.bps == null ? null : Number(r.bps),
    fixedCents: r.fixed_cents == null ? null : Number(r.fixed_cents),
    effectiveFrom: str(r.effective_from),
    endedAt: str(r.ended_at) || null,
    createdAt: str(r.created_at) || undefined,
  };
}

/** Every rule of a workspace, ended ones included (a payment is read AS OF its own date). A missing table is "no rules". */
export async function loadSplitRules(db: SupabaseClient, workspaceId: string): Promise<SplitRule[]> {
  const { data, error } = await db.from("managed_split_rules").select("*").eq("workspace_id", workspaceId).order("created_at", { ascending: true }).limit(MAX_RULES);
  if (error) {
    if (isMissingSchemaError(error)) return [];
    throw new LedgerError(500, "Could not read the payout split rules.");
  }
  return ((data ?? []) as Row[]).map(toRule);
}

/**
 * The same read for MANY workspaces in one round trip: the admin Payouts page lists every managed workspace, and one query per
 * workspace was one sequential round trip per active fee policy.
 */
export async function loadSplitRulesForWorkspaces(db: SupabaseClient, workspaceIds: readonly string[]): Promise<Map<string, SplitRule[]>> {
  const out = new Map<string, SplitRule[]>();
  for (const id of workspaceIds) out.set(id, []);
  const ids = [...new Set(workspaceIds)].filter(Boolean);
  if (ids.length === 0) return out;
  const scanned = await readLedgerPages<Row>((from, to) =>
    db.from("managed_split_rules").select("*").in("workspace_id", ids).order("created_at", { ascending: true }).order("id", { ascending: true }).range(from, to),
  );
  if (scanned === "missing_schema") return out;
  for (const raw of scanned) {
    const rule = toRule(raw);
    const bucket = out.get(rule.workspaceId);
    if (bucket) bucket.push(rule);
    else out.set(rule.workspaceId, [rule]);
  }
  return out;
}

/** Rules in force right now. */
export function activeRulesNow(rules: readonly SplitRule[], now: Date = new Date()): SplitRule[] {
  const t = now.getTime();
  return rules.filter((r) => Date.parse(r.effectiveFrom) <= t && (r.endedAt === null || t < Date.parse(r.endedAt)));
}

type AllocationRow = {
  id: string; workspace_id: string; charge_id: string; charge_kind: string; liability_class: string; property_id: string | null;
  owner_user_id: string | null; owner_cents: number | string; available_on: string | null; paid_at: string; stripe_payment_intent_id: string;
  refunded_owner_cents?: number | string;
};

/**
 * Apply the split rules to every allocation of one settled PaymentIntent. Safe to call on every delivery: it is a no-op once each
 * allocation is split. Throws on a failed read or write so the Stripe webhook is redelivered (a managed capture never half-settles).
 */
export async function applySplitsForPaymentIntent(db: SupabaseClient, input: { workspaceId: string; paymentIntentId: string }): Promise<{ journals: number; paidOutCents: number }> {
  // Every component of the capture, PAGED in a stable order: a bare `.limit(100)` returned an arbitrary 100 of them once a
  // capture crossed that many, and a redelivery need not have picked up the rest — a payee's share was silently skipped
  // with no error anywhere.
  const scanned = await readLedgerPages<AllocationRow>((from, to) =>
    db
      .from("managed_rent_allocations")
      .select("id, workspace_id, charge_id, charge_kind, liability_class, property_id, owner_user_id, owner_cents, available_on, paid_at, stripe_payment_intent_id")
      .eq("workspace_id", input.workspaceId)
      .eq("stripe_payment_intent_id", input.paymentIntentId)
      .order("id", { ascending: true })
      .range(from, to),
  );
  if (scanned === "missing_schema") return { journals: 0, paidOutCents: 0 };
  const allocations = scanned.filter((a) => a.liability_class === "income" && Number(a.owner_cents) > 0 && a.owner_user_id);
  if (allocations.length === 0) return { journals: 0, paidOutCents: 0 };
  const rules = await loadSplitRules(db, input.workspaceId);
  if (rules.length === 0) return { journals: 0, paidOutCents: 0 };

  let journals = 0;
  let paidOut = 0;
  for (const a of allocations) {
    const result = computeSplit(rules, {
      chargeKind: a.charge_kind, propertyId: a.property_id, ownerCents: Number(a.owner_cents), paidAt: a.paid_at,
    });
    if (result.shares.length === 0) continue;
    const total = result.shares.reduce((s, x) => s + x.cents, 0);
    if (total + result.ownerRemainderCents !== Number(a.owner_cents)) throw new LedgerError(500, "A payout split did not sum to the owner's share.");
    const owner = ownerParty(String(a.owner_user_id));
    const posted = await postJournal(db, {
      workspaceId: a.workspace_id,
      kind: "split_allocation",
      key: splitJournalKey(a.stripe_payment_intent_id, a.charge_id),
      sourceType: "stripe_payment_intent",
      sourceId: a.stripe_payment_intent_id,
      detail: {
        allocation_id: a.id, charge_id: a.charge_id, charge_kind: a.charge_kind, property_id: a.property_id,
        owner_cents: Number(a.owner_cents), owner_remainder_cents: result.ownerRemainderCents,
        shares: result.shares.map((s) => ({ rule_id: s.ruleId, payee_user_id: s.payeeUserId, payee_kind: s.payeeKind, cents: s.cents })),
      },
      lines: [
        { account: "owner_payable", party_id: owner, workspace_id: a.workspace_id, amount_cents: total, available_on: a.available_on },
        ...result.shares.map((s) => ({
          account: (s.payeeKind === "vendor" ? "vendor_payable" : "owner_payable") as "vendor_payable" | "owner_payable",
          party_id: s.payeeKind === "vendor" ? vendorParty(s.payeeUserId) : ownerParty(s.payeeUserId),
          workspace_id: a.workspace_id,
          amount_cents: -s.cents,
          available_on: a.available_on,
        })),
      ],
      postedAt: a.paid_at,
    });
    const { error: insertError } = await db.from("managed_split_allocations").upsert(
      result.shares.map((s) => ({
        workspace_id: a.workspace_id, allocation_id: a.id, rule_id: s.ruleId, payee_kind: s.payeeKind, payee_user_id: s.payeeUserId,
        payee_party: s.payeeKind === "vendor" ? vendorParty(s.payeeUserId) : ownerParty(s.payeeUserId),
        stripe_payment_intent_id: a.stripe_payment_intent_id, charge_id: a.charge_id, property_id: a.property_id,
        amount_cents: s.cents, journal_id: posted.journalId, available_on: a.available_on, paid_at: a.paid_at,
      })),
      { onConflict: "allocation_id,rule_id", ignoreDuplicates: true },
    );
    if (insertError) throw new LedgerError(500, "Could not record the payout split.");
    if (posted.created) {
      journals += 1;
      paidOut += total;
    }
  }
  return { journals, paidOutCents: paidOut };
}

/**
 * After a refund reduced an allocation's owner share, take the matching pro-rata part back from each payee and return it to the
 * owner. Cumulative and idempotent per (refund, allocation). A payee who already withdrew goes negative and is netted against their
 * next earnings, exactly like an owner.
 */
export async function reverseSplitsForRefund(db: SupabaseClient, input: { allocationId: string; refundId: string }): Promise<{ reversedCents: number }> {
  const { data: allocData, error: allocError } = await db
    .from("managed_rent_allocations")
    .select("id, workspace_id, owner_user_id, owner_cents, refunded_owner_cents")
    .eq("id", input.allocationId)
    .maybeSingle();
  if (allocError) {
    if (isMissingSchemaError(allocError)) return { reversedCents: 0 };
    throw new LedgerError(500, "Could not read the refunded allocation.");
  }
  const alloc = allocData as AllocationRow | null;
  if (!alloc?.owner_user_id) return { reversedCents: 0 };
  // Paged for the same reason as the allocation read: a partial list here would under-reverse, leaving a payee holding a
  // share of money the resident got back.
  const scannedSplits = await readLedgerPages<Row>((from, to) =>
    db.from("managed_split_allocations").select("*").eq("allocation_id", input.allocationId).order("id", { ascending: true }).range(from, to),
  );
  if (scannedSplits === "missing_schema") return { reversedCents: 0 };
  const splits = scannedSplits;
  if (splits.length === 0) return { reversedCents: 0 };
  const ownerCents = Number(alloc.owner_cents);
  const refunded = Number(alloc.refunded_owner_cents ?? 0);
  const targets = splits.map((s) => ({
    row: s,
    target: reversalTargetCents({ shareCents: Number(s.amount_cents), ownerCents, refundedOwnerCents: refunded }),
    done: Number(s.reversed_cents ?? 0),
  }));
  const key = splitReversalKey(input.refundId, input.allocationId);
  const { data: existing, error: existingError } = await db.from("party_ledger_journals").select("id").eq("idempotency_key", key).limit(1);
  if (existingError) throw new LedgerError(500, "Could not read the split reversal.");
  const already = ((existing ?? []) as unknown[]).length > 0;
  const deltas = targets.map((t) => ({ ...t, delta: Math.max(0, t.target - t.done) }));
  const total = already ? 0 : deltas.reduce((s, d) => s + d.delta, 0);
  if (!already && total > 0) {
    await postJournal(db, {
      workspaceId: alloc.workspace_id,
      kind: "split_reversal",
      key,
      sourceType: "stripe_refund",
      sourceId: input.refundId,
      detail: { allocation_id: input.allocationId, reversed_cents: total },
      lines: [
        { account: "owner_payable", party_id: ownerParty(String(alloc.owner_user_id)), workspace_id: alloc.workspace_id, amount_cents: -total, available_on: str(deltas[0]!.row.available_on) || null },
        ...deltas.filter((d) => d.delta > 0).map((d) => ({
          account: (d.row.payee_kind === "vendor" ? "vendor_payable" : "owner_payable") as "vendor_payable" | "owner_payable",
          party_id: str(d.row.payee_party), workspace_id: alloc.workspace_id, amount_cents: d.delta,
          available_on: str(d.row.available_on) || null,
        })),
      ],
    });
  }
  for (const d of deltas) {
    if (d.target <= d.done) continue;
    const { error } = await db.from("managed_split_allocations").update({ reversed_cents: d.target }).eq("id", str(d.row.id)).lt("reversed_cents", d.target);
    if (error) throw new LedgerError(500, "Could not record the split reversal.");
  }
  return { reversedCents: total };
}

// ---------------------------------------------------------------------------------------------
// Rule editing (platform admin only; the route enforces `requirePlatformAdmin`, this re-derives everything else).
// ---------------------------------------------------------------------------------------------

async function writeAudit(db: SupabaseClient, row: { actor: string; action: string; workspaceId?: string | null; partyId?: string | null; subjectId?: string | null; detail?: Record<string, unknown> }): Promise<void> {
  const { error } = await db.from("payout_staff_actions").insert({
    actor_user_id: row.actor, action: row.action, workspace_id: row.workspaceId ?? null, party_id: row.partyId ?? null,
    subject_id: row.subjectId ?? null, detail: row.detail ?? {},
  });
  if (error) throw new LedgerError(500, "Could not record the audit entry; nothing was changed.");
}
export { writeAudit as writePayoutAudit };

/** Re-derive every fact a new rule depends on. The body names ids; the database says whether they are valid. */
async function eligibility(db: SupabaseClient, workspaceId: string, draft: SplitRuleDraft) {
  const policy = await loadActivePolicyForWorkspace(db, workspaceId);
  if (!policy) throw new LedgerError(409, "This workspace is not managed by PropLane.");
  const ownerUserId = await resolveManagedPayee(db, workspaceId);
  let member = false;
  let vendor = false;
  if (draft.payeeKind === "member") {
    const { data, error } = withoutOwnerLinks(await db.from("account_link_invites").select("id, team_role").eq("workspace_id", workspaceId).eq("status", "accepted").eq("invitee_user_id", draft.payeeUserId).limit(5));
    if (error) throw new LedgerError(500, "Could not check the team.");
    // A Property owner seat is never a team payee (withoutOwnerLinks drops it).
    member = ((data ?? []) as Row[]).length > 0;
  } else {
    const { data: roleRows, error: roleError } = await db.from("profile_roles").select("role").eq("user_id", draft.payeeUserId).eq("role", "vendor").limit(1);
    if (roleError) throw new LedgerError(500, "Could not check the vendor.");
    const { data: profile } = await db.from("profiles").select("stripe_connect_account_id").eq("id", draft.payeeUserId).maybeSingle();
    vendor = ((roleRows ?? []) as unknown[]).length > 0 && Boolean(str((profile as Row | null)?.stripe_connect_account_id));
  }
  let propertyInWorkspace = false;
  if (draft.propertyId) {
    const { data, error } = await db.from("manager_property_records").select("id").eq("id", draft.propertyId).eq("workspace_id", workspaceId).maybeSingle();
    if (error) throw new LedgerError(500, "Could not check the house.");
    propertyInWorkspace = Boolean(data);
  }
  return { ownerUserId, member, vendor, propertyInWorkspace };
}

export async function createSplitRule(db: SupabaseClient, input: { actorUserId: string; workspaceId: string; draft: SplitRuleDraft }, now: Date = new Date()): Promise<SplitRule> {
  const { workspaceId, draft } = input;
  const facts = await eligibility(db, workspaceId, draft);
  const active = activeRulesNow(await loadSplitRules(db, workspaceId), now);
  const problem = validateSplitRule(draft, {
    activeRules: active, ownerUserId: facts.ownerUserId, payeeIsWorkspaceMember: facts.member,
    payeeIsVendorWithConnectedAccount: facts.vendor, propertyInWorkspace: facts.propertyInWorkspace,
  });
  if (problem) throw new LedgerError(422, problem, "INVALID_SPLIT");
  const id = randomUUID();
  await writeAudit(db, { actor: input.actorUserId, action: "split_rule_created", workspaceId, subjectId: id, detail: { ...draft } });
  const { data, error } = await db.from("managed_split_rules").insert({
    id, workspace_id: workspaceId, property_id: draft.propertyId, rule_kind: draft.ruleKind, applies_to: [...draft.appliesTo],
    payee_kind: draft.payeeKind, payee_user_id: draft.payeeUserId, bps: draft.bps, fixed_cents: draft.fixedCents,
    effective_from: now.toISOString(), created_by: input.actorUserId,
  }).select("*").single();
  if (error || !data) throw new LedgerError(500, "Could not save the split rule.");
  return toRule(data as Row);
}

export async function endSplitRule(db: SupabaseClient, input: { actorUserId: string; workspaceId: string; ruleId: string }, now: Date = new Date()): Promise<void> {
  const { data, error } = await db.from("managed_split_rules").select("id, ended_at, effective_from").eq("id", input.ruleId).eq("workspace_id", input.workspaceId).maybeSingle();
  if (error) throw new LedgerError(500, "Could not read the split rule.");
  const row = data as Row | null;
  if (!row) throw new LedgerError(404, "Not found.");
  if (row.ended_at) throw new LedgerError(409, "That rule has already ended.");
  await writeAudit(db, { actor: input.actorUserId, action: "split_rule_ended", workspaceId: input.workspaceId, subjectId: input.ruleId });
  // The window never closes before it opened (a rule created in the same instant).
  const endedAt = new Date(Math.max(now.getTime(), Date.parse(str(row.effective_from)))).toISOString();
  const { error: updateError } = await db.from("managed_split_rules").update({ ended_at: endedAt, ended_by: input.actorUserId }).eq("id", input.ruleId).is("ended_at", null);
  if (updateError) throw new LedgerError(500, "Could not end the split rule.");
}

// ---------------------------------------------------------------------------------------------
// Holds (staff hold one party's withdrawals, never their balance) and the bill-pay approval threshold.
// ---------------------------------------------------------------------------------------------

export class PayoutHeldError extends Error {
  constructor(readonly reason: string) {
    super("Withdrawals are on hold for this account. PropLane support can tell you why.");
  }
}

/** The active hold on a party (in this workspace, or one that covers every workspace), or null. A failed read throws: fail closed. */
export async function activePayoutHold(db: SupabaseClient, partyId: string, workspaceId: string | null): Promise<{ id: string; reason: string } | null> {
  const { data, error } = await db.from("managed_payout_holds").select("id, reason, workspace_id").eq("party_id", partyId).is("released_at", null).limit(10);
  if (error) {
    if (isMissingSchemaError(error)) return null;
    throw new LedgerError(503, "Could not check the account's payout status. Try again in a moment.");
  }
  const rows = (data ?? []) as Row[];
  const hit = rows.find((r) => !r.workspace_id || !workspaceId || str(r.workspace_id) === workspaceId);
  return hit ? { id: str(hit.id), reason: str(hit.reason) } : null;
}

export async function placePayoutHold(db: SupabaseClient, input: { actorUserId: string; partyId: string; workspaceId: string | null; reason: string }): Promise<{ id: string }> {
  const reason = input.reason.trim();
  if (reason.length < 3 || reason.length > 500) throw new LedgerError(400, "Give a reason (3 to 500 characters).");
  if (!/^(owner|vendor):[0-9a-f-]{36}$/i.test(input.partyId)) throw new LedgerError(400, "Choose a payout account.");
  await writeAudit(db, { actor: input.actorUserId, action: "hold", workspaceId: input.workspaceId, partyId: input.partyId, detail: { reason } });
  const { data, error } = await db.from("managed_payout_holds").insert({ party_id: input.partyId, workspace_id: input.workspaceId, reason, placed_by: input.actorUserId }).select("id").single();
  if (error || !data) {
    if (String(error?.code) === "23505") throw new LedgerError(409, "That account is already on hold.");
    throw new LedgerError(500, "Could not place the hold.");
  }
  return { id: str((data as Row).id) };
}

export async function releasePayoutHold(db: SupabaseClient, input: { actorUserId: string; holdId: string; note?: string }): Promise<void> {
  const { data, error } = await db.from("managed_payout_holds").select("id, party_id, workspace_id, released_at").eq("id", input.holdId).maybeSingle();
  if (error) throw new LedgerError(500, "Could not read the hold.");
  const hold = data as Row | null;
  if (!hold) throw new LedgerError(404, "Not found.");
  if (hold.released_at) throw new LedgerError(409, "That hold is already released.");
  await writeAudit(db, { actor: input.actorUserId, action: "release", workspaceId: str(hold.workspace_id) || null, partyId: str(hold.party_id), subjectId: input.holdId, detail: { note: input.note?.slice(0, 300) ?? null } });
  const { error: updateError } = await db.from("managed_payout_holds").update({ released_at: new Date().toISOString(), released_by: input.actorUserId, release_note: input.note?.slice(0, 300) ?? null }).eq("id", input.holdId).is("released_at", null);
  if (updateError) throw new LedgerError(500, "Could not release the hold.");
}

/**
 * The workspace's explicit bill-pay approval threshold, or null when none was set (the fee policy's own repair threshold then
 * applies, so adding this table never loosens an owner's existing protection). An unreadable row throws: fail closed.
 */
export async function loadBillApprovalThreshold(db: SupabaseClient, workspaceId: string): Promise<number | null> {
  const { data, error } = await db.from("managed_payout_settings").select("bill_approval_threshold_cents").eq("workspace_id", workspaceId).maybeSingle();
  if (error) {
    if (isMissingSchemaError(error)) return null;
    throw new LedgerError(500, "Could not read the bill approval threshold.");
  }
  const cents = (data as Row | null)?.bill_approval_threshold_cents;
  return cents == null ? null : Number(cents);
}

export async function setBillApprovalThreshold(db: SupabaseClient, input: { actorUserId: string; workspaceId: string; cents: number }): Promise<void> {
  if (!Number.isSafeInteger(input.cents) || input.cents < 0 || input.cents > 100_000_000) throw new LedgerError(400, "Enter a dollar amount.");
  await writeAudit(db, { actor: input.actorUserId, action: "bill_threshold_set", workspaceId: input.workspaceId, detail: { cents: input.cents } });
  const { error } = await db.from("managed_payout_settings").upsert(
    { workspace_id: input.workspaceId, bill_approval_threshold_cents: input.cents, updated_by: input.actorUserId, updated_at: new Date().toISOString() },
    { onConflict: "workspace_id" },
  );
  if (error) throw new LedgerError(500, "Could not save the threshold.");
}

export type EligiblePayee = { userId: string; label: string; kind: "member" | "vendor" };

/** Who a split rule may pay on a workspace: accepted team members (never the Property owner seat) and roster vendors with payouts set up. */
export async function listEligiblePayees(db: SupabaseClient, workspaceId: string): Promise<EligiblePayee[]> {
  const out: EligiblePayee[] = [];
  const { data: invites, error } = withoutOwnerLinks(await db.from("account_link_invites").select("invitee_user_id, team_role").eq("workspace_id", workspaceId).eq("status", "accepted").limit(200));
  if (error) throw new LedgerError(500, "Could not read the team.");
  const memberIds = [...new Set(((invites ?? []) as Row[]).map((r) => str(r.invitee_user_id)).filter(Boolean))];
  const { data: ws } = await db.from("portal_workspaces").select("owner_user_id").eq("id", workspaceId).maybeSingle();
  const manager = str((ws as Row | null)?.owner_user_id);
  const { data: roster } = manager ? await db.from("manager_vendor_records").select("vendor_user_id").eq("manager_user_id", manager).not("vendor_user_id", "is", null).limit(300) : { data: [] };
  const vendorIds = [...new Set(((roster ?? []) as Row[]).map((r) => str(r.vendor_user_id)).filter(Boolean))].filter((id) => id !== manager);
  const ids = [...new Set([...memberIds, ...vendorIds])];
  if (ids.length === 0) return out;
  const { data: profiles } = await db.from("profiles").select("id, full_name, email, stripe_connect_account_id").in("id", ids);
  const byId = new Map(((profiles ?? []) as Row[]).map((p) => [str(p.id), p]));
  const { data: roles } = vendorIds.length ? await db.from("profile_roles").select("user_id").eq("role", "vendor").in("user_id", vendorIds) : { data: [] };
  const vendorRole = new Set(((roles ?? []) as Row[]).map((r) => str(r.user_id)));
  const labelOf = (id: string) => str(byId.get(id)?.full_name) || str(byId.get(id)?.email) || "Account";
  for (const id of memberIds) if (id !== manager) out.push({ userId: id, label: labelOf(id), kind: "member" });
  for (const id of vendorIds) {
    if (vendorRole.has(id) && str(byId.get(id)?.stripe_connect_account_id)) out.push({ userId: id, label: `${labelOf(id)} (vendor)`, kind: "vendor" });
  }
  return out.sort((a, b) => a.label.localeCompare(b.label));
}
