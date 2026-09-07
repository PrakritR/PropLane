import { describe, expect, it } from "vitest";

import {
  isWebhookSuccessStatus,
  nextWebhookAttemptAt,
  shouldDisableSubscription,
  WEBHOOK_FAILURE_DISABLE_THRESHOLD,
  WEBHOOK_MAX_ATTEMPTS,
} from "@/lib/webhooks/retry";

/**
 * The schedule is pure so it reads as a table rather than arithmetic buried in
 * the delivery path — and so "does a dead endpoint ever stop being retried?" is
 * answerable without a database.
 */
describe("webhook retry schedule", () => {
  const now = 1_757_000_000_000;
  const minutes = (n: number) => n * 60_000;

  it("backs off 1m, 5m, 30m, 2h, 12h", () => {
    const delays = [1, 2, 3, 4].map((attempt) => nextWebhookAttemptAt(attempt, now)!.getTime() - now);
    expect(delays).toEqual([minutes(1), minutes(5), minutes(30), minutes(120)]);
  });

  it("retires the delivery after five attempts instead of retrying forever", () => {
    expect(WEBHOOK_MAX_ATTEMPTS).toBe(5);
    expect(nextWebhookAttemptAt(WEBHOOK_MAX_ATTEMPTS, now)).toBeNull();
    expect(nextWebhookAttemptAt(WEBHOOK_MAX_ATTEMPTS + 3, now)).toBeNull();
  });

  it("schedules immediately when no attempt has been made yet", () => {
    expect(nextWebhookAttemptAt(0, now)!.getTime()).toBe(now);
  });

  it("treats only 2xx as success — a 3xx is a failure, not a delivery", () => {
    expect(isWebhookSuccessStatus(200)).toBe(true);
    expect(isWebhookSuccessStatus(204)).toBe(true);
    expect(isWebhookSuccessStatus(299)).toBe(true);
    for (const status of [199, 301, 302, 400, 401, 404, 500, 503]) {
      expect(isWebhookSuccessStatus(status), String(status)).toBe(false);
    }
  });

  it("disables a subscription only once failures pile up", () => {
    expect(shouldDisableSubscription(WEBHOOK_FAILURE_DISABLE_THRESHOLD - 1)).toBe(false);
    expect(shouldDisableSubscription(WEBHOOK_FAILURE_DISABLE_THRESHOLD)).toBe(true);
  });
});
