import { describe, expect, it } from "vitest";
import {
  outboxStatusForTwilio,
  shouldApplyTwilioStatus,
  twilioStatusRank,
} from "@/lib/sms/delivery-status";

describe("Twilio delivery status ordering", () => {
  it("allows forward progress and idempotent duplicates", () => {
    expect(shouldApplyTwilioStatus("queued", "sent")).toBe(true);
    expect(shouldApplyTwilioStatus("sent", "delivered")).toBe(true);
    expect(shouldApplyTwilioStatus("delivered", "delivered")).toBe(true);
  });

  it("never regresses or replaces a terminal outcome", () => {
    expect(shouldApplyTwilioStatus("delivered", "sent")).toBe(false);
    expect(shouldApplyTwilioStatus("delivered", "failed")).toBe(false);
    expect(shouldApplyTwilioStatus("failed", "delivered")).toBe(false);
    expect(shouldApplyTwilioStatus("undelivered", "sent")).toBe(false);
  });

  it("maps provider states into durable outbox states", () => {
    expect(twilioStatusRank("delivered")).toBeGreaterThan(twilioStatusRank("sent"));
    expect(outboxStatusForTwilio("delivered")).toBe("delivered");
    expect(outboxStatusForTwilio("undelivered")).toBe("failed");
    expect(outboxStatusForTwilio("queued")).toBe("submitted");
  });
});

