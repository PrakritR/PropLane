import "server-only";

import { createHmac, randomInt, randomUUID, timingSafeEqual } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { isMissingSchemaError } from "@/lib/one-number/config.server";
import { SHARED_LINE_OTP_RULES } from "@/lib/one-number/contracts";

/**
 * One-time codes keyed on a PHONE (`phone_otp_challenges`), for a person who may have no account
 * yet: unlocking a texted link, and binding a phone from a public link. (`phone_verifications` is
 * keyed on a signed-in user, so it cannot serve them.)
 *
 * Rules (`SHARED_LINE_OTP_RULES`): 6 digits, 10-minute expiry, 5 attempts then locked, at most 3
 * sends per phone per hour FOR ONE PURPOSE under a ceiling of 8 across every purpose, stored
 * hashed. A code is hashed with a keyed HMAC bound to its own challenge id and phone: a six-digit
 * code under a bare SHA-256 falls to a table dump in a second.
 * The code is only ever delivered to the phone the challenge is for; this module never takes a
 * destination from the person asking.
 */

export type PhoneOtpPurpose = "link_unlock" | "public_bind" | "sign_in" | "change_number_old" | "change_number_new" | "sms_signup" | "service_manager";

export type RequestOtpResult =
  | { ok: true; challengeId: string }
  | { ok: false; reason: "rate_limited" | "send_failed" | "unavailable" };

export type VerifyOtpResult =
  | { ok: true }
  | { ok: false; reason: "no_challenge" | "expired" | "locked" | "wrong_code" };

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
/**
 * Wrong codes allowed per phone PER PURPOSE in any 24 hours. Scoped to the purpose on purpose: the public-bind
 * door lets anyone holding a printed entry code name an arbitrary phone, so an account-wide count let a few
 * cheap wrong guesses there lock the owner of that phone out of their rent link and phone sign-in for a day.
 * The cap in SQL (`phone_auth_failed_code_count`) is the same number and the same scope.
 */
export const PHONE_LIFETIME_FAILED_CODE_CAP = 10;

/**
 * True when this phone has burned its failed-code budget for this purpose in the last 24 hours. A failure is an
 * attempt that did not verify its challenge; one attempt on a verified challenge is the success.
 * Fails closed: a read that errors locks rather than lets a guess through (a missing table means
 * there is no challenge to guess, which verify reports separately).
 */
async function phoneLockedOut(db: SupabaseClient, phoneKey: string, purpose: PhoneOtpPurpose, now: Date): Promise<boolean> {
  const { data, error } = await db
    .from("phone_otp_challenges")
    .select("attempts, verified_at")
    .eq("phone_key", phoneKey)
    .eq("purpose", purpose)
    .gte("created_at", new Date(now.getTime() - DAY_MS).toISOString());
  if (error) return !isMissingSchemaError(error);
  let failures = 0;
  for (const row of (data ?? []) as Record<string, unknown>[]) {
    failures += Math.max((Number(row.attempts) || 0) - (row.verified_at ? 1 : 0), 0);
  }
  return failures >= PHONE_LIFETIME_FAILED_CODE_CAP;
}

function otpSecret(): string {
  const configured = process.env.PHONE_OTP_HMAC_SECRET?.trim() || process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (configured) return configured;
  // Never a guessable key on a deployed server.
  if (process.env.NODE_ENV === "production") throw new Error("Phone code signing key is not configured.");
  return "dev-only-phone-otp-secret";
}

/** Keyed hash of a code, bound to its challenge and phone. */
export function hashOtpCode(challengeId: string, phoneKey: string, code: string): string {
  return createHmac("sha256", otpSecret()).update(`otp-v1:${challengeId}:${phoneKey}:${code}`).digest("hex");
}

export function generateOtpCode(): string {
  return String(randomInt(0, 10 ** SHARED_LINE_OTP_RULES.codeLength)).padStart(SHARED_LINE_OTP_RULES.codeLength, "0");
}

function safeEqualHex(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  return left.length === right.length && timingSafeEqual(left, right);
}

/** Digits only, trimmed; anything that is not exactly six digits can never match. */
export function normalizeOtpInput(raw: unknown): string | null {
  const digits = String(raw ?? "").replace(/\s+/g, "");
  return new RegExp(`^\\d{${SHARED_LINE_OTP_RULES.codeLength}}$`).test(digits) ? digits : null;
}

/** Text of the code message. One GSM-7 segment, no emoji or long dashes. */
export function otpMessageBody(code: string, contextLabel = "PropLane"): string {
  return `${code} is your ${contextLabel} code. It expires in ${SHARED_LINE_OTP_RULES.ttlMinutes} minutes. Do not share it.`;
}

/**
 * Create a challenge for a phone and send its code. `send` delivers the text (the shared-line
 * sender, or the workspace work number) and returns whether it went out. A send that fails leaves
 * no challenge behind and does not count against the phone's hourly allowance.
 */
