import { createHash, timingSafeEqual } from "node:crypto";

/**
 * The three phone-shaped primitives the SMS code kept re-deriving, in one place.
 *
 * All three are security-relevant - a storage key, a rate-limit bucket, and a constant-time compare - and each had
 * grown four or five copies across `one-number/` and `sms/`. A second copy of a compare that is meant to be
 * constant-time is exactly the kind of thing that drifts into `===` in one file and nowhere else.
 */

/** The stored phone key: the last ten digits of an E.164 number (NANP). */
export function phoneKeyOf(phone: string): string {
  return String(phone ?? "").replace(/\D/g, "").slice(-10);
}

/**
 * A rate-limit bucket name for a phone: the first 32 hex characters of its SHA-256. The phone itself never becomes a
 * key (keys are logged), and half a SHA-256 is far past collision risk for a bucket.
 */
export function phoneRateKey(phoneKey: string): string {
  return createHash("sha256").update(String(phoneKey ?? "")).digest("hex").slice(0, 32);
}

/** Constant-time comparison of two hex digests. Different lengths are unequal without comparing. */
export function safeEqualHex(a: string, b: string): boolean {
  const left = Buffer.from(String(a ?? ""), "utf8");
  const right = Buffer.from(String(b ?? ""), "utf8");
  return left.length === right.length && timingSafeEqual(left, right);
}
