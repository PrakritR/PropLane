import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import type { SharedLineRole } from "@/lib/one-number/contracts";
import { loadThreadPause, pauseThreadAi, resumeThreadAi } from "@/lib/one-number/session.server";
import { loadOwnedProperty } from "@/lib/one-number/knowledge/scope.server";
import { createEntry } from "@/lib/one-number/knowledge/store.server";
import { isMissingSchemaError } from "@/lib/one-number/config.server";
import type { KnowledgeAudience } from "@/lib/one-number/knowledge/types";
import { normalizeTopic } from "@/lib/one-number/knowledge/topics";
import { writeAuditLog } from "@/lib/tools/audit";
import {
  REVIEW_AGENT_TEXT_MAX,
  REVIEW_CORRECTION_MAX,
  REVIEW_REASON_MAX,
  cleanText,
  emptyReviewState,
  isReviewThreadKey,
  phoneKeyFromReviewThreadKey,
  type AssistantReviewRow,
  type ReviewAuditAction,
  type ReviewKind,
  type ThreadReviewState,
} from "@/lib/assistant-review/model";

type Row = Record<string, unknown>;
const str = (v: unknown): string => (typeof v === "string" ? v.trim() : v == null ? "" : String(v).trim());
const TABLE = "assistant_thread_reviews";
const COLUMNS =
  "id, workspace_id, owner_user_id, thread_key, kind, message_ref, reason, body, agent_text, knowledge_entry_id, created_at, resolved_at";

function mapRow(raw: Row): AssistantReviewRow {
  return {
    id: str(raw.id),
    workspaceId: str(raw.workspace_id),
    threadKey: str(raw.thread_key),
    kind: str(raw.kind) as ReviewKind,
    messageRef: str(raw.message_ref) || null,
    reason: str(raw.reason) || null,
    body: str(raw.body) || null,
    agentText: str(raw.agent_text) || null,
    knowledgeEntryId: str(raw.knowledge_entry_id) || null,
    createdAt: str(raw.created_at),
    resolvedAt: str(raw.resolved_at) || null,
  };
}

/** Who acts: the signed-in person, the workspace's owner, and the workspace. All re-derived server-side by the caller. */
export type ReviewActor = {
  db: SupabaseClient;
  userId: string;
  workspaceId: string;
  ownerUserId: string;
  /**
   * Houses a DELEGATED actor (a co-manager seat) may write knowledge for. Absent/null = unrestricted (the workspace owner,
   * or a platform admin on a workspace they run). An array, even an empty one, makes the actor delegated: a correction must
   * then name one of these houses and can never be team-wide or audience "all".
   */
  allowedPropertyIds?: readonly string[] | null;
};

/**
 * Is the assistant paused on this conversation? Honored by EVERY auto-reply path (SMS leasing agent, the resident thread
 * auto-reply, web chat). `threadKeys` is every name the conversation goes by (its id, its conversation key, `sms:<phone>`):
 * any open pause row on any of them pauses it. A table that does not exist yet is "not paused" (production runs code before
 * its migrations); any other unreadable state is PAUSED: the assistant stays quiet and the person reads the message, never
 * the reverse.
 */
export async function isAssistantPaused(
  db: SupabaseClient,
  input: {
    workspaceId: string | null | undefined;
    threadKeys: ReadonlyArray<string | null | undefined>;
    /** Also read the text line's own pause state (default). The inbound pipeline reads that itself and passes false. */
    includeLineState?: boolean;
  },
): Promise<boolean> {
  const workspaceId = str(input.workspaceId);
  const keys = [...new Set(input.threadKeys.map(str).filter((k) => isReviewThreadKey(k)))];
  if (!workspaceId || keys.length === 0) return false;
  try {
    const { data, error } = await db
      .from(TABLE)
      .select("id")
      .eq("workspace_id", workspaceId)
      .eq("kind", "pause")
      .is("resolved_at", null)
      .in("thread_key", keys)
      .limit(1);
    if (error) return !isMissingSchemaError(error);
    if (((data ?? []) as Row[]).length > 0) return true;
    // A text thread is also paused by the line's own state (a person typed HUMAN, or a pause from before this table).
    for (const key of input.includeLineState === false ? [] : keys) {
      const phoneKey = phoneKeyFromReviewThreadKey(key);
      if (phoneKey && (await loadThreadPause(db, phoneKey, workspaceId))) return true;
    }
    return false;
  } catch {
    return true;
  }
}

