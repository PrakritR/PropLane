/**
 * One-number knowledge: per-topic reply modes. Pure math, no I/O.
 *
 * Ladder: draft -> auto_review -> full_auto. A topic never climbs past the
 * manager's `ceiling`. Promotion needs >= 100 replies, <2% corrections over the
 * last 100, and >= 14 days in the current mode. Demotion (>5% over the last 100)
 * drops one step at once and needs no minimum of days.
 *
 * A workspace with NO row for a topic keeps today's behaviour: full_auto.
 */
import type { TopicReplyMode } from "../contracts";

export const MODE_LADDER: readonly TopicReplyMode[] = ["draft", "auto_review", "full_auto"];
export const NEW_TOPIC_DRAFT_DAYS = 14;
export const MODE_WINDOW = 100;
export const PROMOTE_BELOW_RATE = 0.02;
export const DEMOTE_ABOVE_RATE = 0.05;

export type ReplyOutcomeKind = "sent_as_is" | "edited" | "rejected" | "corrected_after" | "escalated";

/** Outcomes that count as a correction. An escalation is the agent declining, not an error. */
export function isCorrection(outcome: ReplyOutcomeKind): boolean {
  return outcome === "edited" || outcome === "rejected" || outcome === "corrected_after";
}

export function modeRank(mode: TopicReplyMode): number {
  return MODE_LADDER.indexOf(mode);
}

export function minMode(a: TopicReplyMode, b: TopicReplyMode): TopicReplyMode {
  return modeRank(a) <= modeRank(b) ? a : b;
}

/** What a manager's pick in Settings stores: the ceiling, and the mode clamped to it. */
export function applyManagerPick(
  existing: { mode: TopicReplyMode } | null,
  pick: TopicReplyMode,
): { mode: TopicReplyMode; ceiling: TopicReplyMode } {
  // No row yet means today's behaviour, full_auto, so the pick can only lower it.
  const current = existing?.mode ?? "full_auto";
  return { mode: minMode(current, pick), ceiling: pick };
}

export type ModeRow = {
  mode: TopicReplyMode;
  ceiling: TopicReplyMode | null;
  modeSince: Date;
};

/** Correction rate over the most recent `MODE_WINDOW` outcomes (newest first). */
export function correctionStats(outcomesNewestFirst: readonly ReplyOutcomeKind[]): { total: number; corrections: number; rate: number } {
  // An escalation is the agent declining to reply, not a reply a person judged.
  const window = outcomesNewestFirst.filter((o) => o !== "escalated").slice(0, MODE_WINDOW);
  const corrections = window.filter(isCorrection).length;
  return { total: window.length, corrections, rate: window.length === 0 ? 0 : corrections / window.length };
}

export type ModeDecision = { next: TopicReplyMode; reason: "promote" | "demote" | "hold" | "clamp_to_ceiling" };

export function decideNextMode(row: ModeRow, outcomesNewestFirst: readonly ReplyOutcomeKind[], now: Date): ModeDecision {
  const ceiling = row.ceiling ?? "full_auto";
  if (modeRank(row.mode) > modeRank(ceiling)) return { next: ceiling, reason: "clamp_to_ceiling" };
  const stats = correctionStats(outcomesNewestFirst);

  if (stats.total >= 20 && stats.rate > DEMOTE_ABOVE_RATE && modeRank(row.mode) > 0) {
    return { next: MODE_LADDER[modeRank(row.mode) - 1]!, reason: "demote" };
  }

  const daysInMode = (now.getTime() - row.modeSince.getTime()) / 86_400_000;
  if (
    stats.total >= MODE_WINDOW &&
    stats.rate < PROMOTE_BELOW_RATE &&
    daysInMode >= NEW_TOPIC_DRAFT_DAYS &&
    modeRank(row.mode) < modeRank(ceiling)
  ) {
    return { next: MODE_LADDER[modeRank(row.mode) + 1]!, reason: "promote" };
  }
  return { next: row.mode, reason: "hold" };
}
