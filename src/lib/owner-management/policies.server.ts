import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { pacificDayKey } from "@/lib/house-groups/time";
import { isMissingSchemaError } from "@/lib/one-number/config.server";
import {
  canonicalPolicyTerms,
  policyTermsSha256,
  validateManagedFeeTerms,
  type FeeAppliesTo,
  type ManagedFeeTerms,
} from "@/lib/owner-management/fee-math";
import {
  DEFAULT_MANAGEMENT_FEE_PERCENT,
  MANAGEMENT_FEE_RANGE_MESSAGE,
  MAX_MANAGEMENT_FEE_PERCENT,
  feePercentForOwnerShareBps,
  ownerShareBpsForFeePercent,
} from "@/lib/owner-management/fee-percent";
import { flagManagedFeeProblem, type FeeFlagCause } from "@/lib/owner-management/fee-flags.server";

/**
 * Fee policies of PropLane-managed workspaces. Only a platform admin creates, attests or ends one (the fee is PropLane's
 * revenue); nobody signs one (there is no fee-agreement signature anywhere in the product); and a change is a new draft
 * version that ends the old one when it is activated, atomically (`activate_managed_policy`).
 */

export { DEFAULT_MANAGEMENT_FEE_PERCENT, MAX_MANAGEMENT_FEE_PERCENT, ownerShareBpsForFeePercent };

export type PolicyStatus = "draft" | "active" | "ended";

export type PolicyRow = {
  id: string;
  workspaceId: string;
  ownerUserId: string;
  status: PolicyStatus;
  terms: ManagedFeeTerms;
  effectiveFrom: string;
  endsOn: string | null;
  sentAt: string | null;
  signedAt: string | null;
  acceptedVia: "owner_signature" | "admin_attested" | null;
  termsSha256: string | null;
  createdAt: string;
};

export class PolicyError extends Error {
  constructor(readonly status: number, message: string, readonly code?: string) {
    super(message);
  }
}

export type AdminActor = { role: "admin"; userId: string };

export const POLICY_COLUMNS =
  "id, workspace_id, owner_user_id, status, owner_share_bps, applies_to, leasing_fee_bps, min_fee_cents, reserve_target_cents, repair_approval_threshold_cents, effective_from, ends_on, sent_at, signed_at, accepted_via, terms_sha256, created_at";

type Row = Record<string, unknown>;
const str = (v: unknown): string => (typeof v === "string" ? v.trim() : v == null ? "" : String(v).trim());
const int = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : 0;
};

export function mapPolicyRow(raw: Row): PolicyRow {
  return {
    id: str(raw.id),
    workspaceId: str(raw.workspace_id),
    ownerUserId: str(raw.owner_user_id),
    status: str(raw.status) as PolicyStatus,
    terms: {
      ownerShareBps: int(raw.owner_share_bps),
      appliesTo: (str(raw.applies_to) === "all" ? "all" : "rent") as FeeAppliesTo,
      leasingFeeBps: int(raw.leasing_fee_bps),
      minFeeCents: int(raw.min_fee_cents),
      reserveTargetCents: int(raw.reserve_target_cents),
      repairApprovalThresholdCents: int(raw.repair_approval_threshold_cents),
    },
    effectiveFrom: str(raw.effective_from),
    endsOn: str(raw.ends_on) || null,
    sentAt: str(raw.sent_at) || null,
    signedAt: str(raw.signed_at) || null,
    acceptedVia: (str(raw.accepted_via) || null) as PolicyRow["acceptedVia"],
    termsSha256: str(raw.terms_sha256) || null,
    createdAt: str(raw.created_at),
  };
}

export async function loadPolicy(db: SupabaseClient, id: string): Promise<PolicyRow | null> {
  const { data, error } = await db.from("managed_workspace_fee_policies").select(POLICY_COLUMNS).eq("id", id.trim()).maybeSingle();
  if (error) {
    if (isMissingSchemaError(error)) return null;
    throw new PolicyError(500, "Could not load the fee policy.");
  }
  return data ? mapPolicyRow(data as Row) : null;
}

