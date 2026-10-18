import "server-only";

import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { TopicReplyMode } from "../contracts";
import { isMissingSchemaError } from "../config.server";
import type { ReplyOutcomeKind } from "./reply-modes";
import type { ReplyTopic } from "./topics";

/** One row per AI reply that reached (or was held for) a person. Never throws. */
export async function recordReplyOutcome(
  db: SupabaseClient,
  args: {
    workspaceId: string;
    topic: ReplyTopic;
    mode: TopicReplyMode;
    outcome: ReplyOutcomeKind;
    conversationId?: string | null;
    turnRef?: string | null;
  },
): Promise<void> {
  try {
    const { error } = await db.from("sms_ai_reply_outcomes").insert({
      id: randomUUID(),
      workspace_id: args.workspaceId,
      topic: args.topic,
      mode: args.mode,
      outcome: args.outcome,
      conversation_id: args.conversationId ?? null,
      turn_ref: args.turnRef ?? null,
      created_at: new Date().toISOString(),
    });
    if (error && !isMissingSchemaError(error)) console.error("reply outcome insert failed", error.message);
  } catch {
    /* counters are best effort */
  }
}
