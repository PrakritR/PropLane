/**
 * ONE PropLane Assistant conversation across SMS and the app.
 *
 * The manager's Communication → PropLane Assistant thread is the
 * `agent_notice_<uid>` row in `portal_inbox_thread_records`. Every text the
 * work number exchanges with the manager's OWN phone (a forwarded texter, a
 * digest, a reminder about their items, an approval ask, their own inbound
 * text and the agent's reply) is mirrored into that same row, stamped
 * `channel: "sms"`. There is no second assistant conversation: the thread id
 * comes from `managerAgentNoticeThreadId`, the same function the in-app notices
 * use, and a retry of the same send never appends twice (the message id is
 * derived from the outbox id / inbound MessageSid).
 *
 * Replies typed in the app thread stay in-app (`runManagerInboxAgentTurn`);
 * nothing here ever sends a text.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { managerAgentNoticeThreadId } from "@/lib/communication-manager-assistant-thread";
import { resolveManagerAssistantThreadWorkspace } from "@/lib/communication/manager-assistant-workspace.server";
import { normalizeE164 } from "@/lib/phone-e164";

const ASSISTANT_NAME = "PropLane Assistant";
/** The manager's own words, as the thread's other bubbles label them. */
const MANAGER_AUTHOR = "You";
const MAX_APPEND_ATTEMPTS = 4;

/** Purposes whose in-app copy is written by `notifyManagerFromAgent` itself. */
export function outboxPurposeMirroredByNotice(purpose: string | null | undefined): boolean {
  return String(purpose ?? "").startsWith("manager_agent_notification_");
}

/** The workspace a work number belongs to, from the number the text went out on. */
export async function workspaceIdForWorkNumber(
  db: SupabaseClient,
  args: { managerUserId: string; workNumber: string | null | undefined },
): Promise<string | null> {
  const phone = normalizeE164(String(args.workNumber ?? "")) ?? String(args.workNumber ?? "").trim();
  if (!phone) return null;
  const { data } = await db
    .from("manager_sms_numbers")
    .select("workspace_id")
    .eq("manager_user_id", args.managerUserId)
    .eq("phone_number", phone)
    .limit(1)
    .maybeSingle();
  return String(data?.workspace_id ?? "").trim() || null;
}

export type AssistantSmsMirrorInput = {
  /** The manager whose Assistant thread this is (auth/session derived, never request input). */
  ownerUserId: string;
  /** The work number's workspace; absent resolves the manager's default workspace. */
  workspaceId?: string | null;
  /** Stable message id so a retry appends nothing. */
  messageId: string;
  author: "assistant" | "manager";
  body: string;
  /** Carry an existing notice classification (renders as a notice, not a bubble). */
  noticeType?: string;
};

export type AssistantSmsMirrorResult =
  | { ok: true; threadId: string; appended: boolean }
  | { ok: false; error: string };

/**
 * Append one SMS turn to the manager's PropLane Assistant thread, once.
 * Call it only after the send/identity is authorized. If the message id is
 * already in the thread it is left alone (its SMS marker is filled in when an
 * earlier in-app write lacked it).
 */
