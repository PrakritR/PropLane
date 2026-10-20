import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { resolveEmailLinkBaseUrl } from "@/lib/app-url";
import { pacificDayKey } from "@/lib/house-groups/time";
import { sendManagerNoticeEmail } from "@/lib/manager-notice-email.server";
import { isMissingSchemaError } from "@/lib/one-number/config.server";
import { portalSignInHref } from "@/lib/one-number/link-destinations.server";
import { sendWorkspacePhoneText } from "@/lib/one-number/link-text.server";
import {
  canonicalPolicyTerms,
  describeManagedFee,
  policyTermsSha256,
  validateManagedFeeTerms,
  type FeeAppliesTo,
  type ManagedFeeTerms,
} from "@/lib/owner-management/fee-math";

/**
 * Fee policies of PropLane-managed workspaces. Only a platform admin creates, attests or ends one (the fee is PropLane's
 * revenue); only the named owner of record signs one; a signed policy is immutable (migration trigger) and a change is a
 * new draft version that ends the old one when accepted, atomically (`activate_managed_policy`).
 */

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
 * The accepted policy that makes a workspace PropLane-managed, read fresh from the database. A schema that is not there yet
 * (code runs before the migration) is "not managed". A READ that fails is an error, never "not managed": crediting a managed
 * workspace's rent to a manager hold by mistake is the one outcome this feature must not allow.
 */
export async function loadActivePolicyForWorkspace(db: SupabaseClient, workspaceId: string, onDate?: string): Promise<PolicyRow | null> {
  const id = workspaceId.trim();
  if (!id) return null;
  const { data, error } = await db
    .from("managed_workspace_fee_policies")
    .select(POLICY_COLUMNS)
    .eq("workspace_id", id)
    .eq("status", "active")
    .not("signed_at", "is", null)
    .limit(1)
    .maybeSingle();
  if (error) {
    if (isMissingSchemaError(error)) return null;
    throw new PolicyError(500, "Could not read the workspace fee policy.");
  }
  if (!data) return null;
  const row = mapPolicyRow(data as Row);
  if (onDate && row.effectiveFrom > onDate) return null;
  return row;
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

function validateEffective(effectiveFrom: string, now: Date): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(effectiveFrom)) throw new PolicyError(400, "Choose a start date.");
  if (effectiveFrom > pacificDayKey(now)) throw new PolicyError(400, "The start date cannot be in the future. A policy starts when it is accepted.");
}

