import "server-only";

import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { normalizeConsentPhone } from "@/lib/sms-consent";
import type { SharedLineRole, TopicReplyMode } from "../contracts";
import { isMissingSchemaError } from "../config.server";
import { draftHouseAllowed } from "./draft-scope";
import { recordReplyOutcome } from "./outcomes.server";
import {
  applyManagerPick,
  decideNextMode,
  type ReplyOutcomeKind,
} from "./reply-modes";
import { classifyTopic, detectAlwaysEscalate, REPLY_TOPICS, type ReplyTopic, normalizeTopic } from "./topics";

export type TopicModeRow = {
  topic: ReplyTopic;
  mode: TopicReplyMode;
  ceiling: TopicReplyMode | null;
  modeSince: string;
};

function asMode(value: unknown): TopicReplyMode {
  return value === "draft" || value === "auto_review" ? value : "full_auto";
}

export async function loadTopicModes(db: SupabaseClient, workspaceId: string): Promise<TopicModeRow[]> {
  try {
    const { data, error } = await db
      .from("sms_topic_reply_modes")
      .select("topic, mode, ceiling, mode_since")
      .eq("workspace_id", workspaceId);
    if (error) {
      if (!isMissingSchemaError(error)) console.error("topic modes read failed", error.message);
      return [];
    }
    return ((data ?? []) as Record<string, unknown>[]).map((row) => ({
      topic: normalizeTopic(row.topic),
      mode: asMode(row.mode),
      ceiling: row.ceiling == null ? null : asMode(row.ceiling),
      modeSince: String(row.mode_since ?? new Date().toISOString()),
    }));
  } catch {
    return [];
  }
}

/**
 * What mode a reply on this topic runs in.
 *
 * A workspace with no rows at all has never picked a mode and keeps today's behaviour: every
 * reply goes out (full_auto). Once it has any row, a topic it has not seen yet starts in draft
 * for its first 14 days (the row is created now, so `mode_since` starts the clock).
 */
export async function resolveEffectiveMode(
  db: SupabaseClient,
  args: { workspaceId: string; topic: ReplyTopic },
): Promise<{ mode: TopicReplyMode; optedIn: boolean }> {
  const rows = await loadTopicModes(db, args.workspaceId);
  if (rows.length === 0) return { mode: "full_auto", optedIn: false };
  const row = rows.find((r) => r.topic === args.topic);
  if (row) return { mode: row.mode, optedIn: true };
  try {
    await db.from("sms_topic_reply_modes").upsert(
      { workspace_id: args.workspaceId, topic: args.topic, mode: "draft", ceiling: null, mode_since: new Date().toISOString() },
      { onConflict: "workspace_id,topic", ignoreDuplicates: true },
    );
  } catch {
    /* the next reply tries again */
  }
  return { mode: "draft", optedIn: true };
}

/** Manager picks a topic's ceiling in Settings. The mode can only be lowered by the pick, never raised. */
export async function setTopicCeiling(
  db: SupabaseClient,
  args: { workspaceId: string; topic: ReplyTopic; pick: TopicReplyMode },
): Promise<TopicModeRow | null> {
  const rows = await loadTopicModes(db, args.workspaceId);
  const existing = rows.find((r) => r.topic === args.topic) ?? null;
  const next = applyManagerPick(existing, args.pick);
  const changedMode = !existing || existing.mode !== next.mode;
  const now = new Date().toISOString();
  try {
    // The first pick opts the workspace in. Seed every OTHER topic at today's behaviour (full auto)
    // so picking one topic does not silently flip the rest to draft; only topics added to the
    // vocabulary later start in draft.
    if (rows.length === 0) {
      await db.from("sms_topic_reply_modes").upsert(
        REPLY_TOPICS.filter((t) => t !== args.topic).map((topic) => ({
          workspace_id: args.workspaceId,
          topic,
          mode: "full_auto",
          ceiling: null,
          mode_since: now,
        })),
        { onConflict: "workspace_id,topic", ignoreDuplicates: true },
      );
    }
    const { error } = await db.from("sms_topic_reply_modes").upsert(
      {
        workspace_id: args.workspaceId,
        topic: args.topic,
        mode: next.mode,
        ceiling: next.ceiling,
        mode_since: changedMode ? now : existing!.modeSince,
        updated_at: now,
      },
      { onConflict: "workspace_id,topic" },
    );
    if (error) return null;
    return { topic: args.topic, mode: next.mode, ceiling: next.ceiling, modeSince: changedMode ? now : existing!.modeSince };
  } catch {
    return null;
  }
}

