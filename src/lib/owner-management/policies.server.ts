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
  nextFeeEffectiveFrom,
  ownerShareBpsForFeePercent,
} from "@/lib/owner-management/fee-percent";

/**
 * Fee policies of PropLane-managed workspaces. Only a platform admin creates, attests or ends one (the fee is PropLane's
 * revenue); nobody signs one (there is no fee-agreement signature anywhere in the product); and a change is a new draft
 * version that ends the old one when it is activated, atomically (`activate_managed_policy`).
 */

export { DEFAULT_MANAGEMENT_FEE_PERCENT, MAX_MANAGEMENT_FEE_PERCENT, nextFeeEffectiveFrom, ownerShareBpsForFeePercent };

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
  /** Free text on the row: on a DRAFT it is the source marker that says which path authored it. */
  attestationNote: string | null;
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
  "id, workspace_id, owner_user_id, status, owner_share_bps, applies_to, leasing_fee_bps, min_fee_cents, reserve_target_cents, repair_approval_threshold_cents, effective_from, ends_on, sent_at, signed_at, accepted_via, attestation_note, terms_sha256, created_at";

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
    attestationNote: str(raw.attestation_note) || null,
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
 * The fee policy IN FORCE for a workspace, read fresh from the database, and the one place a scheduled version becomes
 * the live one. Every settle / checkout / hold path reads the policy through here, so a rate change dated the 1st of a
 * month takes effect on the first read on or after that Pacific day: the version is activated and the previous one is
 * ended at the same date, in the one atomic database function (`activate_managed_policy`, idempotent under concurrency
 * - a racing caller gets `exists`). Due-ness is a PACIFIC day comparison; `onDate` only filters the answer as-of.
 *
 * A schema that is not there yet (code runs before the migration) is "not managed". A READ that fails is an error, never
 * "not managed": crediting a managed workspace's rent to a manager hold by mistake is the one outcome this must not allow.
 */
export async function loadActivePolicyForWorkspace(
  db: SupabaseClient,
  workspaceId: string,
  onDate?: string,
  now: Date = new Date(),
): Promise<PolicyRow | null> {
  const id = workspaceId.trim();
  if (!id) return null;
  const { data, error } = await db
    .from("managed_workspace_fee_policies")
    .select(POLICY_COLUMNS)
    .eq("workspace_id", id)
    .in("status", ["active", "draft"])
    .order("created_at", { ascending: false })
    .limit(20);
  if (error) {
    if (isMissingSchemaError(error)) return null;
    throw new PolicyError(500, "Could not read the workspace fee policy.");
  }
  const rows = ((data ?? []) as Row[]).map(mapPolicyRow);
  const active = rows.find((r) => r.status === "active" && r.signedAt) ?? null;
  const due = rows.find((r) => r.status === "draft" && r.effectiveFrom <= pacificDayKey(now)) ?? null;
  // Without an active policy the workspace is not managed at all; `ensureServiceFeePolicy` owns that case (it has to
  // decide an owner of record), so a read never creates the first policy.
  const row = active && due ? (await startScheduledVersion(db, active, due)) ?? active : active;
  if (!row) return null;
  if (onDate && row.effectiveFrom > onDate) return null;
  return row;
}

/**
 * Put a due scheduled version in force. Never throws: a version that cannot start leaves the rate already in force
 * running (refusing rent over a fee change would be worse than charging yesterday's rate for another read).
 */
async function startScheduledVersion(db: SupabaseClient, previous: PolicyRow, due: PolicyRow): Promise<PolicyRow | null> {
  try {
    const started = await activate(db, due, "admin_attested", "system", scheduledStartNote(due));
    await endPreviousOn(db, previous, due.effectiveFrom);
    return started;
  } catch (e) {
    logFeeFailure(due.workspaceId, "scheduled_start_refused", e);
    return null;
  }
}

/**
 * The version that just ended stops the day the new one starts. `activate_managed_policy` stamps `ends_on` with the day
 * it RAN, which is the same day when the first read lands on the 1st and a day or two later when nothing was read until
 * then. Best effort: the history reads right, and nothing prices off `ends_on`.
 */