export async function createDraftPolicy(db: SupabaseClient, _admin: AdminActor, rawInput: PolicyInput, now: Date = new Date()): Promise<PolicyRow> {
  const input = { ...rawInput, ownerUserId: rawInput.ownerUserId.trim(), workspaceId: rawInput.workspaceId.trim() };
  const problem = validateManagedFeeTerms(input.terms);
  if (problem) throw new PolicyError(400, problem);
  validateEffective(input.effectiveFrom, now);
  const workspaceOwner = await loadWorkspaceOwnerId(db, input.workspaceId);
  if (!workspaceOwner) throw new PolicyError(404, "Workspace not found.");
  // PropLane's own workspace owner is never the owner of record: that would pay PropLane its own owner share.
  if (input.ownerUserId === workspaceOwner) throw new PolicyError(422, "The property owner must be a person added to the workspace, not its PropLane manager.");
  if (!(await isWorkspaceMember(db, input.workspaceId, input.ownerUserId))) {
    throw new PolicyError(422, "Add the owner to the workspace team first.");
  }
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
    const workspaceOwner = await loadWorkspaceOwnerId(db, current.workspaceId);
    if (ownerUserId === workspaceOwner) throw new PolicyError(422, "The property owner must be a person added to the workspace, not its PropLane manager.");
    if (!(await isWorkspaceMember(db, current.workspaceId, ownerUserId))) throw new PolicyError(422, "Add the owner to the workspace team first.");
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
      // An edited draft must be re-sent: the owner never signs terms they were not shown.
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

const SEND_COOLDOWN_MS = 60 * 60 * 1000;

export async function sendPolicyForSignature(
  db: SupabaseClient,
  _admin: AdminActor,
  id: string,
  now: Date = new Date(),
): Promise<{ policy: PolicyRow; emailed: boolean; texted: boolean }> {
  const current = await loadPolicy(db, id);
  if (!current) throw new PolicyError(404, "Fee policy not found.");
  if (current.status !== "draft") throw new PolicyError(409, "Only a draft can be sent for signature.");
  if (current.sentAt && now.getTime() - Date.parse(current.sentAt) < SEND_COOLDOWN_MS) {
    throw new PolicyError(429, "Already sent. You can send it again in an hour.");
  }
  const problem = validateManagedFeeTerms(current.terms);
  if (problem) throw new PolicyError(400, problem);
  if (!(await isWorkspaceMember(db, current.workspaceId, current.ownerUserId))) {
    throw new PolicyError(422, "This person is no longer on the workspace team.");
  }
  const { data, error } = await db
    .from("managed_workspace_fee_policies")
    .update({ sent_at: now.toISOString(), updated_at: now.toISOString() })
    .eq("id", current.id)
    .eq("status", "draft")
    .select(POLICY_COLUMNS)
    .maybeSingle();
  if (error || !data) throw new PolicyError(409, "The fee policy changed. Reload and try again.");
  const policy = mapPolicyRow(data as Row);

  const workspaceOwner = await loadWorkspaceOwnerId(db, policy.workspaceId);
  const path = `/portal/financials/owner-payouts?workspace=${encodeURIComponent(policy.workspaceId)}&review=${encodeURIComponent(policy.id)}`;
  const link = `${resolveEmailLinkBaseUrl()}${portalSignInHref(path)}`;
  const stamp = now.toISOString().slice(0, 13);
  const email = workspaceOwner
    ? await sendManagerNoticeEmail(db, {
        recipientUserId: policy.ownerUserId,
        ownerUserId: workspaceOwner,
        workspaceId: policy.workspaceId,
        subject: "Your PropLane management agreement",
        text: `Your PropLane management agreement is ready to review and sign.\n${describeManagedFee(policy.terms)}.`,
        url: portalSignInHref(path),
        idempotencyKey: `managed-policy-sent:${policy.id}:${stamp}`,
      }).catch(() => ({ status: "failed" as const }))
    : { status: "failed" as const };
  let texted = false;
  const { data: profile } = await db.from("profiles").select("phone, phone_verified_at").eq("id", policy.ownerUserId).maybeSingle();
  const p = (profile ?? {}) as Row;
  if (str(p.phone) && p.phone_verified_at) {
    texted = await sendWorkspacePhoneText(db, {
      workspaceId: policy.workspaceId,
      phoneKey: str(p.phone),
      body: `Your PropLane management agreement is ready to sign: ${link}`,
      role: "manager",
      idempotencyKey: `managed-policy-sent:${policy.id}:${stamp}`,
      basis: { kind: "manager_notice", topic: "fee_policy", recipientUserId: policy.ownerUserId },
    }).catch(() => false);
  }
  return { policy, emailed: email.status === "sent", texted };
}

/** Accept a draft: the owner signs, or an admin records an offline signed contract. One atomic database function. */
async function activate(
  db: SupabaseClient,
  policy: PolicyRow,
  via: "owner_signature" | "admin_attested",
  role: "owner" | "admin",
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
    // `terms_changed`: the row's own fee terms no longer match the ones this signature was taken against (the draft was
    // edited after it was loaded). The function compares them under its row lock, so this is the only safe answer.
    if (result?.reason === "terms_changed") {
      throw new PolicyError(409, "This agreement changed. Reload it and read the new terms before signing.");
    }
    if (result?.reason === "not_sent") throw new PolicyError(409, "This agreement is not waiting for your signature.");
    throw new PolicyError(409, result?.reason === "future_effective_from" ? "The start date is in the future." : "This fee policy cannot be accepted any more.");
  }
  const fresh = await loadPolicy(db, policy.id);
  if (!fresh || fresh.status !== "active") throw new PolicyError(500, "The fee policy was not recorded.");
  return fresh;
}

/** SHA-256 of the canonical fee terms of a policy as it stands: what the owner's signature is taken against. */
export function policyTermsHash(policy: PolicyRow): string {
  return policyTermsSha256(
    canonicalPolicyTerms({ workspaceId: policy.workspaceId, ownerUserId: policy.ownerUserId, terms: policy.terms, effectiveFrom: policy.effectiveFrom }),
  );
}

/**
 * The owner of record signs the version they were sent. Identity is the session; the membership is read fresh; and
 * the request carries the hash of the terms the page RENDERED, so a draft edited and re-sent under an open page
 * cannot take the owner's signature on terms they never saw. This is a fee agreement: the same per-signature rule
 * the lease pipeline holds.
 */
export async function signPolicy(db: SupabaseClient, ownerUserId: string, id: string, termsSha256: string): Promise<PolicyRow> {
  const current = await loadPolicy(db, id);
  if (!current || current.ownerUserId !== ownerUserId) throw new PolicyError(404, "Fee policy not found.");
  if (current.status === "active" && current.signedAt) return current;
  if (current.status !== "draft" || !current.sentAt) throw new PolicyError(409, "This agreement is not waiting for your signature.");
  const presented = String(termsSha256 ?? "").trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(presented)) throw new PolicyError(400, "Reload the agreement and sign it again.");
  if (presented !== policyTermsHash(current)) throw new PolicyError(409, "This agreement changed. Reload it and read the new terms before signing.");
  if (!(await isWorkspaceMember(db, current.workspaceId, ownerUserId))) throw new PolicyError(403, "You are no longer on this workspace.");
  return activate(db, current, "owner_signature", "owner", null);
}

/** An admin records that a signed contract is on file (offline). A note of at least 8 characters is required. */
export async function attestPolicy(db: SupabaseClient, _admin: AdminActor, id: string, note: string): Promise<PolicyRow> {
  const trimmed = note.trim();
  if (trimmed.length < 8) throw new PolicyError(400, "Say where the signed contract is kept (at least a few words).");
  const current = await loadPolicy(db, id);
  if (!current) throw new PolicyError(404, "Fee policy not found.");
  if (current.status === "active") return current;
  if (current.status !== "draft") throw new PolicyError(409, "Only a draft can be recorded.");
  if (!(await isWorkspaceMember(db, current.workspaceId, current.ownerUserId))) throw new PolicyError(422, "This person is no longer on the workspace team.");
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