/**
 * The accepted policy that makes a workspace PropLane-managed, read fresh from the database. A pure read: a fee version
 * is activated by an admin's own action (Admin > Service, Admin > Managed finance) or by `ensureServiceFeePolicy` when a
 * service workspace has no policy at all, never as a side effect of settling a payment.
 *
 * With `onDate` the answer is the version IN FORCE THAT DAY - `effective_from <= onDate` and the version had not ended
 * yet - which is an ENDED row once a newer version has replaced it. A payment in flight across a rate change (an ACH
 * debit is days old by the time it settles) therefore settles on the split it was taken under, instead of answering
 * "not managed" and falling through to a manager hold. A schema that is not there yet (code runs before the migration)
 * is "not managed". A READ that fails is an error, never "not managed": crediting a managed workspace's rent to a
 * manager hold by mistake is the one outcome this feature must not allow.
 */
export async function loadActivePolicyForWorkspace(db: SupabaseClient, workspaceId: string, onDate?: string): Promise<PolicyRow | null> {
  const id = workspaceId.trim();
  if (!id) return null;
  const base = db.from("managed_workspace_fee_policies").select(POLICY_COLUMNS).eq("workspace_id", id).not("signed_at", "is", null);
  const { data, error } = onDate
    ? await base.in("status", ["active", "ended"]).lte("effective_from", onDate).order("effective_from", { ascending: false }).limit(20)
    : await base.eq("status", "active").limit(1);
  if (error) {
    if (isMissingSchemaError(error)) return null;
    throw new PolicyError(500, "Could not read the workspace fee policy.");
  }
  const rows = ((data ?? []) as Row[]).map(mapPolicyRow);
  if (!onDate) return rows[0] ?? null;
  // `ends_on` is the day the NEXT version started, so the window it covers is [effective_from, ends_on).
  return rows.find((r) => !r.endsOn || r.endsOn > onDate) ?? null;
}

export async function listPoliciesForWorkspace(db: SupabaseClient, workspaceId: string): Promise<PolicyRow[]> {
  const { data, error } = await db
    .from("managed_workspace_fee_policies")
    .select(POLICY_COLUMNS)
    .eq("workspace_id", workspaceId.trim())
    .order("created_at", { ascending: false })
    .limit(50);
  if (error) {
    if (isMissingSchemaError(error)) return [];
    throw new PolicyError(500, "Could not load fee policies.");
  }
  return ((data ?? []) as Row[]).map(mapPolicyRow);
}

export type OwnedManagedWorkspace = { workspaceId: string; policyId: string; status: PolicyStatus; workspaceName: string; terms: ManagedFeeTerms };

/** The managed workspaces a person is the owner of record of (active first, ended kept for history). */
export async function listManagedWorkspacesForOwner(db: SupabaseClient, ownerUserId: string): Promise<OwnedManagedWorkspace[]> {
  const { data, error } = await db
    .from("managed_workspace_fee_policies")
    .select(POLICY_COLUMNS)
    .eq("owner_user_id", ownerUserId)
    .in("status", ["active", "ended"])
    .not("signed_at", "is", null)
    .order("created_at", { ascending: false })
    .limit(100);
  if (error) {
    if (isMissingSchemaError(error)) return [];
    throw new PolicyError(500, "Could not load your workspaces.");
  }
  const seen = new Set<string>();
  const rows: PolicyRow[] = [];
  for (const raw of (data ?? []) as Row[]) {
    const row = mapPolicyRow(raw);
    // Newest signed version per workspace; an active one outranks an ended one.
    if (seen.has(row.workspaceId)) continue;
    seen.add(row.workspaceId);
    rows.push(row);
  }
  const ids = rows.map((r) => r.workspaceId);
  const { data: workspaces } = ids.length ? await db.from("portal_workspaces").select("id, name").in("id", ids) : { data: [] };
  const names = new Map(((workspaces ?? []) as Row[]).map((w) => [str(w.id), str(w.name)]));
  return rows.map((r) => ({ workspaceId: r.workspaceId, policyId: r.id, status: r.status, workspaceName: names.get(r.workspaceId) || "Your workspace", terms: r.terms }));
}

