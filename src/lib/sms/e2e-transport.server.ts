import "server-only";

import { appendFileSync } from "node:fs";
import { randomBytes } from "node:crypto";

/**
 * Dev-only capture transport for the end-to-end scenario harness (`scripts/one-number/e2e-scenarios.mjs`).
 *
 * With `SMS_E2E_CAPTURE_FILE` set on a NON-production runtime, every text that would leave through
 * `sendSms` is appended to that file as one JSON line and answered with a fake sent result, so the real
 * outbox, consent, quiet-hours, credit and delivery code all run and nothing reaches Twilio. The same
 * switch lets the harness's synthetic inbound MessageSids ("SMe2e...") pass the two Twilio look-ups the
 * webhook makes for them (message time, MMS bytes). Production, Vercel and an unset variable turn it off:
 * `e2eCaptureFile()` is null and every caller falls through to the real provider path.
 */
export function e2eCaptureFile(): string | null {
  if (process.env.NODE_ENV === "production" || process.env.VERCEL || process.env.VERCEL_ENV) return null;
  const file = process.env.SMS_E2E_CAPTURE_FILE?.trim();
  return file || null;
}

export function captureE2eSms(message: { to: string; from: string; body: string; mediaUrls?: string[] }): { sent: true; sid: string } | null {
  const file = e2eCaptureFile();
  if (!file) return null;
  const sid = `SMe2e${randomBytes(15).toString("hex").slice(0, 29)}`;
  appendFileSync(file, `${JSON.stringify({ at: new Date().toISOString(), sid, ...message })}\n`);
  return { sent: true, sid };
}

/** A harness MessageSid: "SMe2e" + 27 hex (32 hex after SM, so it passes the SID shape checks). */
export function isE2eMessageSid(sid: string): boolean {
  return Boolean(e2eCaptureFile()) && /^SMe2e[a-f0-9]{29}$/.test(sid.trim());
}

/** Media served by the harness itself (loopback only), fetched without account credentials. */
export function isE2eMediaUrl(raw: string): boolean {
  if (!e2eCaptureFile()) return false;
  try {
    const url = new URL(raw);
    return url.protocol === "http:" && (url.hostname === "127.0.0.1" || url.hostname === "localhost");
  } catch {
    return false;
  }
}
