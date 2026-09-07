/**
 * `PropLane-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256>`
 *
 * The signed string is `"<t>.<body>"`, not the body alone: without the
 * timestamp inside the MAC an attacker who captured one delivery could replay
 * it forever with a fresh `t`. A receiver checks the MAC and then that `t` is
 * recent (`isFreshWebhookTimestamp`), which is what makes the replay window
 * finite.
 *
 * Comparison is `timingSafeEqual` on equal-length buffers. `v1` is the version
 * tag so a future scheme can be added beside it rather than silently changing
 * the meaning of an existing header.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

export const WEBHOOK_SIGNATURE_HEADER = "PropLane-Signature";
export const WEBHOOK_EVENT_HEADER = "PropLane-Event";
export const WEBHOOK_DELIVERY_HEADER = "PropLane-Delivery";

/** How far a delivery's timestamp may be from the receiver's clock. */
export const WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS = 300;

export function webhookSignatureDigest(secret: string, timestamp: number, body: string): string {
  return createHmac("sha256", secret).update(`${timestamp}.${body}`, "utf8").digest("hex");
}

export function signWebhookPayload(secret: string, body: string, nowMs = Date.now()): string {
  const timestamp = Math.floor(nowMs / 1000);
  return `t=${timestamp},v1=${webhookSignatureDigest(secret, timestamp, body)}`;
}

export function parseWebhookSignature(header: string): { timestamp: number; v1: string } | null {
  let timestamp: number | null = null;
  let v1: string | null = null;
  for (const part of String(header ?? "").split(",")) {
    const [key, ...rest] = part.trim().split("=");
    const value = rest.join("=");
    if (key === "t" && /^\d+$/.test(value)) timestamp = Number(value);
    else if (key === "v1" && /^[0-9a-f]+$/i.test(value)) v1 = value.toLowerCase();
  }
  return timestamp !== null && v1 !== null ? { timestamp, v1 } : null;
}

export function isFreshWebhookTimestamp(
  timestamp: number,
  nowMs = Date.now(),
  toleranceSeconds = WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS,
): boolean {
  return Math.abs(Math.floor(nowMs / 1000) - timestamp) <= toleranceSeconds;
}

/** Fails closed on a malformed header, a stale timestamp, or a length mismatch. */
export function verifyWebhookSignature(
  secret: string,
  body: string,
  header: string,
  nowMs = Date.now(),
  toleranceSeconds = WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS,
): boolean {
  const parsed = parseWebhookSignature(header);
  if (!parsed) return false;
  if (!isFreshWebhookTimestamp(parsed.timestamp, nowMs, toleranceSeconds)) return false;
  const expected = Buffer.from(webhookSignatureDigest(secret, parsed.timestamp, body), "utf8");
  const supplied = Buffer.from(parsed.v1, "utf8");
  if (expected.length !== supplied.length) return false;
  return timingSafeEqual(expected, supplied);
}
