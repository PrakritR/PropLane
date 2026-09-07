import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  parseWebhookSignature,
  signWebhookPayload,
  verifyWebhookSignature,
  webhookSignatureDigest,
} from "@/lib/webhooks/signature";

/**
 * The signature is the whole trust story for a receiver: it is the only thing
 * distinguishing a PropLane delivery from anyone who guessed the endpoint URL.
 * The timestamp is inside the MAC on purpose — without it a captured delivery
 * replays forever.
 */
describe("webhook signature", () => {
  const secret = "whsec_test_secret";
  const body = JSON.stringify({ id: "d1", type: "work_order.created", data: { workOrderId: "wo_1" } });
  const now = 1_757_000_000_000;

  it("signs the timestamped body, not the body alone", () => {
    const header = signWebhookPayload(secret, body, now);
    const t = Math.floor(now / 1000);
    const expected = createHmac("sha256", secret).update(`${t}.${body}`, "utf8").digest("hex");

    expect(header).toBe(`t=${t},v1=${expected}`);
    // A MAC over the bare body would let the same digest be replayed under any `t`.
    expect(expected).not.toBe(createHmac("sha256", secret).update(body, "utf8").digest("hex"));
  });

  it("round-trips: a delivery we signed verifies", () => {
    expect(verifyWebhookSignature(secret, body, signWebhookPayload(secret, body, now), now)).toBe(true);
  });

  it("rejects a body, a secret, or a timestamp that was tampered with", () => {
    const header = signWebhookPayload(secret, body, now);

    expect(verifyWebhookSignature(secret, `${body} `, header, now)).toBe(false);
    expect(verifyWebhookSignature("whsec_other", body, header, now)).toBe(false);
    // Re-stamping a captured signature with a fresh `t` does not validate.
    const t = Math.floor(now / 1000);
    const replayed = header.replace(`t=${t}`, `t=${t + 1}`);
    expect(verifyWebhookSignature(secret, body, replayed, now)).toBe(false);
  });

  it("rejects a stale delivery even when the MAC is genuine", () => {
    const header = signWebhookPayload(secret, body, now);
    // 10 minutes later, outside the 5-minute tolerance.
    expect(verifyWebhookSignature(secret, body, header, now + 600_000)).toBe(false);
    // Still fine inside it.
    expect(verifyWebhookSignature(secret, body, header, now + 60_000)).toBe(true);
  });

  it("fails closed on a malformed header rather than throwing", () => {
    for (const header of ["", "garbage", "t=abc,v1=00", `t=${Math.floor(now / 1000)}`, "v1=deadbeef"]) {
      expect(verifyWebhookSignature(secret, body, header, now)).toBe(false);
    }
    // A short/long digest must not blow up timingSafeEqual's length requirement.
    expect(verifyWebhookSignature(secret, body, `t=${Math.floor(now / 1000)},v1=ab`, now)).toBe(false);
  });

  it("parses the documented header shape", () => {
    const t = Math.floor(now / 1000);
    expect(parseWebhookSignature(`t=${t},v1=${webhookSignatureDigest(secret, t, body)}`)).toEqual({
      timestamp: t,
      v1: webhookSignatureDigest(secret, t, body),
    });
  });
});
