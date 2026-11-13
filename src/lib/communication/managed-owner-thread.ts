/**
 * The client owner of a PropLane-MANAGED (`is_service`) workspace has a conversation in the staff's Communication list
 * only when the owner actually texts or writes in. System notices ("You approved ...") and staff-authored automation are not
 * a conversation with her. Pure: no database. The server half that names the owner is `managed-owner-thread.server.ts`.
 */
export type ManagedOwnerIdentity = { ownerUserId: string; email: string | null; phoneE164: string | null };

type ThreadLike = {
  id?: unknown;
  thread_type?: unknown;
  participant_email?: unknown;
  owner_user_id?: unknown;
  row_data?: unknown;
};

const NON_PERSON_TYPES = new Set(["agent_notice", "team", "vendor_agent", "resident_agent"]);

const clean = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

/**
 * True for an in-app thread with the workspace's owner that holds ONLY system notices: nothing the owner sent
 * (`outbound: false`) and nothing a person typed (every turn stamped `automated`). Assistant, Team, house and
 * agent threads are never this.
 */
export function isSystemOnlyOwnerThread(thread: ThreadLike, owner: ManagedOwnerIdentity): boolean {
  const id = clean(thread.id);
  const type = clean(thread.thread_type);
  if (NON_PERSON_TYPES.has(type) || id.startsWith("agent_notice_") || id.startsWith("team-thread:") || id.startsWith("house-thread:")) return false;
  const row = (thread.row_data && typeof thread.row_data === "object" ? thread.row_data : {}) as Record<string, unknown>;
  const email = (clean(thread.participant_email) || clean(row.email)).toLowerCase();
  if (!owner.email || email !== owner.email.toLowerCase()) return false;
  const messages = Array.isArray(row.messages) ? (row.messages as Array<Record<string, unknown>>) : [];
  if (messages.length === 0) return row.rootAutomated === true;
  return messages.every((m) => m?.outbound !== false && m?.automated === true);
}

const digits = (v: unknown): string => String(v ?? "").replace(/\D/g, "").slice(-10);

/**
 * True for an SMS conversation with the workspace's owner in which the owner has never texted (no inbound turn): the text
 * PropLane sent them is not a conversation. Matches on the owner's account or phone.
 */
export function isOutboundOnlyOwnerSms(
  summary: { counterpartyUserId?: unknown; phone?: unknown; lastInboundAt?: unknown; lastInboundEventId?: unknown },
  owner: ManagedOwnerIdentity,
): boolean {
  const isOwner =
    (clean(summary.counterpartyUserId) !== "" && clean(summary.counterpartyUserId) === owner.ownerUserId) ||
    (digits(summary.phone) !== "" && digits(summary.phone) === digits(owner.phoneE164));
  if (!isOwner) return false;
  return !summary.lastInboundAt && !summary.lastInboundEventId;
}