export type PolicyInput = { workspaceId: string; ownerUserId: string; terms: ManagedFeeTerms; effectiveFrom: string };

async function loadWorkspaceOwnerId(db: SupabaseClient, workspaceId: string): Promise<string | null> {
  const { data, error } = await db.from("portal_workspaces").select("id, owner_user_id").eq("id", workspaceId).maybeSingle();
  if (error || !data) return null;
  return str((data as Row).owner_user_id) || null;
}

/** Is this person an accepted member of the workspace? The owner of record must be (the invite section). */
export async function isWorkspaceMember(db: SupabaseClient, workspaceId: string, userId: string): Promise<boolean> {
  const { data, error } = await db
    .from("account_link_invites")
    .select("id")
    .eq("workspace_id", workspaceId)
    .eq("invitee_user_id", userId)
    .eq("status", "accepted")
    .limit(1);
  if (error) throw new PolicyError(500, "Could not check the workspace team.");
  return (data ?? []).length > 0;
}

/**
 * The platform service owner, read fail-closed: an unreadable settings row throws, because "not the service owner" is the
 * answer that would let PropLane's own account become an owner of record. A missing table or no row means none is set.
 */
async function loadPlatformServiceOwnerId(db: SupabaseClient): Promise<string | null> {
  const { data, error } = await db.from("platform_service_settings").select("owner_user_id").eq("singleton", true).maybeSingle();
  if (error) {
    if (isMissingSchemaError(error) || ["42P01", "42703", "PGRST204", "PGRST205"].includes(String(error.code))) return null;
    throw new PolicyError(500, SERVICE_OWNER_UNREADABLE);
  }
  return str((data as Row | null)?.owner_user_id) || null;
}

/**
 * May this person be the owner of record of the workspace? The workspace's own owner is the owner of record of a CLIENT-owned
 * (attached) workspace, never of one the platform service owner owns (that would pay PropLane its own owner share). Anyone else
 * must be an accepted member of the workspace team.
 */
export async function assertOwnerOfRecordAllowed(db: SupabaseClient, workspaceId: string, ownerUserId: string, workspaceOwner: string | null): Promise<void> {
  if (workspaceOwner && ownerUserId === workspaceOwner) {
    const serviceOwner = await loadPlatformServiceOwnerId(db);
    if (serviceOwner && serviceOwner === workspaceOwner) {
      throw new PolicyError(422, "The property owner must be a person added to the workspace, not its PropLane manager.");
    }
    return;
  }
  if (!(await isWorkspaceMember(db, workspaceId, ownerUserId))) throw new PolicyError(422, "Add the owner to the workspace team first.");
}

/** A policy starts on or before today: it is activated the moment it is accepted, and never dated ahead. */
function validateEffective(effectiveFrom: string, now: Date): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(effectiveFrom)) throw new PolicyError(400, "Choose a start date.");
  if (effectiveFrom > pacificDayKey(now)) {
    throw new PolicyError(400, "The start date cannot be in the future. A policy starts when it is accepted.");
  }
}

/**
 * `alongsideOpenDraft` is the automatic fee's doorway past the one-draft rule: a service workspace with no policy in
 * force must get its rate NOW (its residents cannot pay without one), and the admin's own draft is left where it is.
 */
export type DraftOptions = { alongsideOpenDraft?: boolean };

