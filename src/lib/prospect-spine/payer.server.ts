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

/** Refusals that are the recipient's own choice or the clock: never "fixed" by sending another way. */
const NEVER_RETRIED_AS_PROPLANE = new Set(["recipient_opted_out", "opted_out", "quiet_hours", "shielded", "protected_account_shielded", "empty", "duplicate"]);

/**
 * A prospect's reply on a PropLane-MANAGED workspace must not die because the CLIENT's wallet (or its own line state) refused
 * it. When the normal send was refused for any reason that is not the person's own choice (STOP, quiet hours), PropLane sends
 * it itself on the shared line (`sendPlatformLeadText`: PropLane pays, no workspace wallet, the opt-out ledger still applies).
 * Self-serve workspaces never take this path: they stay fail-closed on their own wallet. Idempotent on `claimKey` (a retried
 * turn never texts twice). Never throws.
 */
export async function sendAsPropLaneAfterRefusal(
  db: SupabaseClient,
  input: { ownerUserId: string; workspaceId: string | null; to: string; body: string; claimKey: string; refusal?: string | null },
): Promise<{ attempted: boolean; ok: boolean; reason?: string }> {
  try {
    const refusal = (input.refusal ?? "").trim();
    if (refusal && NEVER_RETRIED_AS_PROPLANE.has(refusal)) return { attempted: false, ok: false, reason: refusal };
    const payer = await resolveSmsPayer(db, { ownerUserId: input.ownerUserId, workspaceId: input.workspaceId });
    if (payer === input.ownerUserId.trim()) return { attempted: false, ok: false, reason: "not_managed" };
    const { rateLimit } = await import("@/lib/rate-limit");
    const claim = await rateLimit(`proplane-fallback-send:${input.claimKey}`.slice(0, 160), 1, 24 * 60 * 60_000);
    // A key already claimed means an earlier attempt of THIS reply ran: never a second text.
    if (!claim.unavailable && !claim.ok) return { attempted: true, ok: true, reason: "already_sent" };
    const { sendPlatformLeadText } = await import("@/lib/one-number/lead-send.server");
    const sent = await sendPlatformLeadText(db, { to: input.to, body: input.body, inboundReply: true });
    return sent.ok ? { attempted: true, ok: true } : { attempted: true, ok: false, reason: sent.reason };
  } catch {
    return { attempted: true, ok: false, reason: "provider_error" };
  }
}