export async function loadThreadReview(db: SupabaseClient, workspaceId: string, threadKey: string): Promise<ThreadReviewState | null> {
  if (!isReviewThreadKey(threadKey)) return null;
  try {
    const { data, error } = await db
      .from(TABLE)
      .select(COLUMNS)
      .eq("workspace_id", workspaceId)
      .eq("thread_key", threadKey)
      .order("created_at", { ascending: true })
      .limit(200);
    if (error) return isMissingSchemaError(error) ? emptyReviewState() : null;
    const rows = ((data ?? []) as Row[]).map(mapRow);
    const phoneKey = phoneKeyFromReviewThreadKey(threadKey);
    const linePaused = phoneKey ? Boolean(await loadThreadPause(db, phoneKey, workspaceId)) : false;
    return {
      paused: linePaused || rows.some((r) => r.kind === "pause" && !r.resolvedAt),
      flags: rows.filter((r) => r.kind === "flag"),
      corrections: rows.filter((r) => r.kind === "correction"),
    };
  } catch {
    return null;
  }
}

/** The "Assistant review" list: this workspace's open flags and paused conversations, newest first. */
export async function listOpenReviews(db: SupabaseClient, workspaceId: string): Promise<AssistantReviewRow[] | null> {
  try {
    const { data, error } = await db
      .from(TABLE)
      .select(COLUMNS)
      .eq("workspace_id", workspaceId)
      .in("kind", ["flag", "pause"])
      .is("resolved_at", null)
      .order("created_at", { ascending: false })
      .limit(100);
    if (error) return isMissingSchemaError(error) ? [] : null;
    return ((data ?? []) as Row[]).map(mapRow);
  } catch {
    return null;
  }
}

async function audit(actor: ReviewActor, action: ReviewAuditAction, summary: Record<string, unknown>, dedupeKey: string): Promise<boolean> {
  const out = await writeAuditLog(
    { db: actor.db, landlordId: actor.ownerUserId, userId: actor.userId },
    { action, toolName: action, inputSummary: summary, resultSummary: { applied: true }, dedupeKey },
  ).catch(() => ({ recorded: false as const, duplicate: false as const, error: "audit failed" }));
  return out.recorded || ("duplicate" in out && out.duplicate === true);
}

export type ReviewResult<T extends object = object> = ({ ok: true; auditRecorded: boolean } & T) | { ok: false; error: string; status: number };

const unavailable = { ok: false as const, error: "Could not save that. Try again.", status: 503 };

export async function flagReply(
  actor: ReviewActor,
  input: { threadKey: string; messageRef: string; reason: string; agentText?: string },
): Promise<ReviewResult<{ id: string }>> {
  const reason = cleanText(input.reason, REVIEW_REASON_MAX);
  const messageRef = cleanText(input.messageRef, 200);
  if (!isReviewThreadKey(input.threadKey) || !messageRef) return { ok: false, error: "Pick the reply to flag.", status: 400 };
  if (!reason) return { ok: false, error: "Say what was wrong.", status: 400 };
  try {
    const { data: existing } = await actor.db
      .from(TABLE).select("id").eq("workspace_id", actor.workspaceId).eq("thread_key", input.threadKey)
      .eq("kind", "flag").eq("message_ref", messageRef).is("resolved_at", null).limit(1);
    const open = ((existing ?? []) as Row[])[0];
    if (open) return { ok: true, id: str(open.id), auditRecorded: true };
    const { data, error } = await actor.db
      .from(TABLE)
      .insert({
        workspace_id: actor.workspaceId,
        owner_user_id: actor.ownerUserId,
        thread_key: input.threadKey,
        kind: "flag",
        message_ref: messageRef,
        reason,
        agent_text: cleanText(input.agentText, REVIEW_AGENT_TEXT_MAX) || null,
        created_by_user_id: actor.userId,
      })
      .select("id")
      .single();
    if (error || !data) return unavailable;
    const id = str((data as Row).id);
    const auditRecorded = await audit(actor, "assistant_reply_flag", { workspaceId: actor.workspaceId, threadKey: input.threadKey, messageRef }, `assistant_reply_flag:${id}`);
    return { ok: true, id, auditRecorded };
  } catch {
    return unavailable;
  }
}