export async function createDraftPolicy(
  db: SupabaseClient,
  _admin: AdminActor,
  rawInput: PolicyInput,
  now: Date = new Date(),
  opts: DraftOptions = {},
): Promise<PolicyRow> {
  const input = { ...rawInput, ownerUserId: rawInput.ownerUserId.trim(), workspaceId: rawInput.workspaceId.trim() };
  const problem = validateManagedFeeTerms(input.terms);
  if (problem) throw new PolicyError(400, problem);
  validateEffective(input.effectiveFrom, now);
  const workspaceOwner = await loadWorkspaceOwnerId(db, input.workspaceId);
  if (!workspaceOwner) throw new PolicyError(404, "Workspace not found.");
  // PropLane's own account is never the owner of record (it would pay PropLane its own owner share); a client who owns an
  // attached workspace is.
  await assertOwnerOfRecordAllowed(db, input.workspaceId, input.ownerUserId, workspaceOwner);
  if (!opts.alongsideOpenDraft) {
    const open = (await listPoliciesForWorkspace(db, input.workspaceId)).find((p) => p.status === "draft");
    if (open) throw new PolicyError(409, "This workspace already has a draft fee policy. Edit or end it.");
  }
  const { data, error } = await db
    .from("managed_workspace_fee_policies")
    .insert({
      workspace_id: input.workspaceId,
      owner_user_id: input.ownerUserId,
      status: "draft",
      owner_share_bps: input.terms.ownerShareBps,
      applies_to: input.terms.appliesTo,
      leasing_fee_bps: input.terms.leasingFeeBps,
      min_fee_cents: input.terms.minFeeCents,
      reserve_target_cents: input.terms.reserveTargetCents,
      repair_approval_threshold_cents: input.terms.repairApprovalThresholdCents,
      effective_from: input.effectiveFrom,
    })
    .select(POLICY_COLUMNS)
    .single();
  if (error || !data) throw new PolicyError(500, "Could not save the fee policy.");
  return mapPolicyRow(data as Row);
}

export async function updateDraftPolicy(
  db: SupabaseClient,
  _admin: AdminActor,
  id: string,
  patch: Partial<Pick<PolicyInput, "terms" | "effectiveFrom" | "ownerUserId">>,
  now: Date = new Date(),
): Promise<PolicyRow> {
  const current = await loadPolicy(db, id);
  if (!current) throw new PolicyError(404, "Fee policy not found.");
  if (current.status !== "draft") throw new PolicyError(409, "An accepted fee policy cannot be edited. Draft a new version.");
  const terms = patch.terms ?? current.terms;
  const ownerUserId = (patch.ownerUserId ?? current.ownerUserId).trim();
  const effectiveFrom = patch.effectiveFrom ?? current.effectiveFrom;
  const problem = validateManagedFeeTerms(terms);
  if (problem) throw new PolicyError(400, problem);
  validateEffective(effectiveFrom, now);
  if (ownerUserId !== current.ownerUserId) {
    await assertOwnerOfRecordAllowed(db, current.workspaceId, ownerUserId, await loadWorkspaceOwnerId(db, current.workspaceId));
  }
  const { data, error } = await db
    .from("managed_workspace_fee_policies")
    .update({
      owner_user_id: ownerUserId,
      owner_share_bps: terms.ownerShareBps,
      applies_to: terms.appliesTo,
      leasing_fee_bps: terms.leasingFeeBps,
      min_fee_cents: terms.minFeeCents,
      reserve_target_cents: terms.reserveTargetCents,
      repair_approval_threshold_cents: terms.repairApprovalThresholdCents,
      effective_from: effectiveFrom,
      // Nothing is ever sent for signature any more; an edit clears a legacy row's stamp so no state reads as "waiting".
      sent_at: null,
      updated_at: now.toISOString(),
    })
    .eq("id", current.id)
    .eq("status", "draft")
    .select(POLICY_COLUMNS)
    .maybeSingle();
  if (error || !data) throw new PolicyError(409, "The fee policy changed. Reload and try again.");
  return mapPolicyRow(data as Row);
}

