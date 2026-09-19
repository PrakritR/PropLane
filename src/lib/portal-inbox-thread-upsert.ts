export type InboxThreadUpsertUser = { id: string; email?: string | null };

/**
 * Ordinary browser mailbox writes may change presentation and mailbox state,
 * but never the relationship the server established for that row. Keep this
 * list beside the request builder so a newly added identity projection cannot
 * accidentally become a client-authoritative claim.
 */
const SERVER_OWNED_RELATIONSHIP_FIELDS = [
  "managerUserId",
  "propertyId",
  "propertyTitle",
  "counterpartyRole",
  "smsConversationKey",
  "smsBindingKeys",
  "identityProvenance",
  "boundManagerUserId",
  "smsNoticePhone",
] as const;

export function withoutServerOwnedInboxRelationshipFields(row: Record<string, unknown>): Record<string, unknown> {
  const sanitized = { ...row };
  for (const field of SERVER_OWNED_RELATIONSHIP_FIELDS) delete sanitized[field];
  // The persisted shape is camelCase, but discard alternate request spellings
  // too so a forged value cannot survive a future compatibility normalizer.
  delete sanitized.manager_user_id;
  delete sanitized.property_id;
  delete sanitized.property_title;
  delete sanitized.counterparty_role;
  delete sanitized.sms_conversation_key;
  delete sanitized.sms_binding_keys;
  delete sanitized.identity_provenance;
  delete sanitized.bound_manager_user_id;
  delete sanitized.sms_notice_phone;
  return sanitized;
}

/** Preserve only relationship facts already present in a server-owned row. */
export function preserveServerOwnedInboxRelationshipFields(
  row: Record<string, unknown>,
  priorRowData: unknown,
): Record<string, unknown> {
  const next = withoutServerOwnedInboxRelationshipFields(row);
  if (!priorRowData || typeof priorRowData !== "object" || Array.isArray(priorRowData)) return next;
  const prior = priorRowData as Record<string, unknown>;
  for (const field of SERVER_OWNED_RELATIONSHIP_FIELDS) {
    if (field in prior) next[field] = prior[field];
  }
  return next;
}

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