export type ReplyGate =
  | { deliver: true; mode: TopicReplyMode; topic: ReplyTopic; held: false }
  | { deliver: false; mode: "draft"; topic: ReplyTopic; held: true; draftId: string | null };

/**
 * The one decision point before an AI reply is texted to a person.
 *
 *  - No opt-in (no rows): deliver, record nothing. Today's behaviour.
 *  - draft: hold it. The text is stored for the manager's composer; nothing is sent.
 *  - auto_review: deliver, and flag it for a manager's review.
 *  - full_auto: deliver, and count it.
 *
 * A text that touches money, legal, safety or fair housing is held as a draft in an opted-in
 * workspace whatever the topic's mode says. Fails OPEN (deliver) when the settings cannot be read,
 * so a settings outage never silences a reply that used to go out.
 */
export async function gateAiReply(
  db: SupabaseClient,
  args: {
    workspaceId: string | null;
    ownerUserId: string;
    role: SharedLineRole;
    phone: string;
    inboundText: string;
    replyText: string;
    propertyId?: string | null;
    conversationId?: string | null;
  },
): Promise<ReplyGate> {
  const topic = classifyTopic(args.inboundText);
  const open: ReplyGate = { deliver: true, mode: "full_auto", topic, held: false };
  try {
    if (!args.workspaceId) return open;
    const effective = await resolveEffectiveMode(db, { workspaceId: args.workspaceId, topic });
    if (!effective.optedIn) return open;
    const mode: TopicReplyMode = detectAlwaysEscalate(args.inboundText) ? "draft" : effective.mode;

    if (mode === "full_auto") {
      await recordReplyOutcome(db, { workspaceId: args.workspaceId, topic, mode, outcome: "sent_as_is", conversationId: args.conversationId });
      return { deliver: true, mode, topic, held: false };
    }
    const phoneKey = normalizeConsentPhone(args.phone);
    const draftId = randomUUID();
    let stored = false;
    if (phoneKey) {
      const { error } = await db.from("sms_ai_reply_drafts").insert({
        id: draftId,
        workspace_id: args.workspaceId,
        owner_user_id: args.ownerUserId,
        phone_key: phoneKey,
        role: args.role,
        topic,
        mode,
        inbound_text: args.inboundText.slice(0, 2000),
        body: args.replyText.slice(0, 1600),
        property_id: args.propertyId ?? null,
        status: "pending",
        created_at: new Date().toISOString(),
      });
      stored = !error;
      if (error && !isMissingSchemaError(error)) console.error("ai draft insert failed", error.message);
    }
    if (mode === "auto_review") return { deliver: true, mode, topic, held: false };
    // draft: never swallow a reply that could not be stored for the manager.
    if (!stored) return { deliver: true, mode: "full_auto", topic, held: false };
    return { deliver: false, mode: "draft", topic, held: true, draftId };
  } catch (error) {
    console.error("reply gate failed open", error instanceof Error ? error.message : "unknown");
    return open;
  }
}

/** A manager dismisses a held draft instead of sending it. */
export async function rejectDraft(
  db: SupabaseClient,
  args: { workspaceId: string; draftId: string; allowedPropertyIds?: readonly string[] | null },
): Promise<boolean> {
  const { data } = await db
    .from("sms_ai_reply_drafts")
    .select("id, topic, mode, status, property_id")
    .eq("id", args.draftId)
    .eq("workspace_id", args.workspaceId)
    .maybeSingle();
  const row = data as { id: string; topic: string; mode: string; status: string; property_id?: string | null } | null;
  if (!row || row.status !== "pending") return false;
  if (!draftHouseAllowed(row.property_id, args.allowedPropertyIds)) return false;
  const { error } = await db
    .from("sms_ai_reply_drafts")
    .update({ status: "rejected", decided_at: new Date().toISOString() })
    .eq("id", args.draftId)
    .eq("workspace_id", args.workspaceId);
  if (error) return false;
  await recordReplyOutcome(db, {
    workspaceId: args.workspaceId,
    topic: normalizeTopic(row.topic),
    mode: row.mode === "auto_review" ? "auto_review" : "draft",
    outcome: "rejected",
    turnRef: row.id,
  });
  return true;
}