/** Accept a draft: an admin records it, or PropLane Service activates it automatically. One atomic database function. */
async function activate(
  db: SupabaseClient,
  policy: PolicyRow,
  via: "admin_attested",
  role: "admin" | "system",
  note: string | null,
): Promise<PolicyRow> {
  const canonical = canonicalPolicyTerms({ workspaceId: policy.workspaceId, ownerUserId: policy.ownerUserId, terms: policy.terms, effectiveFrom: policy.effectiveFrom });
  const hash = policyTermsSha256(canonical);

  const { data, error } = await db.rpc("activate_managed_policy", {
    p_id: policy.id,
    p_via: via,
    p_note: note,
    p_hash: hash,
    p_snapshot: JSON.parse(canonical) as Record<string, unknown>,
    p_actor_role: role,
  });
  const result = data as { status?: string; reason?: string } | null;
  if (error) {
    if (String(error.code) === "23505") throw new PolicyError(409, "Another fee policy is already active for this workspace.");
    throw new PolicyError(500, "Could not accept the fee policy.");
  }
  if (!result || (result.status !== "active" && result.status !== "exists")) {
    // `terms_changed`: the row's own fee terms no longer match the ones this activation was taken against (the draft
    // was edited after it was loaded). The function compares them under its row lock, so this is the only safe answer.
    if (result?.reason === "terms_changed") {
      throw new PolicyError(409, "This fee policy changed. Reload it and read the new terms.");
    }
    throw new PolicyError(409, result?.reason === "future_effective_from" ? "The start date is in the future." : "This fee policy cannot be accepted any more.");
  }
  const fresh = await loadPolicy(db, policy.id);
  if (!fresh || fresh.status !== "active") throw new PolicyError(500, "The fee policy was not recorded.");
  return fresh;
}

/** The policy's owner of record is still seated: the workspace's own (client) owner, or an accepted team member. */
async function assertCurrentOwnerSeated(db: SupabaseClient, policy: PolicyRow): Promise<void> {
  try {
    await assertOwnerOfRecordAllowed(db, policy.workspaceId, policy.ownerUserId, await loadWorkspaceOwnerId(db, policy.workspaceId));
  } catch (e) {
    if (e instanceof PolicyError && e.status === 422) throw new PolicyError(422, "This person is no longer on the workspace team.");
    throw e;
  }
}

/** SHA-256 of the canonical fee terms of a policy as it stands: what an activation is recorded against. */
export function policyTermsHash(policy: PolicyRow): string {
  return policyTermsSha256(
    canonicalPolicyTerms({ workspaceId: policy.workspaceId, ownerUserId: policy.ownerUserId, terms: policy.terms, effectiveFrom: policy.effectiveFrom }),
  );
}

/** An admin records that a signed contract is on file (offline). A note of at least 8 characters is required. */
export async function attestPolicy(db: SupabaseClient, _admin: AdminActor, id: string, note: string): Promise<PolicyRow> {
  const trimmed = note.trim();
  if (trimmed.length < 8) throw new PolicyError(400, "Say where the signed contract is kept (at least a few words).");
  const current = await loadPolicy(db, id);
  if (!current) throw new PolicyError(404, "Fee policy not found.");
  if (current.status === "active") return current;
  if (current.status !== "draft") throw new PolicyError(409, "Only a draft can be recorded.");
  await assertCurrentOwnerSeated(db, current);
  return activate(db, current, "admin_attested", "admin", trimmed.slice(0, 300));
}

export async function endPolicy(db: SupabaseClient, _admin: AdminActor, id: string, now: Date = new Date()): Promise<PolicyRow> {
  const current = await loadPolicy(db, id);
  if (!current) throw new PolicyError(404, "Fee policy not found.");
  if (current.status === "ended") return current;
  const today = pacificDayKey(now);
  const { data, error } = await db
    .from("managed_workspace_fee_policies")
    .update({
      status: "ended",
      ended_at: now.toISOString(),
      ended_by_role: "admin",
      ends_on: today >= current.effectiveFrom ? today : current.effectiveFrom,
      updated_at: now.toISOString(),
    })
    .eq("id", current.id)
    .in("status", ["draft", "active"])
    .select(POLICY_COLUMNS)
    .maybeSingle();
  if (error || !data) throw new PolicyError(409, "The fee policy changed. Reload and try again.");
  return mapPolicyRow(data as Row);
}