async function endPreviousOn(db: SupabaseClient, previous: PolicyRow, endsOn: string): Promise<void> {
  const day = endsOn >= previous.effectiveFrom ? endsOn : previous.effectiveFrom;
  try {
    await db.from("managed_workspace_fee_policies").update({ ends_on: day }).eq("id", previous.id).eq("status", "ended");
  } catch {
    /* history detail must never fail the money path that corrected it */
  }
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

/**
 * A start date a policy may carry. A fee VERSION is scheduled for the 1st of a later Pacific month (a rate must never
 * reach rent already collected), so `allowFutureStart` is how that path says so; every hand-authored draft still starts
 * on or before today, because it is activated the moment it is accepted.
 */
function validateEffective(effectiveFrom: string, now: Date, allowFutureStart = false): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(effectiveFrom)) throw new PolicyError(400, "Choose a start date.");
  if (!allowFutureStart && effectiveFrom > pacificDayKey(now)) {
    throw new PolicyError(400, "The start date cannot be in the future. A policy starts when it is accepted.");
  }
}

export type DraftOptions = {
  allowFutureStart?: boolean;
  /** Written to `attestation_note`: which path authored this draft, so only that path may edit or cancel it. */
  note?: string | null;
};

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
  validateEffective(input.effectiveFrom, now, opts.allowFutureStart);
  const workspaceOwner = await loadWorkspaceOwnerId(db, input.workspaceId);
  if (!workspaceOwner) throw new PolicyError(404, "Workspace not found.");
  // PropLane's own account is never the owner of record (it would pay PropLane its own owner share); a client who owns an
  // attached workspace is.
  await assertOwnerOfRecordAllowed(db, input.workspaceId, input.ownerUserId, workspaceOwner);
  const open = (await listPoliciesForWorkspace(db, input.workspaceId)).find((p) => p.status === "draft");
  if (open) throw new PolicyError(409, "This workspace already has a draft fee policy. Edit or end it.");
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
      ...(opts.note === undefined ? {} : { attestation_note: opts.note }),
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
  opts: DraftOptions = {},
): Promise<PolicyRow> {
  const current = await loadPolicy(db, id);
  if (!current) throw new PolicyError(404, "Fee policy not found.");
  if (current.status !== "draft") throw new PolicyError(409, "An accepted fee policy cannot be edited. Draft a new version.");
  const terms = patch.terms ?? current.terms;
  const ownerUserId = (patch.ownerUserId ?? current.ownerUserId).trim();
  const effectiveFrom = patch.effectiveFrom ?? current.effectiveFrom;
  const problem = validateManagedFeeTerms(terms);
  if (problem) throw new PolicyError(400, problem);
  validateEffective(effectiveFrom, now, opts.allowFutureStart);
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
      ...(opts.note === undefined ? {} : { attestation_note: opts.note }),
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
// rate change is a NEW version scheduled for the 1st of the next Pacific month. docs/agents/owner-management.md.
// ---------------------------------------------------------------------------------------------------------------------

export const AUTO_FEE_NOTE = "Automatic PropLane management fee";
/** An admin's own draft activated by the automatic path: its rate, never the default, and never ended behind their back. */
export const AUTO_ACTIVATE_DRAFT_NOTE = "PropLane Service activated the admin fee version";
/**
 * The source marker a scheduled rate change carries while it waits on its date. Admin > Service may edit or cancel a
 * draft that carries it and NOTHING else: a draft hand-authored in Admin > Managed finance holds terms (a leasing fee,
 * a monthly minimum, a reserve) that a rate box knows nothing about, and overwriting them silently is a money change.
 */
export const SCHEDULED_FEE_NOTE = "Scheduled PropLane management fee change";

/** Recorded on the version as it starts, so the history says when it was due and when it actually began. */
function scheduledStartNote(due: PolicyRow): string {
  return `${SCHEDULED_FEE_NOTE} started on its date ${due.effectiveFrom}`;
}

/** A version pulled forward because the workspace had NO policy in force: the date it was due is kept on the row. */
function pulledForwardNote(due: PolicyRow, startedOn: string): string {
  return `${AUTO_ACTIVATE_DRAFT_NOTE} on ${startedOn}, pulled forward from ${due.effectiveFrom} (no fee policy was in force)`;
}

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
export type EnsureFeeFailure =
  | "no_owner"
  | "workspace_unreadable"
  | "owner_unreadable"
  | "activation_refused"
  | "scheduled_start_refused"
  | "read_failed";

export type EnsureServiceFeePolicyResult =
  | { status: "exists"; policy: PolicyRow }
  | { status: "created"; policy: PolicyRow }
  | { status: "not_service" }
  | { status: "unavailable"; reason: EnsureFeeFailure };

/** One line per failure, with the reason code the flag also carries: a bug here must never read as "name an owner". */
function logFeeFailure(workspaceId: string, reason: EnsureFeeFailure, error?: unknown): void {
  const detail = error instanceof PolicyError ? `${error.status}:${error.message}` : error instanceof Error ? error.name : "";
  console.error("[managed-fee]", JSON.stringify({ workspaceId, reason, detail }));
}

/** A rate moved for a reason an operator may need to explain later. Not a failure, but never silent either. */
function logFeeEvent(workspaceId: string, reason: "pulled_forward", detail: string): void {
  console.warn("[managed-fee]", JSON.stringify({ workspaceId, reason, detail }));
}

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

/** The workspace's open draft: the fee version an admin set up (or scheduled) and that is not in force yet. */
async function openDraftForWorkspace(db: SupabaseClient, workspaceId: string): Promise<PolicyRow | null> {
  return (await listPoliciesForWorkspace(db, workspaceId)).find((p) => p.status === "draft") ?? null;
}

function adminOf(actor: FeeActor): AdminActor {
  return { role: "admin", userId: actor.role === "admin" ? actor.userId : "system" };
}

/**
 * Activate a draft on a workspace with NO policy in force, keeping ITS rate. A version dated ahead is pulled forward to
 * today rather than leaving the workspace unmanaged (its residents cannot pay at all until a rate exists) - the only
 * place a rate still starts mid-month, logged and recorded on the row with the date it was due. A workspace that HAS a
 * policy never comes through here: there the scheduled version waits for its own day (`startScheduledVersion`).
 */
async function activateDraftWithoutPolicyInForce(db: SupabaseClient, actor: FeeActor, draft: PolicyRow, now: Date): Promise<PolicyRow> {
  const today = pacificDayKey(now);
  const pulledForward = draft.effectiveFrom > today;
  const note = pulledForward ? pulledForwardNote(draft, today) : AUTO_ACTIVATE_DRAFT_NOTE;
  const dated = pulledForward
    ? await updateDraftPolicy(db, adminOf(actor), draft.id, { effectiveFrom: today }, now, { note })
    : draft;
  await assertCurrentOwnerSeated(db, dated);
  if (pulledForward) logFeeEvent(draft.workspaceId, "pulled_forward", note);
  return activate(db, dated, "admin_attested", actor.role === "admin" ? "admin" : "system", note);
}

/**
 * Every PropLane Service workspace has a management fee that applies on its own. Idempotent, and it never discards an
 * admin's work:
 *   * a policy in force -> left exactly as it is (a scheduled version takes over on its own day inside
 *     `loadActivePolicyForWorkspace`, which every settle path reads, not here);
 *   * no policy in force but a draft -> THAT draft is activated, at its own rate, never replaced by the default;
 *   * neither -> the default (PropLane keeps 10% of rent) is created and activated, admin-attested, no signature.
 * The owner of record is the workspace's owner when a client owns it (attached), or its flagged owner-of-record member
 * when the service owner does. Never throws: every failure answers `unavailable` with a reason the caller flags and
 * logs, and the callers' fail-closed refusal / hold freeze stays in force.
 */
export async function ensureServiceFeePolicy(
  db: SupabaseClient,
  workspaceId: string,
  actor: FeeActor = { role: "system" },
  now: Date = new Date(),
): Promise<EnsureServiceFeePolicyResult> {
  const id = workspaceId.trim();
  if (!id) return { status: "not_service" };
  try {
    // The resolver starts a due scheduled version on the way past, so `active` is already the rate in force today.
    const active = await loadActivePolicyForWorkspace(db, id, undefined, now);
    if (active) return { status: "exists", policy: active };
    const draft = await openDraftForWorkspace(db, id);
    const { data, error } = await db.from("portal_workspaces").select("id, owner_user_id, is_service").eq("id", id).maybeSingle();
    if (error) {
      if (isMissingSchemaError(error)) return { status: "not_service" };
      logFeeFailure(id, "workspace_unreadable", error);
      return { status: "unavailable", reason: "workspace_unreadable" };
    }
    const ws = data as Row | null;
    if (!ws || ws.is_service !== true) return { status: "not_service" };
    try {
      if (draft) return { status: "created", policy: await activateDraftWithoutPolicyInForce(db, actor, draft, now) };
      const workspaceOwner = str(ws.owner_user_id);
      const ownerUserId = workspaceOwner ? await resolveOwnerOfRecord(db, id, workspaceOwner) : null;
      if (!ownerUserId) {
        logFeeFailure(id, "no_owner");
        return { status: "unavailable", reason: "no_owner" };
      }
      const fresh = await createDraftPolicy(db, adminOf(actor), { workspaceId: id, ownerUserId, terms: { ...DEFAULT_MANAGEMENT_FEE_TERMS }, effectiveFrom: pacificDayKey(now) }, now, { note: AUTO_FEE_NOTE });
      return { status: "created", policy: await activate(db, fresh, "admin_attested", actor.role === "admin" ? "admin" : "system", AUTO_FEE_NOTE) };
    } catch (e) {
      // A concurrent request may have created it first (one active policy per workspace): that is the answer.
      const raced = await loadActivePolicyForWorkspace(db, id, undefined, now).catch(() => null);
      if (raced) return { status: "exists", policy: raced };
      const reason = feeFailureReason(e, "activation_refused");
      logFeeFailure(id, reason, e);
      return { status: "unavailable", reason };
    }
  } catch (e) {
    const reason = feeFailureReason(e, "read_failed");
    logFeeFailure(id, reason, e);
    return { status: "unavailable", reason };
  }
}

export type ServiceManagementFee = {
  /** The rate in force today. */
  feePercent: number;
  /** The rate that takes over, and the Pacific day it does, when a change is waiting on its date. */
  scheduled: { feePercent: number; effectiveFrom: string; policyId: string } | null;
  policyId: string;
};

export const HAND_AUTHORED_DRAFT_MESSAGE =
  "This workspace has a fee policy draft in Admin > Managed finance. Record or end it there first.";

/** The scheduled rate change this surface authored, and only that: a hand-authored draft is someone else's work. */
function scheduledChangeOf(draft: PolicyRow | null): PolicyRow | null {
  return draft && (draft.attestationNote ?? "").startsWith(SCHEDULED_FEE_NOTE) ? draft : null;
}

/**
 * Admin changes a service workspace's management fee. The new rate is a NEW policy version dated the 1st of the next
 * Pacific month and left as a draft until then: `targetMonthlyFeeCents` applies the policy in force to the whole Pacific
 * month's collected rent, so activating a change mid-month would re-price rent the owner was already paid for.
 * `loadActivePolicyForWorkspace` - which every settle path reads - puts that version in force on its day, ending the old
 * one in one transaction. Entering the rate already in force cancels a scheduled change. A draft this surface did not
 * author is refused, never edited or ended: it carries terms a rate box cannot see.
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
  const inForce = feePercentForOwnerShareBps(current.terms.ownerShareBps);
  // Only a version dated ahead of today can still be open here: a due one is already in force.
  const open = await openDraftForWorkspace(db, current.workspaceId);
  if (open && !scheduledChangeOf(open)) throw new PolicyError(409, HAND_AUTHORED_DRAFT_MESSAGE);
  const pending = scheduledChangeOf(open);
  if (current.terms.ownerShareBps === ownerShareBps) {
    // Back to the rate already in force: the admin is cancelling their own scheduled change, not ending a live policy.
    if (pending) await endPolicy(db, admin, pending.id, now);
    return { feePercent: inForce, scheduled: null, policyId: current.id };
  }
  const terms: ManagedFeeTerms = { ...current.terms, ownerShareBps };
  const effectiveFrom = nextFeeEffectiveFrom(now);
  const opts = { allowFutureStart: true, note: SCHEDULED_FEE_NOTE };
  const next = pending
    ? await updateDraftPolicy(db, admin, pending.id, { terms, effectiveFrom }, now, opts)
    : await createDraftPolicy(db, admin, { workspaceId: current.workspaceId, ownerUserId: current.ownerUserId, terms, effectiveFrom }, now, opts);
  return {
    feePercent: inForce,
    scheduled: { feePercent: feePercentForOwnerShareBps(next.terms.ownerShareBps), effectiveFrom: next.effectiveFrom, policyId: next.id },
    policyId: current.id,
  };
}

/** The rate in force and any scheduled change, for one workspace. Null when the workspace has no policy at all. */
export async function readServiceManagementFee(
  db: SupabaseClient,
  workspaceId: string,
  now: Date = new Date(),
): Promise<ServiceManagementFee | null> {
  const active = await loadActivePolicyForWorkspace(db, workspaceId, undefined, now);
  if (!active) return null;
  const pending = scheduledChangeOf(await openDraftForWorkspace(db, workspaceId));
  return {
    feePercent: feePercentForOwnerShareBps(active.terms.ownerShareBps),
    scheduled:
      pending && pending.effectiveFrom > pacificDayKey(now)
        ? { feePercent: feePercentForOwnerShareBps(pending.terms.ownerShareBps), effectiveFrom: pending.effectiveFrom, policyId: pending.id }
        : null,
    policyId: active.id,
  };
}