/**
 * Write what the answer should have been. Stored on the thread AND as an approved knowledge entry the assistant reads through
 * `lookup_property_knowledge` (quoted data, not an instruction). A correction resolves the open flag on the same reply.
 */
export async function correctReply(
  actor: ReviewActor,
  input: {
    threadKey: string;
    messageRef: string;
    /** What the person asked, so the entry is findable ("Is there parking?"). */
    question: string;
    correction: string;
    propertyId?: string | null;
    audience: KnowledgeAudience;
    agentText?: string;
  },
): Promise<ReviewResult<{ id: string; knowledgeEntryId: string | null }>> {
  const correction = cleanText(input.correction, REVIEW_CORRECTION_MAX);
  const messageRef = cleanText(input.messageRef, 200);
  const question = cleanText(input.question, 300) || "Correction";
  if (!isReviewThreadKey(input.threadKey) || !messageRef) return { ok: false, error: "Pick the reply to correct.", status: 400 };
  if (!correction) return { ok: false, error: "Write what the answer should have been.", status: 400 };
  const propertyId = input.propertyId?.trim() || null;
  // Same rules as `saveKnowledgeAnswerTool`: the house must be this workspace's (the id is a request value, never trusted),
  // and a delegated seat writes only for its assigned houses, never team-wide.
  if (propertyId) {
    const owned = await loadOwnedProperty(actor.db, actor.ownerUserId, propertyId);
    if (!owned || owned.workspaceId !== actor.workspaceId) return { ok: false, error: "That house is not in this workspace.", status: 403 };
  }
  if (actor.allowedPropertyIds) {
    if (!propertyId || !actor.allowedPropertyIds.includes(propertyId) || input.audience === "all") {
      return { ok: false, error: "You can only correct answers for the houses assigned to you.", status: 403 };
    }
  }
  try {
    const entry = await createEntry(actor.db, {
      workspaceId: actor.workspaceId,
      propertyId,
      topic: normalizeTopic(undefined),
      question,
      answer: correction,
      status: "approved",
      source: "manager_answer",
      sourceRef: `correction:${input.threadKey}`.slice(0, 200),
      audience: input.audience,
      createdBy: actor.userId,
    });
    const knowledgeEntryId = entry.ok ? entry.entry.id : null;
    const { data, error } = await actor.db
      .from(TABLE)
      .insert({
        workspace_id: actor.workspaceId,
        owner_user_id: actor.ownerUserId,
        thread_key: input.threadKey,
        kind: "correction",
        message_ref: messageRef,
        body: correction,
        agent_text: cleanText(input.agentText, REVIEW_AGENT_TEXT_MAX) || null,
        knowledge_entry_id: knowledgeEntryId,
        created_by_user_id: actor.userId,
      })
      .select("id")
      .single();
    if (error || !data) return unavailable;
    const id = str((data as Row).id);
    await actor.db
      .from(TABLE)
      .update({ resolved_at: new Date().toISOString(), resolved_by_user_id: actor.userId })
      .eq("workspace_id", actor.workspaceId).eq("thread_key", input.threadKey).eq("kind", "flag").eq("message_ref", messageRef).is("resolved_at", null);
    const auditRecorded = await audit(actor, "assistant_reply_correct", { workspaceId: actor.workspaceId, threadKey: input.threadKey, messageRef, knowledgeEntryId }, `assistant_reply_correct:${id}`);
    return { ok: true, id, knowledgeEntryId, auditRecorded };
  } catch {
    return unavailable;
  }
}

