import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { track } from "@/lib/analytics/posthog";
import { scoreSmsDelivery } from "@/lib/observability/langfuse";
import { isMissingSchemaError } from "@/lib/one-number/shared-line-number.server";
import type { SmsIntent } from "@/lib/one-number/intent";

/**
 * The learning loop's per-turn record: what the text was (intent), who answered
 * (lane, model), how fast (first bubble, total) and what happened to the reply
 * (sent, held as a draft, or none). Stored on the INBOUND projection turn of the
 * text that was answered (additive columns, migration 20261018210000), sent to
 * PostHog as `sms_reply_sent` (ids and numbers only, no text, no phone) and to
 * Langfuse as scores on the turn's trace.
 */

export type TurnLane = "fast_path" | "agent" | "scripted" | "handler";
export type TurnReplyStatus = "sent" | "draft" | "none";

export type TurnMetrics = {
  intent: SmsIntent;
  lane: TurnLane;
  /** The model that wrote the reply; null for a fast-path or scripted reply. */
  modelUsed: string | null;
  bubbleCount: number;
  /** Receipt to the first bubble handed to the transport. */
  firstBubbleMs: number | null;
  /** Receipt to the end of this turn (the last bubble is sent after the response). */
  totalLatencyMs: number | null;
  replyStatus: TurnReplyStatus;
};

/** Milliseconds from `startIso` (when the text was received) to now, clamped to a sane range. */
export function elapsedSince(startIso: string | null | undefined, now = Date.now()): number | null {
  const start = Date.parse(String(startIso ?? ""));
  if (!Number.isFinite(start)) return null;
  const ms = now - start;
  return ms >= 0 && ms < 10 * 60_000 ? Math.round(ms) : null;
}

export async function recordSmsTurnMetrics(
  db: SupabaseClient,
  args: {
    ownerUserId: string;
    messageSid: string;
    role: string;
    workspaceId?: string | null;
    traceId?: string | null;
    metrics: TurnMetrics;
  },
): Promise<void> {
  const m = args.metrics;
  try {
    const { error } = await db
      .from("sms_projection_turns")
      .update({
        intent: m.intent,
        reply_lane: m.lane,
        model_used: m.modelUsed,
        fast_path: m.lane === "fast_path",
        bubble_count: m.bubbleCount,
        first_bubble_ms: m.firstBubbleMs,
        total_latency_ms: m.totalLatencyMs,
        reply_status: m.replyStatus,
        replied_at: m.replyStatus === "none" ? null : new Date().toISOString(),
      })
      .eq("owner_manager_user_id", args.ownerUserId)
      .eq("source_event_id", args.messageSid)
      .eq("direction", "inbound");
    if (error && !isMissingSchemaError(error)) console.warn("sms turn metrics not stored", error.code ?? "unknown");
  } catch {
    /* the log must never break a reply */
  }

  if (m.replyStatus === "sent") {
    track("sms_reply_sent", args.ownerUserId, {
      role: args.role,
      intent: m.intent,
      lane: m.lane,
      model: m.modelUsed ?? "none",
      fast_path: m.lane === "fast_path",
      bubble_count: m.bubbleCount,
      ...(m.firstBubbleMs !== null ? { first_bubble_ms: m.firstBubbleMs } : {}),
      ...(m.totalLatencyMs !== null ? { total_latency_ms: m.totalLatencyMs } : {}),
    });
  }
  if (args.traceId) {
    try {
      await scoreSmsDelivery({
        traceId: args.traceId,
        intent: m.intent,
        lane: m.lane,
        firstBubbleMs: m.firstBubbleMs,
        totalLatencyMs: m.totalLatencyMs,
        bubbleCount: m.bubbleCount,
      });
    } catch {
      /* best effort */
    }
  }
}