/** The owner's own preferences, editable after signing (not fee terms, so outside the signed hash). */
export async function setOwnerPreferences(
  db: SupabaseClient,
  ownerUserId: string,
  id: string,
  prefs: { repairApprovalThresholdCents?: number; reserveTargetCents?: number },
): Promise<PolicyRow> {
  const current = await loadPolicy(db, id);
  if (!current || current.ownerUserId !== ownerUserId) throw new PolicyError(404, "Fee policy not found.");
  if (current.status === "ended") throw new PolicyError(409, "This agreement has ended.");
  const next: ManagedFeeTerms = {
    ...current.terms,
    repairApprovalThresholdCents: prefs.repairApprovalThresholdCents ?? current.terms.repairApprovalThresholdCents,
    reserveTargetCents: prefs.reserveTargetCents ?? current.terms.reserveTargetCents,
  };
  const problem = validateManagedFeeTerms(next);
  if (problem) throw new PolicyError(400, problem);
  const { data, error } = await db
    .from("managed_workspace_fee_policies")
    .update({
      repair_approval_threshold_cents: next.repairApprovalThresholdCents,
      reserve_target_cents: next.reserveTargetCents,
      updated_at: new Date().toISOString(),
    })
    .eq("id", current.id)
    .eq("owner_user_id", ownerUserId)
    .in("status", ["draft", "active"])
    .select(POLICY_COLUMNS)
    .maybeSingle();
  if (error || !data) throw new PolicyError(409, "The fee policy changed. Reload and try again.");
  return mapPolicyRow(data as Row);
}

// ---------------------------------------------------------------------------------------------------------------------
// The automatic management fee. A PropLane Service workspace needs no signature: it carries an ACTIVE, admin-attested
// policy created for it the first time anything needs one (attach, create, a checkout, a hold release), and an admin's
// rate change in Admin > Service is a new version activated at once. docs/agents/owner-management.md.
// ---------------------------------------------------------------------------------------------------------------------

export const AUTO_FEE_NOTE = "Automatic PropLane management fee";
/** Recorded on the version an admin's rate change activates, so the history says where the rate came from. */
export const FEE_CHANGE_NOTE = "PropLane management fee changed in Admin > Service";

export const DEFAULT_MANAGEMENT_FEE_TERMS: ManagedFeeTerms = {
  ownerShareBps: 10_000 - DEFAULT_MANAGEMENT_FEE_PERCENT * 100,
  appliesTo: "rent",
  leasingFeeBps: 0,
  minFeeCents: 0,
  reserveTargetCents: 0,
  repairApprovalThresholdCents: 25_000,
};

export type FeeActor = AdminActor | { role: "system" };

/** Why the automatic fee could not be put in place. Carried to the admin attention item and the log, never collapsed. */
export type EnsureFeeFailure = FeeFlagCause;

/** Draft the terms, activate them, and never leave a stray draft behind if the activation refuses. */

export type EnsureServiceFeePolicyResult =
  | { status: "exists"; policy: PolicyRow }
  | { status: "created"; policy: PolicyRow }
  | { status: "not_service" }
  | { status: "unavailable"; reason: EnsureFeeFailure };

const OWNER_UNREADABLE = "Could not read the workspace owner of record.";
const SERVICE_OWNER_UNREADABLE = "Could not check the PropLane service owner.";

/** Which failure a thrown error is. A read that blinked is not the same answer as "this workspace has no owner". */
function feeFailureReason(error: unknown, fallback: EnsureFeeFailure): EnsureFeeFailure {
  if (!(error instanceof PolicyError)) return fallback;
  if (error.status === 422) return "no_owner";
  if (error.status === 500 && (error.message === OWNER_UNREADABLE || error.message === SERVICE_OWNER_UNREADABLE)) return "owner_unreadable";
  return fallback;
}

/**
 * Every failure of the automatic fee reaches an operator the same way: a reason code in the log AND the attention item
 * in Admin > Finances > Flags. Nothing here is ever only a console line - a workspace whose rent is paused has to be
 * visible somewhere an admin looks.
 */
async function feeUnavailable(
  db: SupabaseClient,
  workspaceId: string,
  workspaceName: string | null,
  reason: EnsureFeeFailure,
  error?: unknown,
): Promise<EnsureServiceFeePolicyResult> {
  const detail = error instanceof PolicyError ? `${error.status}:${error.message}` : error instanceof Error ? error.name : "";
  console.error("[managed-fee]", JSON.stringify({ workspaceId, reason, detail }));
  await flagManagedFeeProblem(db, { workspaceId, workspaceName, cause: reason, reason: "fee_unavailable" });
  return { status: "unavailable", reason };
}