/** Pause the assistant on one conversation (also "Take over"). Idempotent: an open pause stays the one pause. */
export async function pauseAssistantThread(actor: ReviewActor, input: { threadKey: string; reason?: string; role?: SharedLineRole | null }): Promise<ReviewResult<{ paused: true }>> {
  if (!isReviewThreadKey(input.threadKey)) return { ok: false, error: "Pick a conversation.", status: 400 };
  try {
    if (await isAssistantPaused(actor.db, { workspaceId: actor.workspaceId, threadKeys: [input.threadKey] })) {
      return { ok: true, paused: true, auditRecorded: true };
    }
    const { data, error } = await actor.db
      .from(TABLE)
      .insert({
        workspace_id: actor.workspaceId,
        owner_user_id: actor.ownerUserId,
        thread_key: input.threadKey,
        kind: "pause",
        reason: cleanText(input.reason, REVIEW_REASON_MAX) || null,
        created_by_user_id: actor.userId,
      })
      .select("id")
      .single();
    // The unique index makes a racing second pause a no-op, not a failure.
    if (error && (error as { code?: string }).code !== "23505") return unavailable;
    // A text thread: the line's own pause state too, so the inbound pipeline and a typed HUMAN agree with this row.
    const phoneKey = phoneKeyFromReviewThreadKey(input.threadKey);
    if (phoneKey) await pauseThreadAi(actor.db, { phoneKey, workspaceId: actor.workspaceId, role: input.role ?? "prospect", reason: "manager_takeover" }).catch(() => false);
    const id = str((data as Row | null)?.id) || input.threadKey;
    const auditRecorded = await audit(actor, "assistant_thread_pause", { workspaceId: actor.workspaceId, threadKey: input.threadKey }, `assistant_thread_pause:${id}`);
    return { ok: true, paused: true, auditRecorded };
  } catch {
    return unavailable;
  }
}

export async function resumeAssistantThread(actor: ReviewActor, input: { threadKey: string }): Promise<ReviewResult<{ paused: false }>> {
  if (!isReviewThreadKey(input.threadKey)) return { ok: false, error: "Pick a conversation.", status: 400 };
  try {
    const { data, error } = await actor.db
      .from(TABLE)
      .update({ resolved_at: new Date().toISOString(), resolved_by_user_id: actor.userId })
      .eq("workspace_id", actor.workspaceId).eq("thread_key", input.threadKey).eq("kind", "pause").is("resolved_at", null)
      .select("id");
    if (error) return unavailable;
    const phoneKey = phoneKeyFromReviewThreadKey(input.threadKey);
    if (phoneKey) await resumeThreadAi(actor.db, { phoneKey, workspaceId: actor.workspaceId, resumedBy: actor.userId }).catch(() => false);
    const ids = ((data ?? []) as Row[]).map((r) => str(r.id));
    const auditRecorded = await audit(actor, "assistant_thread_resume", { workspaceId: actor.workspaceId, threadKey: input.threadKey, resumed: ids.length }, `assistant_thread_resume:${ids[0] ?? input.threadKey}:${Date.now()}`);
    return { ok: true, paused: false, auditRecorded };
  } catch {
    return unavailable;
  }
}

/** Close a flag without a correction ("the reply was fine after all"). Workspace-scoped. */
export async function resolveFlag(actor: ReviewActor, id: string): Promise<ReviewResult> {
  try {
    const { error } = await actor.db
      .from(TABLE)
      .update({ resolved_at: new Date().toISOString(), resolved_by_user_id: actor.userId })
      .eq("id", id).eq("workspace_id", actor.workspaceId).eq("kind", "flag").is("resolved_at", null);
    return error ? unavailable : { ok: true, auditRecorded: true };
  } catch {
    return unavailable;
  }
}
