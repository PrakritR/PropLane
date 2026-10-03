export type InboxThreadUpsertUser = { id: string; email?: string | null };

/** Sent threads (and trash restored from sent) keep owner-only mailbox columns. */
export function sentLikeInboxFolder(row: Record<string, unknown>): boolean {
  const folder = String(row.folder ?? "");
  const previousFolder = String(row.previousFolder ?? row.previous_folder ?? "");
  const id = String(row.id ?? "");
  if (folder === "sent") return true;
  if (folder === "trash") {
    if (previousFolder === "sent") return true;
    if (previousFolder === "inbox") return false;
    if (/^msg_inbox_|^welcome_inbox_/.test(id)) return false;
    if (/^(sent_|msg_|welcome_)/.test(id)) return true;
  }
  return false;
}

export function buildPortalInboxThreadUpsert(row: Record<string, unknown>, user: InboxThreadUpsertUser) {
  const sentLike = sentLikeInboxFolder(row);
  const participantEmail = sentLike
    ? null
    : String(row.participantEmail ?? row.participant_email ?? user.email ?? "")
        .trim()
        .toLowerCase() || null;

  return {
    id: row.id,
    scope: row.scope ?? "portal",
    owner_user_id:
      row.scope === "admin" ? null : (row.ownerUserId ?? row.owner_user_id ?? user.id),
    participant_email: participantEmail,
    thread_type: row.threadType ?? row.thread_type ?? null,
    row_data: row,
    updated_at: new Date().toISOString(),
  };
}

/**
 * Server-decided inbox row for a CLIENT write (`POST /api/portal-inbox-threads`).
 *
 * `buildPortalInboxThreadUpsert` trusts the row it is handed, which is right
 * for server callers (inbound email, admin shared inbox) and wrong for a
 * browser: a client-chosen `scope` + `participantEmail` planted a thread in
 * another account's inbox. Here the scope is the one the route already proved
 * the caller may write, and the participant is the caller's own email (or null
 * on a sent copy) - never a value from the body. Only an admin keeps the older
 * "owner from the row" latitude.
 */
export function buildClientPortalInboxThreadUpsert(
  row: Record<string, unknown>,
  user: InboxThreadUpsertUser,
  trusted: { scope: string; isAdmin: boolean },
) {
  if (trusted.isAdmin) return { ...buildPortalInboxThreadUpsert(row, user), scope: trusted.scope };
  const participantEmail = sentLikeInboxFolder(row) ? null : String(user.email ?? "").trim().toLowerCase() || null;
  return {
    id: row.id,
    scope: trusted.scope,
    owner_user_id: trusted.scope === "admin" ? null : user.id,
    participant_email: participantEmail,
    // A browser never mints a typed (team / agent / escalation) thread.
    thread_type: null,
    row_data: { ...row, scope: trusted.scope, threadType: undefined, thread_type: undefined },
    updated_at: new Date().toISOString(),
  };
}

/** Ids the server derives deterministically; a client never creates them. */
export function isServerReservedInboxThreadId(id: string): boolean {
  return /^(agent_notice_|property_mgr_|team-thread:)/.test(id);
}
