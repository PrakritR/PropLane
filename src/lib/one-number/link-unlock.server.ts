import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { roleForLinkPurpose, sendWorkspacePhoneText } from "@/lib/one-number/link-text.server";
import {
  createLinkSession,
  type PhoneBoundLink,
} from "@/lib/one-number/links.server";
import {
  otpMessageBody,
  requestPhoneOtp,
  verifyPhoneOtp,
  type RequestOtpResult,
  type VerifyOtpResult,
} from "@/lib/one-number/phone-otp.server";

/**
 * The code step of a protected link. The code goes ONLY to the phone the link is bound to
 * (`link.phoneKey`); the person holding the link never types a destination. So a link forwarded to
 * someone else reaches a code that lands on the original phone, which the forwardee cannot read.
 * A correct code opens a verified page session (30 minutes for rent and payouts, 7 days otherwise).
 */
export async function requestLinkUnlockCode(
  db: SupabaseClient,
  link: PhoneBoundLink,
  now: Date = new Date(),
): Promise<RequestOtpResult> {
  if (!link.workspaceId) return { ok: false, reason: "unavailable" };
  const workspaceId = link.workspaceId;
  return requestPhoneOtp(db, {
    phoneKey: link.phoneKey,
    purpose: "link_unlock",
    subjectId: link.id,
    now,
    send: (code, challengeId) =>
      sendWorkspacePhoneText(db, {
        workspaceId,
        phoneKey: link.phoneKey,
        body: otpMessageBody(code),
        role: roleForLinkPurpose(link.purpose),
        idempotencyKey: `phone-code:${challengeId}`,
        basis: { kind: "code" },
      }),
  });
}

export type LinkUnlockResult =
  | { ok: true; session: { token: string; expiresAt: Date; maxAgeSeconds: number } }
  | { ok: false; reason: Extract<VerifyOtpResult, { ok: false }>["reason"] | "session_failed" };

export async function verifyLinkUnlockCode(
  db: SupabaseClient,
  link: PhoneBoundLink,
  code: unknown,
  now: Date = new Date(),
): Promise<LinkUnlockResult> {
  const verified = await verifyPhoneOtp(db, {
    phoneKey: link.phoneKey,
    purpose: "link_unlock",
    subjectId: link.id,
    code,
    now,
  });
  if (!verified.ok) return verified;
  const session = await createLinkSession(db, link, now);
  return session ? { ok: true, session } : { ok: false, reason: "session_failed" };
}
