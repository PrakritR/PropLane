import "server-only";

import { createHmac, randomInt, timingSafeEqual } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * The 4-digit code a MANAGER PHONE must repeat to confirm a write on the PropLane line (captain, Oct 20).
 *
 * Identity on that line is the inbound `From`, which a caller can spoof, and the service manager phone reaches every
 * PropLane Service workspace with the full manager catalog. So a write there is not confirmed by a bare YES: the ask
 * carries a code ("Reply YES 4821"), and only a reply that repeats it confirms. A spoofed sender never sees the ask,
 * so it never learns the code; the real phone always has it in the thread it is answering.
 *
 * The code is RANDOM per proposal and only its keyed hash is stored (`sms_confirmation_codes`), so a table dump does
 * not hand over live codes, and nothing can derive one from the proposal id. Three wrong codes cancel the proposal:
 * a 4-digit secret with no lockout is a 13-bit PIN that a spoofed sender could walk through blind, and every miss
 * would also bill a turn and text the real phone. A bare YES costs no attempt - it re-sends the ask with a FRESH
 * code, which is why the stored hash is replaceable but the attempt count is not.
 */

export const SMS_CONFIRMATION_CODE_MAX_ATTEMPTS = 3;
export const SMS_CONFIRMATION_CANCELLED_REPLY = "Too many wrong codes, so I cancelled that. Nothing was changed - start again when you are ready.";

const CODE_LENGTH = 4;
const CODE_TTL_MS = 30 * 60 * 1000;
const TABLE = "sms_confirmation_codes";

/** What a code can confirm. One row per subject, so the code for one job never answers another. */
export type SmsConfirmationSubjectKind = "pending_action" | "dispatch_approval" | "dispatch_quote" | "dispatch_invoice";

export type SmsConfirmationCheck = "ok" | "wrong" | "exhausted" | "unavailable";

type Subject = { kind: SmsConfirmationSubjectKind; subjectId: string };

/**
 * The signing key. No fallback constant: a security control that keys itself off a committed literal is not a
 * control, so with no secret configured there is no code and every coded confirmation is refused.
 */
function secret(): string | null {
  return process.env.PHONE_OTP_HMAC_SECRET?.trim() || process.env.SUPABASE_SERVICE_ROLE_KEY?.trim() || null;
}

export function smsConfirmationCodeConfigured(): boolean {
  return secret() !== null;
}

function hashCode(subject: Subject, code: string): string | null {
  const key = secret();
  if (!key) return null;
  return createHmac("sha256", key).update(`sms-confirm-v2:${subject.kind}:${subject.subjectId}:${code}`).digest("hex");
}

export function generateSmsConfirmationCode(): string {
  return String(randomInt(0, 10 ** CODE_LENGTH)).padStart(CODE_LENGTH, "0");
}

function safeEqualHex(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  return left.length === right.length && timingSafeEqual(left, right);
}

/**
 * Issue (or re-issue) the code for one subject and return it for the ask. The attempt count is deliberately NOT
 * reset: re-asking must not hand a guesser a fresh budget. `null` = no code could be issued (no secret, or the
 * store is unavailable), and the caller must then not promise a coded confirmation.
 */
export async function issueSmsConfirmationCode(
  db: SupabaseClient,
  input: { kind: SmsConfirmationSubjectKind; subjectId: string; now?: Date },
): Promise<string | null> {
  const subjectId = String(input.subjectId ?? "").trim();
  if (!subjectId) return null;
  const code = generateSmsConfirmationCode();
  const codeHash = hashCode({ kind: input.kind, subjectId }, code);
  if (!codeHash) return null;
  const now = input.now ?? new Date();
  // The attempt count is written ONLY when the row is created, so re-asking cannot hand a guesser a fresh budget.
  const { data: existing, error: readError } = await db
    .from(TABLE)
    .select("subject_id")
    .eq("subject_kind", input.kind)
    .eq("subject_id", subjectId)
    .maybeSingle();
  if (readError) return null;
  const { error } = await db.from(TABLE).upsert(
    {
      subject_kind: input.kind,
      subject_id: subjectId,
      code_hash: codeHash,
      consumed_at: null,
      expires_at: new Date(now.getTime() + CODE_TTL_MS).toISOString(),
      updated_at: now.toISOString(),
      ...(existing ? {} : { attempts: 0 }),
    },
    { onConflict: "subject_kind,subject_id" },
  );
  return error ? null : code;
}

