import "server-only";

import { createHash } from "crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { PRIMARY_ADMIN_EMAIL } from "@/lib/auth/primary-admin";
import { PRIMARY_AXIS_ADMIN_LABEL } from "@/data/inbox-scoped-directory";
import { formatPacificDateTime } from "@/lib/pacific-time";
import { buildPortalInboxThreadUpsert } from "@/lib/portal-inbox-thread-upsert";
import { emailKey } from "@/lib/communication/conversation-key";
import { deliverPortalMessageThreadSide, scopeForRole } from "@/lib/portal-inbox-delivery";
import { ADMIN_INBOX_SCOPE } from "@/lib/portal-inbox-thread-scope";

export type AdminInboxSenderRole = "manager" | "resident" | "vendor" | "partner" | "admin";

export type AdminInboxThreadReply = {
  id: string;
  authorLabel: string;
  body: string;
  createdAt: string;
};

export type AdminInboxThreadRow = {
  id: string;
  name: string;
  email: string;
  participantEmail: string;
  topic: string;
  body: string;
  createdAt: string;
  read: boolean;
  folder: "inbox" | "sent" | "trash";
  senderRole: AdminInboxSenderRole;
  thread: AdminInboxThreadReply[];
  scope: typeof ADMIN_INBOX_SCOPE;
};

const PORTAL_SENDER_ROLES = new Set<AdminInboxSenderRole>(["manager", "resident", "vendor"]);

export function isPrimaryAdminRecipientEmail(email: string): boolean {
  return email.trim().toLowerCase() === PRIMARY_ADMIN_EMAIL.trim().toLowerCase();
}

/** One shared admin thread per portal sender email. */
export function adminPortalThreadIdForSender(senderEmail: string): string {
  const normalized = senderEmail.trim().toLowerCase();
  const digest = createHash("sha256").update(normalized).digest("hex").slice(0, 24);
  return `admin_portal_${digest}`;
}

export function mapProfileRoleToAdminInboxSenderRole(role: string | null): AdminInboxSenderRole {
  const normalized = String(role ?? "").trim().toLowerCase();
  if (normalized === "vendor") return "vendor";
  if (normalized === "resident") return "resident";
  if (normalized === "admin") return "admin";
  return "manager";
}

function parseAdminInboxRowData(rowData: Record<string, unknown>): AdminInboxThreadRow | null {
  const id = String(rowData.id ?? "").trim();
  const email = String(rowData.email ?? rowData.participantEmail ?? "").trim().toLowerCase();
  const folder = String(rowData.folder ?? "");
  const senderRole = String(rowData.senderRole ?? "") as AdminInboxSenderRole;
  if (!id || !email || folder !== "inbox" || !PORTAL_SENDER_ROLES.has(senderRole)) return null;
  const thread = Array.isArray(rowData.thread)
    ? (rowData.thread as AdminInboxThreadReply[])
    : [];
  return {
    id,
    name: String(rowData.name ?? email),
    email,
    participantEmail: String(rowData.participantEmail ?? email).trim().toLowerCase(),
    topic: String(rowData.topic ?? ""),
    body: String(rowData.body ?? ""),
    createdAt: String(rowData.createdAt ?? new Date().toISOString()),
    read: Boolean(rowData.read),
    folder: "inbox",
    senderRole,
    thread,
    scope: ADMIN_INBOX_SCOPE,
  };
}

export async function findAdminPortalThreadBySender(
  db: SupabaseClient,
  senderEmail: string,
): Promise<{ id: string; rowData: Record<string, unknown> } | null> {
  const participant = senderEmail.trim().toLowerCase();
  const { data } = await db
    .from("portal_inbox_thread_records")
    .select("id, row_data, updated_at")
    .eq("scope", ADMIN_INBOX_SCOPE)
    .eq("participant_email", participant)
    .order("updated_at", { ascending: false })
    .limit(20);

  for (const row of data ?? []) {
    const rowData = (row.row_data ?? {}) as Record<string, unknown>;
    const parsed = parseAdminInboxRowData(rowData);
    if (parsed) {
      return { id: String(row.id), rowData };
    }
  }
  return null;
}

/**
 * Append a portal user's message into the shared admin inbox (one thread per
 * sender, visible to every admin). Also bumps sort/read state for the list.
 */
