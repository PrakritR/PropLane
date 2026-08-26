/**
 * "Is anything queued to go out to this person, and when?" — in one line.
 *
 * A manager looking at a resident's charges or tours can see what is DUE but not what PropLane is
 * about to send about it. That is the difference between "I should chase this" and "a reminder
 * goes out tomorrow, leave it alone", and getting it wrong means chasing a resident PropLane is
 * already chasing.
 *
 * Shared by the payments group header, the payment detail, and the tours list, so one rule decides
 * what counts as queued everywhere. Pure — takes already-loaded rows, reads no storage.
 */

export type ScheduledSendLike = {
  /** ISO instant the message goes out. */
  sendAt: string;
  /** Only `"scheduled"` counts as queued; cancelled and sent do not. */
  status?: string | null;
};

export type ScheduledSendSummary = {
  /** How many sends are still queued. */
  count: number;
  /** ISO of the soonest queued send, or null when nothing is queued. */
  nextSendAt: string | null;
};

/**
 * Summarise the sends still ahead of `now`.
 *
 * A send in the PAST is not queued even when its row still says `scheduled` — the job may not have
 * swept it yet, and telling a manager a reminder is coming when its moment has passed is worse
 * than saying nothing. `cancelled` and `sent` are likewise excluded: the manager cancelled it, or
 * it has already gone.
 */
export function summariseScheduledSends(
  messages: readonly ScheduledSendLike[],
  now: number = Date.now(),
): ScheduledSendSummary {
  let count = 0;
  let nextSendAt: string | null = null;
  let nextMs = Infinity;

  for (const message of messages) {
    if ((message.status ?? "scheduled") !== "scheduled") continue;
    const ms = Date.parse(message.sendAt);
    if (!Number.isFinite(ms) || ms <= now) continue;
    count += 1;
    if (ms < nextMs) {
      nextMs = ms;
      nextSendAt = message.sendAt;
    }
  }

  return { count, nextSendAt };
}

/**
 * Badge text for a group header — `"1 reminder scheduled"` / `"3 reminders scheduled"`, or null
 * when nothing is queued so the caller renders no badge at all rather than an empty one.
 *
 * `noun` lets tours say "reminder" too while keeping the plural correct.
 */
export function scheduledSendBadgeLabel(
  summary: ScheduledSendSummary,
  noun = "reminder",
): string | null {
  if (summary.count <= 0) return null;
  return summary.count === 1 ? `1 ${noun} scheduled` : `${summary.count} ${noun}s scheduled`;
}