/**
 * The owner of record of a service workspace: its client owner when attached, else the team member flagged as one.
 * Fail closed - with no `platform_service_settings` row there is no way to tell a client's workspace from PropLane's
 * own, and naming PropLane would pay PropLane its own owner share, so the answer is "none".
 */
async function resolveOwnerOfRecord(db: SupabaseClient, workspaceId: string, workspaceOwner: string): Promise<string | null> {
  const serviceOwner = await loadPlatformServiceOwnerId(db);
  if (!serviceOwner) return null;
  if (serviceOwner !== workspaceOwner) return workspaceOwner;
  const { data, error } = await db
    .from("account_link_invites")
    .select("invitee_user_id")
    .eq("workspace_id", workspaceId)
    .eq("is_owner_of_record", true)
    .eq("status", "accepted")
    .limit(1);
  if (error) throw new PolicyError(500, OWNER_UNREADABLE);
  return str(((data ?? []) as Row[])[0]?.invitee_user_id) || null;
}

/** The workspace's open draft: a fee version an admin set up in Admin > Managed finance and has not recorded yet. */
async function openDraftForWorkspace(db: SupabaseClient, workspaceId: string): Promise<PolicyRow | null> {
  return (await listPoliciesForWorkspace(db, workspaceId)).find((p) => p.status === "draft") ?? null;
}

function adminOf(actor: FeeActor): AdminActor {
  return { role: "admin", userId: actor.role === "admin" ? actor.userId : "system" };
}

/**
 * Draft the terms and activate them in one step. `activate_managed_policy` ends the previous version atomically, and a
 * refused activation takes its own draft back out rather than leaving one lying next to an admin's.
 */
async function activateNewVersion(
  db: SupabaseClient,
  actor: FeeActor,
  input: { workspaceId: string; ownerUserId: string; terms: ManagedFeeTerms },
  note: string,
  now: Date,
): Promise<PolicyRow> {
  const admin = adminOf(actor);
  const draft = await createDraftPolicy(
    db,
    admin,
    { workspaceId: input.workspaceId, ownerUserId: input.ownerUserId, terms: input.terms, effectiveFrom: pacificDayKey(now) },
    now,
    { alongsideOpenDraft: true },
  );
  try {
    return await activate(db, draft, "admin_attested", actor.role === "admin" ? "admin" : "system", note);
  } catch (e) {
    await endPolicy(db, admin, draft.id, now).catch(() => undefined);
    throw e;
  }
}

/**
 * Every PropLane Service workspace has a management fee that applies on its own. Idempotent, and it never touches an
 * admin's work: a policy in force is left exactly as it is, and with none in force the default (PropLane keeps 10% of
 * rent) is created and activated, admin-attested, no signature. A draft open in Admin > Managed finance does NOT hold
 * rent up - rent must flow - so the default is activated beside it and the draft is left exactly where it is; recording
 * that draft later ends the default through the ordinary activation path.
 *
 * The owner of record is the workspace's owner when a client owns it (attached), or its flagged owner-of-record member
 * when the service owner does. Only a missing owner of record or an unreadable row keeps rent paused. Never throws:
 * every failure answers `unavailable` with a reason that is logged AND flagged, and the callers' fail-closed refusal /
 * hold freeze stays in force.
 */