/**
 * Check a presented code.
 *
 *   `ok`         it matched: the code is consumed and the caller may execute the write
 *   `wrong`      no live code, expired, or it did not match (the caller re-asks with a fresh code)
 *   `exhausted`  this was the third wrong code: the caller CANCELS the proposal
 *   `unavailable` the store or the key could not answer - refuse, never confirm
 *
 * The attempt is counted by compare-and-set BEFORE the comparison, so concurrent guesses cannot slip past the cap.
 */
export async function checkSmsConfirmationCode(
  db: SupabaseClient,
  input: { kind: SmsConfirmationSubjectKind; subjectId: string; code: string | null | undefined; now?: Date },
): Promise<SmsConfirmationCheck> {
  const subjectId = String(input.subjectId ?? "").trim();
  const presented = String(input.code ?? "").trim();
  if (!subjectId || !secret()) return "unavailable";
  const now = input.now ?? new Date();
  const { data, error } = await db
    .from(TABLE)
    .select("code_hash, attempts, expires_at, consumed_at")
    .eq("subject_kind", input.kind)
    .eq("subject_id", subjectId)
    .maybeSingle();
  if (error) return "unavailable";
  const row = (data ?? null) as { code_hash?: unknown; attempts?: unknown; expires_at?: unknown; consumed_at?: unknown } | null;
  if (!row) return "wrong";
  const attempts = Number(row.attempts) || 0;
  if (attempts >= SMS_CONFIRMATION_CODE_MAX_ATTEMPTS) return "exhausted";
  if (row.consumed_at) return "wrong";
  // An expired code is not a guess: a manager answering late is re-asked rather than charged an attempt.
  if (new Date(String(row.expires_at ?? 0)).getTime() <= now.getTime()) return "wrong";

  const { data: counted, error: countError } = await db
    .from(TABLE)
    .update({ attempts: attempts + 1, updated_at: now.toISOString() })
    .eq("subject_kind", input.kind)
    .eq("subject_id", subjectId)
    .eq("attempts", attempts)
    .select("subject_id");
  if (countError) return "unavailable";
  if (!counted || (counted as unknown[]).length === 0) return "wrong";

  const expected = String(row.code_hash ?? "");
  const presentedHash = /^\d{4}$/.test(presented) ? hashCode({ kind: input.kind, subjectId }, presented) : null;
  if (!presentedHash || !expected || !safeEqualHex(presentedHash, expected)) {
    return attempts + 1 >= SMS_CONFIRMATION_CODE_MAX_ATTEMPTS ? "exhausted" : "wrong";
  }
  await db
    .from(TABLE)
    .update({ consumed_at: now.toISOString(), updated_at: now.toISOString() })
    .eq("subject_kind", input.kind)
    .eq("subject_id", subjectId)
    .then(undefined, () => undefined);
  return "ok";
}

const AFFIRMATIVE = new Set(["YES", "Y", "CONFIRM", "CONFIRMED", "APPROVE", "APPROVED"]);

/**
 * "YES 4821" / "confirm 4821" -> the code the sender typed. Null when the reply carries no code at all (a bare YES),
 * so the caller re-sends the ask rather than counting a guess.
 */
export function readSmsConfirmationCode(body: string): string | null {
  const normalized = String(body ?? "").trim().replace(/[.!]+$/, "").replace(/\s+/g, " ");
  const match = /^([A-Za-z]+)[\s:,-]*([0-9]{4})$/.exec(normalized);
  if (!match || !AFFIRMATIVE.has(match[1]!.toUpperCase())) return null;
  return match[2]!;
}

/** The instruction line a coded ask ends with. */
export function codedConfirmationLine(code: string): string {
  return `Reply YES ${code} to confirm or NO to cancel.`;
}

const PLAIN_LINE = "Reply YES to confirm or NO to cancel.";

/** Swap the plain "Reply YES to confirm" instruction of a rendered preview for the coded one. */
export function withConfirmationCode(previewText: string, code: string): string {
  const text = String(previewText ?? "");
  const line = codedConfirmationLine(code);
  return text.includes(PLAIN_LINE) ? text.replace(PLAIN_LINE, line) : `${text.trimEnd()}\n\n${line}`;
}