export async function deliverPortalMessageToAdminSharedInbox(
  db: SupabaseClient,
  opts: {
    senderEmail: string;
    senderName: string;
    senderRole: AdminInboxSenderRole;
    subject: string;
    body: string;
  },
): Promise<{ threadId: string; created: boolean }> {
  const senderEmail = opts.senderEmail.trim().toLowerCase();
  const nowIso = new Date().toISOString();
  const when = formatPacificDateTime(new Date());
  const existing = await findAdminPortalThreadBySender(db, senderEmail);
  const message: AdminInboxThreadReply = {
    id: `portal-msg-${Date.now().toString(36)}`,
    authorLabel: opts.senderName.trim() || senderEmail,
    body: opts.body.trim(),
    createdAt: nowIso,
  };

  if (existing) {
    const rowData = { ...existing.rowData } as Record<string, unknown>;
    const thread = Array.isArray(rowData.thread) ? [...(rowData.thread as AdminInboxThreadReply[])] : [];
    thread.push(message);
    const nextRow: AdminInboxThreadRow = {
      ...(parseAdminInboxRowData(rowData) ?? {
        id: existing.id,
        name: opts.senderName.trim() || senderEmail,
        email: senderEmail,
        participantEmail: senderEmail,
        topic: opts.subject.trim(),
        body: opts.body.trim(),
        createdAt: nowIso,
        read: false,
        folder: "inbox",
        senderRole: opts.senderRole,
        thread: [],
        scope: ADMIN_INBOX_SCOPE,
      }),
      topic: opts.subject.trim() || String(rowData.topic ?? ""),
      read: false,
      createdAt: nowIso,
      thread,
    };
    // The admin inbox is one thread per sender with no workspace: the person's
    // key (their email) rides in row_data so every surface joins on one value.
    const record = buildPortalInboxThreadUpsert({ ...nextRow, conversationKey: emailKey(senderEmail) }, { id: "", email: null });
    await db.from("portal_inbox_thread_records").upsert(record, { onConflict: "id" });
    return { threadId: existing.id, created: false };
  }

  const threadId = adminPortalThreadIdForSender(senderEmail);
  const row: AdminInboxThreadRow = {
    id: threadId,
    name: opts.senderName.trim() || senderEmail,
    email: senderEmail,
    participantEmail: senderEmail,
    topic: opts.subject.trim() || "(no subject)",
    body: opts.body.trim(),
    createdAt: nowIso,
    read: false,
    folder: "inbox",
    senderRole: PORTAL_SENDER_ROLES.has(opts.senderRole) ? opts.senderRole : "manager",
    thread: [],
    scope: ADMIN_INBOX_SCOPE,
  };
  const record = buildPortalInboxThreadUpsert({ ...row, conversationKey: emailKey(senderEmail) }, { id: "", email: null });
  const { error } = await db.from("portal_inbox_thread_records").upsert(record, { onConflict: "id" });
  if (error) throw new Error(error.message);
  void when;
  return { threadId, created: true };
}

/**
 * Any admin may reply; the sender sees one thread with PropLane admin as the
 * counterparty. Replies are stored on the shared admin row and delivered into
 * the sender's portal inbox.
 */
export async function deliverAdminReplyFromSharedInbox(
  db: SupabaseClient,
  opts: {
    threadId: string;
    replyText: string;
  },
): Promise<{ ok: true } | { ok: false; error: string }> {
  const threadId = opts.threadId.trim();
  const text = opts.replyText.trim();
  if (!threadId || !text) return { ok: false, error: "threadId and text are required." };

  const { data: threadRow } = await db
    .from("portal_inbox_thread_records")
    .select("id, row_data, participant_email, scope")
    .eq("id", threadId)
    .maybeSingle();
  if (!threadRow || String(threadRow.scope ?? "") !== ADMIN_INBOX_SCOPE) {
    return { ok: false, error: "Thread not found." };
  }

  const rowData = (threadRow.row_data ?? {}) as Record<string, unknown>;
  const parsed = parseAdminInboxRowData(rowData);
  if (!parsed || !PORTAL_SENDER_ROLES.has(parsed.senderRole)) {
    return { ok: false, error: "This thread cannot be replied to." };
  }

  const participantEmail = String(threadRow.participant_email ?? parsed.email).trim().toLowerCase();
  const nowIso = new Date().toISOString();
  const when = formatPacificDateTime(new Date());
  const reply: AdminInboxThreadReply = {
    id: `admin-reply-${Date.now().toString(36)}`,
    authorLabel: PRIMARY_AXIS_ADMIN_LABEL,
    body: text,
    createdAt: nowIso,
  };
  const thread = [...parsed.thread, reply];
  const nextRow: AdminInboxThreadRow = {
    ...parsed,
    read: true,
    thread,
  };
  const record = buildPortalInboxThreadUpsert(nextRow, { id: "", email: null });
  const { error } = await db.from("portal_inbox_thread_records").upsert(record, { onConflict: "id" });
  if (error) return { ok: false, error: error.message };

  const recipientRole = parsed.senderRole === "vendor" ? "vendor" : parsed.senderRole === "resident" ? "resident" : "manager";
  const recipientScope = scopeForRole(recipientRole);
  const { data: profile } = await db
    .from("profiles")
    .select("id")
    .ilike("email", participantEmail)
    .maybeSingle();
  const recipientUserId = (profile?.id as string | null) ?? null;

  const preview = text.slice(0, 100).replace(/\n/g, " ");
  const subject = parsed.topic.trim() || "Message from PropLane admin";

  await deliverPortalMessageThreadSide(db, {
    scope: recipientScope,
    folder: "inbox",
    ownerUserId: recipientUserId,
    participantEmail: participantEmail,
    otherPartyEmail: PRIMARY_ADMIN_EMAIL,
    fallbackId: `msg_admin_in_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    fromName: PRIMARY_AXIS_ADMIN_LABEL,
    subject,
    body: text,
    preview,
    when,
    unread: true,
    outbound: false,
  });

  return { ok: true };
}