export async function appendSmsTurnToManagerAssistantThread(
  db: SupabaseClient,
  input: AssistantSmsMirrorInput,
): Promise<AssistantSmsMirrorResult> {
  const ownerUserId = input.ownerUserId.trim();
  const body = input.body.trim();
  if (!ownerUserId || !body || !input.messageId) return { ok: false, error: "invalid_mirror_input" };
  try {
    // One resolver for every Assistant writer: the work number's workspace when
    // known, else the user's default. Never the browser cookie.
    const workspace = await resolveManagerAssistantThreadWorkspace(db, ownerUserId, { workspaceId: input.workspaceId });
    // Dynamic: agent-notify imports this module to stamp its own SMS sends.
    const { ensureManagerAgentNoticeThread } = await import("@/lib/agent-notify.server");
    const threadId = await ensureManagerAgentNoticeThread(db, ownerUserId, workspace);

    for (let attempt = 0; attempt < MAX_APPEND_ATTEMPTS; attempt += 1) {
      const { data: row, error: readError } = await db
        .from("portal_inbox_thread_records")
        .select("row_data, updated_at")
        .eq("id", threadId)
        .eq("owner_user_id", ownerUserId)
        .maybeSingle();
      if (readError || !row) return { ok: false, error: "thread_unavailable" };
      const rowData = (row.row_data ?? {}) as Record<string, unknown>;
      const prior = Array.isArray(rowData.messages) ? [...(rowData.messages as Record<string, unknown>[])] : [];
      const existingIndex = prior.findIndex((m) => m?.id === input.messageId);
      const nowIso = new Date().toISOString();
      let messages: Record<string, unknown>[];
      let appended = false;
      if (existingIndex >= 0) {
        if (prior[existingIndex]?.channel === "sms") return { ok: true, threadId, appended: false };
        messages = prior.map((m, i) => (i === existingIndex ? { ...m, channel: "sms" } : m));
      } else {
        appended = true;
        messages = [
          ...prior,
          {
            id: input.messageId,
            from: input.author === "assistant" ? ASSISTANT_NAME : MANAGER_AUTHOR,
            body,
            at: nowIso,
            outbound: input.author === "manager",
            channel: "sms",
            ...(input.noticeType ? { noticeType: input.noticeType } : {}),
          },
        ];
      }
      const next: Record<string, unknown> = {
        ...rowData,
        messages,
        ...(appended
          ? {
              preview: body.slice(0, 100).replace(/\n/g, " "),
              // One thread, one unread flag: the assistant speaking marks it unread
              // (and pulls it out of trash); the manager's own text never does.
              ...(input.author === "assistant" ? { unread: true, folder: "inbox" } : {}),
            }
          : {}),
      };
      let update = db
        .from("portal_inbox_thread_records")
        .update({ row_data: next, updated_at: nowIso })
        .eq("id", threadId)
        .eq("owner_user_id", ownerUserId);
      // Optimistic guard: a concurrent append moves updated_at and we re-read.
      update = row.updated_at ? update.eq("updated_at", row.updated_at) : update;
      const { data: written, error: writeError } = await update.select("id");
      if (writeError) return { ok: false, error: "thread_write_failed" };
      if (Array.isArray(written) ? written.length > 0 : Boolean(written)) {
        return { ok: true, threadId, appended };
      }
    }
    return { ok: false, error: "thread_contended" };
  } catch (error) {
    console.error("assistant sms mirror failed", error instanceof Error ? error.message : "unknown");
    return { ok: false, error: "mirror_failed" };
  }
}

export type MirrorableOutboxRow = {
  id: string;
  manager_user_id: string;
  actor_user_id?: string | null;
  recipient_phone: string;
  body: string;
  purpose: string;
  counterparty_role?: string | null;
};

/**
 * Mirror a carrier-accepted outbox row into the Assistant thread when (and only
 * when) it went to the manager's OWN phone. Returns "skipped" for anything else
 * (a resident, a prospect, another person's number, or a purpose whose in-app
 * copy is written elsewhere), "failed" when the append should be retried.
 */
export async function mirrorManagerOwnOutboxToAssistantThread(
  db: SupabaseClient,
  row: MirrorableOutboxRow,
  fromNumber: string | null | undefined,
): Promise<"mirrored" | "skipped" | "failed"> {
  if (row.counterparty_role !== "manager") return "skipped";
  if (outboxPurposeMirroredByNotice(row.purpose)) return "skipped";
  const ownerUserId = String(row.actor_user_id ?? "").trim() || row.manager_user_id;
  const { data: profile, error } = await db.from("profiles").select("phone").eq("id", ownerUserId).maybeSingle();
  if (error) return "failed";
  const own = normalizeE164(String(profile?.phone ?? ""));
  if (!own || own !== normalizeE164(row.recipient_phone)) return "skipped";
  const workspaceId = await workspaceIdForWorkNumber(db, {
    managerUserId: row.manager_user_id,
    workNumber: fromNumber,
  }).catch(() => null);
  const result = await appendSmsTurnToManagerAssistantThread(db, {
    ownerUserId,
    workspaceId,
    messageId: `sms_out_${row.id}`,
    author: "assistant",
    body: row.body,
  });
  return result.ok ? "mirrored" : "failed";
}

/** Thread id helper for callers that only need to link a session to the thread. */
export async function managerAssistantThreadIdFor(
  db: SupabaseClient,
  ownerUserId: string,
  workspaceId?: string | null,
): Promise<string> {
  const workspace = await resolveManagerAssistantThreadWorkspace(db, ownerUserId.trim(), { workspaceId });
  return managerAgentNoticeThreadId(ownerUserId.trim(), workspace);
}
