import { normalizeInboxAttachmentUrls } from "@/lib/inbox-attachments.server";
/**
 * The resident's assistant thread in Communication.
 *
 * Mirrors the vendor agent thread that already exists: a conversation whose
 * other party is PropLane itself, so the resident is plainly talking to an
 * assistant rather than to a manager who has secretly been replaced by one.
 * That honesty is the reason this is a dedicated thread instead of an
 * auto-reply inside a human conversation — a resident must never mistake a
 * generated answer for their property manager's word.
 *
 * The turn runs after the send response, so a slow model never delays the
 * resident's own message from appearing.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  RESIDENT_AGENT_FROM_NAME,
  RESIDENT_AGENT_THREAD_TYPE,
  canonicalResidentAgentThreadId,
  parseResidentAgentThreadId,
} from "@/lib/agent/resident-inbox-agent-ids";
import { formatPacificDateTime } from "@/lib/pacific-time";
import {
  commitInboxThreadReply,
  type InboxThreadReplyTarget,
} from "@/lib/portal-inbox-delivery";
import {
  autoRespondToResidentInboxMessage,
  type InboxTurnMessage,
} from "@/lib/agent/inbox-auto-respond.server";
import { createPendingActionForUser } from "@/lib/tools/pending-actions";

export { RESIDENT_AGENT_FROM_NAME, RESIDENT_AGENT_THREAD_TYPE } from "@/lib/agent/resident-inbox-agent-ids";

const RESIDENT_INBOX_SCOPE = "axis_portal_inbox_resident_v1";

/** Stable per resident — one assistant conversation regardless of manager count. */
export function residentAgentThreadId(residentUserId: string, _managerUserId?: string): string {
  void _managerUserId;
  return canonicalResidentAgentThreadId(residentUserId);
}

/**
 * Read the thread as an alternating transcript.
 *
 * Anything the assistant said is `manager` side (it is what came back); anything
 * else is the resident. Attribution is by the stored `from` name rather than by
 * position, because a thread can also carry system notices.
 */
export function threadHistory(rowData: Record<string, unknown> | null | undefined, residentUserId?: string): InboxTurnMessage[] {
  const messages = Array.isArray(rowData?.messages) ? (rowData!.messages as unknown[]) : [];
  return messages
    .map((entry) => {
      const row = (entry ?? {}) as Record<string, unknown>;
      let body = typeof row.body === "string" ? row.body : "";
      if (residentUserId && row.from !== RESIDENT_AGENT_FROM_NAME && Array.isArray(row.attachments)) {
        const urls = normalizeInboxAttachmentUrls(row.attachments.map(a => a && typeof a === "object" ? a.url : ""), residentUserId);
        const refs = urls.map(url => new URL(url, "http://localhost").searchParams.get("path")).filter(path => path && /\.(jpg|jpeg|png|webp)$/i.test(path));
        if (refs.length) body += `\nPrivate photo source references (not filed yet):\n${refs.join("\n")}\nAsk which inspection and section before proposing file_inspection_photo.`;
      }
      const from = typeof row.from === "string" ? row.from : "";
      return {
        from: from === RESIDENT_AGENT_FROM_NAME ? ("manager" as const) : ("resident" as const),
        body,
      };
    })
    .filter((entry) => entry.body.trim());
}

/**
 * Create the assistant thread if the resident does not have one yet.
 *
 * Idempotent on the deterministic id, so calling it on every portal load is
 * safe and cannot fan out duplicate conversations.
 */
export async function ensureResidentAgentThread(
  db: SupabaseClient,
  input: { residentUserId: string; residentEmail: string; managerUserId?: string },
): Promise<string> {
  const threadId = residentAgentThreadId(input.residentUserId, input.managerUserId);
  const managerUserId = input.managerUserId?.trim() || "";
  const { data: existing } = await db
    .from("portal_inbox_thread_records")
    .select("id, row_data")
    .eq("id", threadId)
    .maybeSingle();
  if (existing) {
    const rowData = (existing.row_data ?? {}) as Record<string, unknown>;
    if (managerUserId && !rowData.boundManagerUserId) {
      await db
        .from("portal_inbox_thread_records")
        .update({
          row_data: { ...rowData, boundManagerUserId: managerUserId },
          updated_at: new Date().toISOString(),
        })
        .eq("id", threadId);
    }
    return threadId;
  }

  const when = formatPacificDateTime(new Date());
  await db.from("portal_inbox_thread_records").upsert(
    {
      id: threadId,
      scope: RESIDENT_INBOX_SCOPE,
      owner_user_id: input.residentUserId,
      participant_email: input.residentEmail.trim().toLowerCase(),
      thread_type: RESIDENT_AGENT_THREAD_TYPE,
      row_data: {
        id: threadId,
        folder: "inbox",
        from: RESIDENT_AGENT_FROM_NAME,
        email: "",
        subject: "Ask PropLane",
        preview: "Ask about your lease, rent, maintenance or upcoming visits.",
        time: when,
        unread: false,
        threadType: RESIDENT_AGENT_THREAD_TYPE,
        ...(managerUserId ? { boundManagerUserId: managerUserId } : {}),
        body: [
          "Hi — you can ask me about your lease, rent, maintenance requests or anything coming up.",
          "",
          "I can look things up for you, and if something needs doing I will show you exactly what it is before anything happens.",
        ].join("\n"),
        messages: [],
      },
      updated_at: new Date().toISOString(),
    },
    { onConflict: "id" },
  );
  return threadId;
}

