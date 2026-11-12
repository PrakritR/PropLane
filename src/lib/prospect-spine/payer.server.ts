import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Who pays for a text sent in a workspace's name. A PropLane-managed (`is_service`) workspace is paid by the service
 * owner (the same wallet its alert texts already use); every other workspace pays itself. A client owner's empty wallet
 * must never be the reason a prospect goes unanswered on a managed workspace. Never throws: an unreadable workspace or
 * service owner answers the owner (the old behaviour), never nobody.
 */
export async function resolveSmsPayer(
  db: SupabaseClient,
  input: { ownerUserId: string; workspaceId: string | null },
): Promise<string> {
  const owner = input.ownerUserId.trim();
  const workspaceId = (input.workspaceId ?? "").trim();
  if (!owner || !workspaceId) return owner;
  try {
    const { isManagedWorkspaceId, serviceAlertPayerUserId } = await import("@/lib/service/service-alert-targets.server");
    if (!(await isManagedWorkspaceId(db, workspaceId))) return owner;
    return (await serviceAlertPayerUserId(db)) || owner;
  } catch {
    return owner;
  }
}

/**
 * The ONLY structured refusal codes that let PropLane re-send on the shared line: the CLIENT workspace's wallet/credit, or
 * its own line, was not usable. Everything else (STOP/opt-out, quiet hours, shield, authorization, consent, validation,
 * duplicate, delivery_outcome_unknown, a free-text message, a missing code) never falls back: an allowlist, never a denylist.
 */
const PROPLANE_FALLBACK_EXACT = new Set([
  "credit_unavailable",
  "workspace_has_no_work_number",
  "number_missing",
  "number_not_active",
  "manager_registration_not_approved",
  "number_not_attached",
  "number_not_registered",
  "number_quarantined",
  "number_in_grace",
  "number_grace_expired",
  "number_grace_invalid",
  "provider_identity_mismatch",
]);

/** True only for a wallet/credit or workspace-line refusal code (see the allowlist above). Free text is never one. */
export function isPropLaneFallbackRefusalCode(code: string | null | undefined): boolean {
  const c = (code ?? "").trim();
  return PROPLANE_FALLBACK_EXACT.has(c) || /^comms_billing_[a-z0-9_]+$/.test(c);
}

/**
 * A prospect's reply on a PropLane-MANAGED workspace must not die because the CLIENT's wallet (or its own line state) refused
 * it. When the normal send was refused with a structured wallet/credit/line code (`refusalCode`, allowlisted), PropLane sends
 * it itself on the shared line (`sendPlatformLeadText`: PropLane pays, no workspace wallet, the opt-out ledger still applies).
 * Any other or missing code never falls back. Self-serve workspaces never take this path. Idempotent on `claimKey` (a retried
 * turn never texts twice; an earlier attempt is reported `already_attempted`, never assumed sent). Never throws.
 */
export async function sendAsPropLaneAfterRefusal(
  db: SupabaseClient,
  input: { ownerUserId: string; workspaceId: string | null; to: string; body: string; claimKey: string; refusalCode?: string | null },
): Promise<{ attempted: boolean; ok: boolean; reason?: string }> {
  try {
    const code = (input.refusalCode ?? "").trim();
    if (!isPropLaneFallbackRefusalCode(code)) return { attempted: false, ok: false, reason: "refusal_not_eligible" };
    const payer = await resolveSmsPayer(db, { ownerUserId: input.ownerUserId, workspaceId: input.workspaceId });
    if (payer === input.ownerUserId.trim()) return { attempted: false, ok: false, reason: "not_managed" };
    const { rateLimit } = await import("@/lib/rate-limit");
    const claim = await rateLimit(`proplane-fallback-send:${input.claimKey}`.slice(0, 160), 1, 24 * 60 * 60_000);
    // A key already claimed means an earlier attempt of THIS reply ran: never a second text, and never assumed delivered.
    if (!claim.unavailable && !claim.ok) return { attempted: true, ok: false, reason: "already_attempted" };
    const { sendPlatformLeadText } = await import("@/lib/one-number/lead-send.server");
    const sent = await sendPlatformLeadText(db, { to: input.to, body: input.body, inboundReply: true });
    return sent.ok ? { attempted: true, ok: true } : { attempted: true, ok: false, reason: sent.reason };
  } catch {
    return { attempted: true, ok: false, reason: "provider_error" };
  }
}
