import { describe, expect, it } from "vitest";
import {
  isManualSmsOutcomeUnknown,
  resolveManualSmsAttempt,
} from "@/lib/sms/manual-send-attempt";

describe("manual SMS attempt idempotency", () => {
  it("reuses per-recipient keys for an unchanged attempt", () => {
    const first = resolveManualSmsAttempt(
      null,
      "same draft",
      2,
      () => "attempt-one",
    );
    const repeated = resolveManualSmsAttempt(
      first,
      "same draft",
      2,
      () => "attempt-two",
    );

    expect(repeated).toBe(first);
    expect(repeated.idempotencyKeys).toEqual([
      "manual_attempt-one_0",
      "manual_attempt-one_1",
    ]);
  });

  it("creates new keys after the draft changes", () => {
    const first = resolveManualSmsAttempt(
      null,
      "first draft",
      1,
      () => "attempt-one",
    );
    const changed = resolveManualSmsAttempt(
      first,
      "edited draft",
      1,
      () => "attempt-two",
    );

    expect(changed.idempotencyKeys).toEqual(["manual_attempt-two_0"]);
  });

  it("recognizes both supported unknown-outcome response shapes", () => {
    expect(
      isManualSmsOutcomeUnknown({ code: "delivery_outcome_unknown" }),
    ).toBe(true);
    expect(isManualSmsOutcomeUnknown({ status: "unknown" })).toBe(true);
    expect(isManualSmsOutcomeUnknown({ status: "submitted" })).toBe(false);
  });
});