export async function requestPhoneOtp(
  db: SupabaseClient,
  input: {
    phoneKey: string;
    purpose: PhoneOtpPurpose;
    /** What the code unlocks (a link id, an entry code): a code for one thing never opens another. */
    subjectId: string | null;
    send: (code: string, challengeId: string) => Promise<boolean>;
    now?: Date;
  },
): Promise<RequestOtpResult> {
  const now = input.now ?? new Date();
  const phoneKey = input.phoneKey.trim();
  if (!/^\d{10}$/.test(phoneKey)) return { ok: false, reason: "unavailable" };

  // A phone that has burned this purpose's failed-code budget gets no more texts for it until the failures age out.
  if (await phoneLockedOut(db, phoneKey, input.purpose, now)) return { ok: false, reason: "rate_limited" };

  // Two budgets, both per rolling hour: this purpose's own allowance, and a higher ceiling for the phone across
  // every purpose. Per purpose because the public-bind door takes an arbitrary phone from whoever holds a printed
  // entry code, so its sends must not be able to spend what a rent link or a phone sign-in needs.
  const since = new Date(now.getTime() - HOUR_MS).toISOString();
  const { data: recent, error: recentError } = await db
    .from("phone_otp_challenges")
    .select("id, purpose")
    .eq("phone_key", phoneKey)
    .gte("created_at", since);
  if (recentError) return { ok: false, reason: "unavailable" };
  const sendsThisHour = (recent ?? []) as Array<{ purpose?: unknown }>;
  if (sendsThisHour.length >= SHARED_LINE_OTP_RULES.maxSendsPerPhonePerHour) return { ok: false, reason: "rate_limited" };
  const sendsForPurpose = sendsThisHour.filter((row) => row.purpose === input.purpose).length;
  if (sendsForPurpose >= SHARED_LINE_OTP_RULES.maxSendsPerHour) return { ok: false, reason: "rate_limited" };

  // Only the newest code for this phone + purpose + subject can work.
  let retire = db
    .from("phone_otp_challenges")
    .update({ consumed_at: now.toISOString() })
    .eq("phone_key", phoneKey)
    .eq("purpose", input.purpose)
    .is("consumed_at", null);
  retire = input.subjectId === null ? retire.is("subject_id", null) : retire.eq("subject_id", input.subjectId);
  await retire;

  const challengeId = randomUUID();
  const code = generateOtpCode();
  const { error: insertError } = await db.from("phone_otp_challenges").insert({
    id: challengeId,
    phone_key: phoneKey,
    purpose: input.purpose,
    subject_id: input.subjectId,
    code_hash: hashOtpCode(challengeId, phoneKey, code),
    attempts: 0,
    created_at: now.toISOString(),
    expires_at: new Date(now.getTime() + SHARED_LINE_OTP_RULES.ttlMinutes * 60 * 1000).toISOString(),
  });
  if (insertError) return { ok: false, reason: "unavailable" };

  let sent = false;
  try {
    sent = await input.send(code, challengeId);
  } catch {
    sent = false;
  }
  if (!sent) {
    // A text that never left must not eat the phone's allowance or leave a live code behind.
    await db.from("phone_otp_challenges").delete().eq("id", challengeId);
    return { ok: false, reason: "send_failed" };
  }
  return { ok: true, challengeId };
}

/**
 * Check a presented code against the newest live challenge for this phone + purpose + subject.
 * The attempt is counted BEFORE the comparison and by compare-and-set, so concurrent guesses
 * cannot slip past the five-attempt limit; a lost race counts as a wrong guess. The sixth try and
 * every one after it is refused even with the right code.
 */
export async function verifyPhoneOtp(
  db: SupabaseClient,
  input: { phoneKey: string; purpose: PhoneOtpPurpose; subjectId: string | null; code: unknown; now?: Date },
): Promise<VerifyOtpResult> {
  const now = input.now ?? new Date();
  const phoneKey = input.phoneKey.trim();

  // Lifetime cap: ten wrong codes for this phone and purpose in 24 hours lock it, even for the right code.
  if (await phoneLockedOut(db, phoneKey, input.purpose, now)) return { ok: false, reason: "locked" };

  let query = db
    .from("phone_otp_challenges")
    .select("id, code_hash, attempts, expires_at")
    .eq("phone_key", phoneKey)
    .eq("purpose", input.purpose)
    .is("consumed_at", null)
    .order("created_at", { ascending: false })
    .limit(1);
  query = input.subjectId === null ? query.is("subject_id", null) : query.eq("subject_id", input.subjectId);
  const { data, error } = await query.maybeSingle();
  if (error) {
    if (isMissingSchemaError(error)) return { ok: false, reason: "no_challenge" };
    return { ok: false, reason: "no_challenge" };
  }
  if (!data) return { ok: false, reason: "no_challenge" };
  const row = data as Record<string, unknown>;
  const id = String(row.id);
  const attempts = Number(row.attempts) || 0;

  if (new Date(String(row.expires_at)).getTime() <= now.getTime()) return { ok: false, reason: "expired" };
  if (attempts >= SHARED_LINE_OTP_RULES.maxAttempts) return { ok: false, reason: "locked" };

  // Count the attempt first. Only one of several concurrent guesses can take attempt N.
  const { data: counted, error: countError } = await db
    .from("phone_otp_challenges")
    .update({ attempts: attempts + 1 })
    .eq("id", id)
    .eq("attempts", attempts)
    .select("id");
  if (countError || !counted || counted.length === 0) return { ok: false, reason: "wrong_code" };

  const presented = normalizeOtpInput(input.code);
  if (!presented) return { ok: false, reason: "wrong_code" };
  if (!safeEqualHex(hashOtpCode(id, phoneKey, presented), String(row.code_hash))) {
    return { ok: false, reason: "wrong_code" };
  }

  // One use only: whoever flips consumed_at wins. verified_at marks the success so the lifetime
  // failure count does not charge it; a database that has not run the column's migration retries
  // without it (the success then counts as one attempt, which is only ever stricter).
  const consume = (patch: Record<string, string>) =>
    db.from("phone_otp_challenges").update(patch).eq("id", id).is("consumed_at", null).select("id");
  let { data: consumed, error: consumeError } = await consume({ consumed_at: now.toISOString(), verified_at: now.toISOString() });
  if (consumeError && isMissingSchemaError(consumeError)) {
    ({ data: consumed, error: consumeError } = await consume({ consumed_at: now.toISOString() }));
  }
  if (consumeError || !consumed || consumed.length === 0) return { ok: false, reason: "wrong_code" };
  return { ok: true };
}