/** A manager reviews an auto_review reply: fine as sent, or it needed correcting. */
export async function reviewAutoReply(
  db: SupabaseClient,
  args: { workspaceId: string; draftId: string; verdict: "ok" | "corrected"; allowedPropertyIds?: readonly string[] | null },
): Promise<boolean> {
  const { data } = await db
    .from("sms_ai_reply_drafts")
    .select("id, topic, mode, status, property_id")
    .eq("id", args.draftId)
    .eq("workspace_id", args.workspaceId)
    .eq("mode", "auto_review")
    .maybeSingle();
  const row = data as { id: string; topic: string; status: string; property_id?: string | null } | null;
  if (!row || row.status !== "pending") return false;
  if (!draftHouseAllowed(row.property_id, args.allowedPropertyIds)) return false;
  const { error } = await db
    .from("sms_ai_reply_drafts")
    .update({ status: "reviewed", decided_at: new Date().toISOString() })
    .eq("id", args.draftId)
    .eq("workspace_id", args.workspaceId);
  if (error) return false;
  await recordReplyOutcome(db, {
    workspaceId: args.workspaceId,
    topic: normalizeTopic(row.topic),
    mode: "auto_review",
    outcome: args.verdict === "ok" ? "sent_as_is" : "corrected_after",
    turnRef: row.id,
  });
  return true;
}

export const AUTO_REVIEW_EXPIRY_MS = 3 * 24 * 60 * 60 * 1000;

/**
 * Nightly: expire unreviewed auto_review flags as "fine" (no news is a pass), then re-evaluate
 * every opted-in topic against its last 100 outcomes. Returns what moved.
 */
export async function runReplyModeSweep(
  db: SupabaseClient,
  now: Date = new Date(),
): Promise<{ expired: number; moves: { workspaceId: string; topic: ReplyTopic; from: TopicReplyMode; to: TopicReplyMode; reason: string }[] }> {
  const moves: { workspaceId: string; topic: ReplyTopic; from: TopicReplyMode; to: TopicReplyMode; reason: string }[] = [];
  let expired = 0;
  try {
    const cutoff = new Date(now.getTime() - AUTO_REVIEW_EXPIRY_MS).toISOString();
    const { data: stale } = await db
      .from("sms_ai_reply_drafts")
      .select("id, workspace_id, topic")
      .eq("mode", "auto_review")
      .eq("status", "pending")
      .lt("created_at", cutoff)
      .limit(1000);
    for (const row of (stale ?? []) as { id: string; workspace_id: string; topic: string }[]) {
      const { error } = await db
        .from("sms_ai_reply_drafts")
        .update({ status: "reviewed", decided_at: now.toISOString() })
        .eq("id", row.id)
        .eq("workspace_id", row.workspace_id);
      if (error) continue;
      await recordReplyOutcome(db, { workspaceId: row.workspace_id, topic: normalizeTopic(row.topic), mode: "auto_review", outcome: "sent_as_is", turnRef: row.id });
      expired += 1;
    }

    const { data: rows, error } = await db.from("sms_topic_reply_modes").select("workspace_id, topic, mode, ceiling, mode_since").limit(5000);
    if (error) return { expired, moves };
    for (const row of (rows ?? []) as Record<string, unknown>[]) {
      const workspaceId = String(row.workspace_id);
      const topic = normalizeTopic(row.topic);
      const mode = asMode(row.mode);
      const { data: outcomes } = await db
        .from("sms_ai_reply_outcomes")
        .select("outcome")
        .eq("workspace_id", workspaceId)
        .eq("topic", topic)
        .order("created_at", { ascending: false })
        .limit(150);
      const list = ((outcomes ?? []) as { outcome: ReplyOutcomeKind }[]).map((o) => o.outcome);
      const decision = decideNextMode(
        { mode, ceiling: row.ceiling == null ? null : asMode(row.ceiling), modeSince: new Date(String(row.mode_since)) },
        list,
        now,
      );
      if (decision.next === mode) continue;
      const { error: updateError } = await db
        .from("sms_topic_reply_modes")
        .update({ mode: decision.next, mode_since: now.toISOString(), updated_at: now.toISOString() })
        .eq("workspace_id", workspaceId)
        .eq("topic", topic);
      if (!updateError) moves.push({ workspaceId, topic, from: mode, to: decision.next, reason: decision.reason });
    }
  } catch (error) {
    console.error("reply mode sweep failed", error instanceof Error ? error.message : "unknown");
  }
  return { expired, moves };
}