export async function ensureServiceFeePolicy(
  db: SupabaseClient,
  workspaceId: string,
  actor: FeeActor = { role: "system" },
  now: Date = new Date(),
): Promise<EnsureServiceFeePolicyResult> {
  const id = workspaceId.trim();
  if (!id) return { status: "not_service" };
  let name: string | null = null;
  try {
    const active = await loadActivePolicyForWorkspace(db, id);
    if (active) return { status: "exists", policy: active };
    const { data, error } = await db.from("portal_workspaces").select("id, name, owner_user_id, is_service").eq("id", id).maybeSingle();
    if (error) {
      if (isMissingSchemaError(error)) return { status: "not_service" };
      return feeUnavailable(db, id, null, "workspace_unreadable", error);
    }
    const ws = data as Row | null;
    if (!ws || ws.is_service !== true) return { status: "not_service" };
    name = str(ws.name) || null;
    try {
      const workspaceOwner = str(ws.owner_user_id);
      const ownerUserId = workspaceOwner ? await resolveOwnerOfRecord(db, id, workspaceOwner) : null;
      if (!ownerUserId) return feeUnavailable(db, id, name, "no_owner");
      const policy = await activateNewVersion(db, actor, { workspaceId: id, ownerUserId, terms: { ...DEFAULT_MANAGEMENT_FEE_TERMS } }, AUTO_FEE_NOTE, now);
      return { status: "created", policy };
    } catch (e) {
      // A concurrent request may have created it first (one active policy per workspace): that is the answer.
      const raced = await loadActivePolicyForWorkspace(db, id).catch(() => null);
      if (raced) return { status: "exists", policy: raced };
      return feeUnavailable(db, id, name, feeFailureReason(e, "activation_refused"), e);
    }
  } catch (e) {
    return feeUnavailable(db, id, name, feeFailureReason(e, "read_failed"), e);
  }
}

export type ServiceManagementFee = {
  /** The rate in force after this call. */
  feePercent: number;
  /** Whether this call moved the rate. A rate that was already in force is left exactly as it is. */
  changed: boolean;
  policyId: string;
};

export const HAND_AUTHORED_DRAFT_MESSAGE =
  "This workspace has a fee policy draft in Admin > Managed finance. Record or end it there first.";

/**
 * Admin changes a service workspace's management fee. The new rate is a new policy version activated NOW - the one
 * atomic database function ends the previous one in the same transaction - so it applies to every payment settled from
 * this moment on, while a payment taken earlier settles on the version in force that day
 * (`loadActivePolicyForWorkspace` resolves the window). Only the fee share moves: the owner of record and every other
 * term are copied from the version it replaces. A draft open in Admin > Managed finance is left untouched and the rate
 * change is refused: that draft holds terms a rate box cannot see.
 */
export async function setServiceManagementFee(
  db: SupabaseClient,
  admin: AdminActor,
  workspaceId: string,
  percent: unknown,
  now: Date = new Date(),
): Promise<ServiceManagementFee> {
  const ownerShareBps = ownerShareBpsForFeePercent(percent);
  if (ownerShareBps === null) throw new PolicyError(400, MANAGEMENT_FEE_RANGE_MESSAGE);
  const ensured = await ensureServiceFeePolicy(db, workspaceId, admin, now);
  if (ensured.status !== "exists" && ensured.status !== "created") {
    if (ensured.status === "not_service") throw new PolicyError(404, "Service workspace not found.");
    throw new PolicyError(409, ensured.reason === "no_owner" ? "Name the workspace's owner of record first." : "Could not read the workspace fee. Try again.");
  }
  const current = ensured.policy;
  if (current.terms.ownerShareBps === ownerShareBps) {
    // A first policy is a change even at the default rate: the workspace went from no fee to one in force today.
    return { feePercent: feePercentForOwnerShareBps(ownerShareBps), changed: ensured.status === "created", policyId: current.id };
  }
  if (await openDraftForWorkspace(db, current.workspaceId)) throw new PolicyError(409, HAND_AUTHORED_DRAFT_MESSAGE);
  const next = await activateNewVersion(
    db,
    admin,
    { workspaceId: current.workspaceId, ownerUserId: current.ownerUserId, terms: { ...current.terms, ownerShareBps } },
    FEE_CHANGE_NOTE,
    now,
  );
  return { feePercent: feePercentForOwnerShareBps(next.terms.ownerShareBps), changed: true, policyId: next.id };
}

/** The rate in force for one workspace, or null when it has no policy at all. */
export async function readServiceManagementFee(db: SupabaseClient, workspaceId: string): Promise<ServiceManagementFee | null> {
  const active = await loadActivePolicyForWorkspace(db, workspaceId);
  if (!active) return null;
  return { feePercent: feePercentForOwnerShareBps(active.terms.ownerShareBps), changed: false, policyId: active.id };
}
