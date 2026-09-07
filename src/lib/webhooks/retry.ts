/**
 * The retry schedule, kept pure so it is a table rather than arithmetic buried
 * in the delivery path.
 *
 * Five attempts total: the first is immediate, then 1m, 5m, 30m, 2h, 12h after
 * the failure that preceded it. A backoff that keeps doubling forever holds a
 * dead endpoint's rows in the queue indefinitely; `attempt >= MAX` retires the
 * delivery as `exhausted`.
 *
 * Consecutive failures across deliveries (not attempts within one) disable the
 * subscription, so a manager whose endpoint has been gone for a day stops
 * generating traffic and sees a plain "disabled" state in Settings.
 */

/** Delay before attempt N+1, indexed by the number of attempts already made. */
export const WEBHOOK_RETRY_DELAYS_MS = [
  60_000, // after attempt 1 → 1m
  5 * 60_000, // after attempt 2 → 5m
  30 * 60_000, // after attempt 3 → 30m
  2 * 60 * 60_000, // after attempt 4 → 2h
  12 * 60 * 60_000, // after attempt 5 → 12h
] as const;

/** Attempts made before a delivery is retired. */
export const WEBHOOK_MAX_ATTEMPTS = 5;

/** Consecutive failed deliveries before the subscription itself is disabled. */
export const WEBHOOK_FAILURE_DISABLE_THRESHOLD = 10;

/**
 * `null` means "no further attempt" — the caller marks the delivery
 * `exhausted`. `attemptsMade` is the count INCLUDING the one that just failed.
 */
export function nextWebhookAttemptAt(attemptsMade: number, nowMs = Date.now()): Date | null {
  if (!Number.isFinite(attemptsMade) || attemptsMade < 1) return new Date(nowMs);
  if (attemptsMade >= WEBHOOK_MAX_ATTEMPTS) return null;
  const delay = WEBHOOK_RETRY_DELAYS_MS[attemptsMade - 1] ?? null;
  return delay === null ? null : new Date(nowMs + delay);
}

/** A 2xx is success; everything else (including 3xx) is a failure worth retrying. */
export function isWebhookSuccessStatus(status: number): boolean {
  return Number.isFinite(status) && status >= 200 && status < 300;
}

export function shouldDisableSubscription(consecutiveFailures: number): boolean {
  return consecutiveFailures >= WEBHOOK_FAILURE_DISABLE_THRESHOLD;
}