/** The manager this assistant thread is bound to — from row data or a legacy id suffix. */
export function managerUserIdFromAgentThreadId(
  threadId: string,
  residentUserId: string,
  rowData?: Record<string, unknown> | null,
): string | null {
  const bound = rowData?.boundManagerUserId;
  if (typeof bound === "string" && bound.trim()) return bound.trim();

  const canonical = canonicalResidentAgentThreadId(residentUserId);
  if (threadId === canonical) return null;

  const parsed = parseResidentAgentThreadId(threadId);
  if (parsed?.residentUserId === residentUserId && parsed.managerUserId) {
    return parsed.managerUserId;
  }

  const legacyPrefix = `resident-agent-${residentUserId}-`;
  if (!threadId.startsWith(legacyPrefix)) return null;
  const managerUserId = threadId.slice(legacyPrefix.length).trim();
  return managerUserId || null;
}

/**
 * Answer the resident's latest message in their assistant thread.
 *
 * Never throws into the caller: this runs after the send response, so a failure
 * here must not surface as a failed send. A turn that produces nothing simply
 * leaves the thread as the resident left it.
 */
export async function runResidentInboxAgentTurn(
  db: SupabaseClient,
  target: InboxThreadReplyTarget,
  residentUserId: string,
  residentEmail: string,
  incomingText: string,
): Promise<{ replied: boolean; reason?: string }> {
  const { data: row } = await db
    .from("portal_inbox_thread_records")
    .select("row_data")
    .eq("id", target.threadId)
    .maybeSingle();
  const rowData = (row?.row_data ?? null) as Record<string, unknown> | null;
  const managerUserId = managerUserIdFromAgentThreadId(target.threadId, residentUserId, rowData);
  if (!managerUserId) return { replied: false, reason: "thread_not_bound_to_manager" };

  const history = threadHistory(rowData, residentUserId);
  // The incoming message is already committed to the thread by the caller, so
  // drop the trailing copy rather than sending it to the model twice.
  const priorHistory = history.slice(0, -1);

  const result = await autoRespondToResidentInboxMessage(db, {
    managerUserId,
    residentEmail,
    incomingText: history.at(-1)?.body || incomingText,
    history: priorHistory,
    sessionId: target.threadId,
  });
  if (!result.ok) return { replied: false, reason: result.reason };

  let body = result.reply;
  if (result.pendingAction) {
    // Persist the proposal, exactly as the chat routes do. Without this the
    // assistant asks "want me to go ahead?" with nothing behind it — the
    // resident has no way to say yes, and the next turn just re-proposes.
    // `portal: "resident"` matters: the confirm gate is portal-bound and
    // refuses a claimed row whose portal does not match the calling route.
    const actionId = await createPendingActionForUser(db, {
      landlordId: residentUserId,
      userId: residentUserId,
      toolName: result.pendingAction.toolName,
      input: result.pendingAction.input,
      preview: result.pendingAction.preview,
      portal: "resident",
      proposalTraceId: result.traceId,
    });
    const label = result.pendingAction.preview?.title ?? result.pendingAction.toolName;
    body = actionId
      ? [result.reply, "", `Approve "${label}" in your portal and I will do it. Nothing has happened yet.`]
          .filter(Boolean)
          .join("\n")
      // Say so rather than leaving a promise the resident cannot act on.
      : [result.reply, "", `I could not prepare "${label}" just now — please try again shortly.`]
          .filter(Boolean)
          .join("\n");
  }

  await commitInboxThreadReply(db, target, { fromName: RESIDENT_AGENT_FROM_NAME, text: body });
  return { replied: true };
}
