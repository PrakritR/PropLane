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
/**
 * A per-PHONE budget across every proposal (security review, Oct 20): the three-guess cap above belongs to one proposal,
 * so a spoofer who keeps raising new ones (or re-quoting a stay) gets three blind guesses each. Ten wrong codes from one
 * number in 24 hours lock the coded path for that number; the portal is the way through.
 */
export const SMS_CONFIRMATION_PHONE_FAILURE_CAP = 10;
export const SMS_CONFIRMATION_PHONE_WINDOW_MS = 24 * 60 * 60 * 1000;
export const SMS_CONFIRMATION_LOCKED_REPLY = "Too many wrong codes from this number, so confirming by text is paused. Please use the PropLane portal instead.";
export const SMS_CONFIRMATION_CANCELLED_REPLY = "Too many wrong codes, so I cancelled that. Nothing was changed - start again when you are ready.";

const CODE_LENGTH = 4;
const CODE_TTL_MS = 30 * 60 * 1000;
const TABLE = "sms_confirmation_codes";
const FAILURES_TABLE = "sms_confirmation_failures";

/** What a code can confirm. One row per subject, so the code for one job never answers another. */
export type SmsConfirmationSubjectKind =
  | "pending_action"
  | "dispatch_approval"
  | "dispatch_quote"
  | "dispatch_invoice"
  | "dispatch_retry"
  | "stay_request";

export type SmsConfirmationCheck = "ok" | "wrong" | "exhausted" | "unavailable" | "locked";

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

/** Only a keyed hash of the phone is stored, so the failures table is not a list of numbers. */
function phoneHash(phone: string): string | null {
  const key = secret();
  const digits = String(phone ?? "").replace(/\D/g, "").slice(-10);
  if (!key || digits.length < 7) return null;
  return createHmac("sha256", key).update(`sms-confirm-phone-v1:${digits}`).digest("hex");
}

/** `locked` = this phone has hit the cap; `unavailable` = the count could not be read (fail closed); null = not locked. */
async function phoneLockState(db: SupabaseClient, hash: string, now: Date): Promise<"locked" | "unavailable" | null> {
  const since = new Date(now.getTime() - SMS_CONFIRMATION_PHONE_WINDOW_MS).toISOString();
  const { data, error } = await db
    .from(FAILURES_TABLE)
    .select("id")
    .eq("phone_hash", hash)
    .gte("failed_at", since)
    .limit(SMS_CONFIRMATION_PHONE_FAILURE_CAP);
  if (error) return "unavailable";
  return ((data ?? []) as unknown[]).length >= SMS_CONFIRMATION_PHONE_FAILURE_CAP ? "locked" : null;
}

/**
 * Reserve one guess against the phone's budget, ATOMICALLY: `sms_confirmation_phone_reserve` counts the recent failures
 * and inserts this guess's row in one transaction under a per-phone advisory lock, so parallel guesses cannot all read
 * "under the cap" before any of them is recorded. The row is kept when the code is wrong and released when it is right.
 * Any error is `unavailable` (fail closed): a guess whose record could not be written is never compared.
 */
async function reservePhoneGuess(
  db: SupabaseClient,
  hash: string,
  now: Date,
): Promise<{ state: "reserved"; failureId: string | null } | { state: "locked" | "unavailable" }> {
  const { data, error } = await db.rpc("sms_confirmation_phone_reserve", {
    p_phone_hash: hash,
    p_cap: SMS_CONFIRMATION_PHONE_FAILURE_CAP,
    p_window_seconds: Math.floor(SMS_CONFIRMATION_PHONE_WINDOW_MS / 1000),
    p_now: now.toISOString(),
  });
  if (error) return { state: "unavailable" };
  const row = (Array.isArray(data) ? data[0] : data) as { locked?: unknown; failure_id?: unknown } | null | undefined;
  if (!row || typeof row.locked !== "boolean") return { state: "unavailable" };
  if (row.locked) return { state: "locked" };
  return { state: "reserved", failureId: typeof row.failure_id === "string" ? row.failure_id : null };
}

async function releasePhoneGuess(db: SupabaseClient, failureId: string | null): Promise<void> {
  if (!failureId) return;
  // Best effort and fail-safe: a row that stays only makes the phone's budget stricter.
  await db.from(FAILURES_TABLE).delete().eq("id", failureId).then(undefined, () => undefined);
}

function safeEqualHex(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  return left.length === right.length && timingSafeEqual(left, right);
}

/**
 * Issue (or re-issue) the code for one subject and return it for the ask.
 *
 * The attempt budget belongs to ONE PROPOSAL, not to the subject for ever. A subject that raises proposals in
 * succession (a dispatch run's second texted invoice, a new held quote) passes the new `proposalId`, which resets
 * the count; a RE-ASK of the proposal already open omits it, so re-asking cannot hand a guesser a fresh budget.
 * `null` = no code could be issued (no secret, or the store is unavailable), and the caller must then not promise a
 * coded confirmation.
 */
export async function issueSmsConfirmationCode(
  db: SupabaseClient,
  input: { kind: SmsConfirmationSubjectKind; subjectId: string; proposalId?: string | null; now?: Date },
): Promise<string | null> {
  const subjectId = String(input.subjectId ?? "").trim();
  if (!subjectId) return null;
  const code = generateSmsConfirmationCode();
  const codeHash = hashCode({ kind: input.kind, subjectId }, code);
  if (!codeHash) return null;
  const now = input.now ?? new Date();
  const proposalId = String(input.proposalId ?? "").trim() || null;
  const { data: existing, error: readError } = await db
    .from(TABLE)
    .select("subject_id, proposal_id")
    .eq("subject_kind", input.kind)
    .eq("subject_id", subjectId)
    .maybeSingle();
  if (readError) return null;
  const stored = (existing ?? null) as { proposal_id?: unknown } | null;
  const newProposal = !stored || (proposalId !== null && String(stored.proposal_id ?? "") !== proposalId);
  const { error } = await db.from(TABLE).upsert(
    {
      subject_kind: input.kind,
      subject_id: subjectId,
      code_hash: codeHash,
      consumed_at: null,
      expires_at: new Date(now.getTime() + CODE_TTL_MS).toISOString(),
      updated_at: now.toISOString(),
      ...(newProposal ? { attempts: 0, proposal_id: proposalId } : {}),
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
 *   `locked`     (only when a `phone` is passed) that number has missed ten codes in 24 hours: refuse and point to the portal
 *
 * The attempt is counted by compare-and-set BEFORE the comparison, so concurrent guesses cannot slip past the cap; the
 * per-phone guess is reserved atomically (check + increment in one SQL statement) at the same point.
 */
export async function checkSmsConfirmationCode(
  db: SupabaseClient,
  input: { kind: SmsConfirmationSubjectKind; subjectId: string; code: string | null | undefined; phone?: string | null; now?: Date },
): Promise<SmsConfirmationCheck> {
  const subjectId = String(input.subjectId ?? "").trim();
  const presented = String(input.code ?? "").trim();
  if (!subjectId || !secret()) return "unavailable";
  const now = input.now ?? new Date();
  // A caller that knows the sender passes the phone: ten wrong codes in 24 hours across proposals lock the coded path
  // for that number, correct code or not. No phone = no per-phone budget (the per-proposal cap still applies).
  let failureKey: string | null = null;
  if (input.phone && String(input.phone).trim()) {
    failureKey = phoneHash(input.phone);
    if (!failureKey) return "unavailable";
    const lock = await phoneLockState(db, failureKey, now);
    if (lock) return lock;
  }
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

  // The phone's guess is reserved (counted) BEFORE the comparison, in one atomic statement, so a burst of parallel guesses
  // cannot slip past the cap and a failed write cannot leave a guess unrecorded.
  let reservedFailureId: string | null = null;
  if (failureKey) {
    const reserved = await reservePhoneGuess(db, failureKey, now);
    if (reserved.state !== "reserved") return reserved.state;
    reservedFailureId = reserved.failureId;
  }

  const expected = String(row.code_hash ?? "");
  const presentedHash = /^\d{4}$/.test(presented) ? hashCode({ kind: input.kind, subjectId }, presented) : null;
  if (!presentedHash || !expected || !safeEqualHex(presentedHash, expected)) {
    return attempts + 1 >= SMS_CONFIRMATION_CODE_MAX_ATTEMPTS ? "exhausted" : "wrong";
  }
  await releasePhoneGuess(db, reservedFailureId);
  await db
    .from(TABLE)
    .update({ consumed_at: now.toISOString(), updated_at: now.toISOString() })
    .eq("subject_kind", input.kind)
    .eq("subject_id", subjectId)
    .then(undefined, () => undefined);
  return "ok";
}

/**
 * Drop the stored code for a subject whose proposal is OVER (cancelled by three wrong codes, or settled).
 *
 * The attempt budget belongs to the proposal, and a proposal is identified by intrinsic facts (an attempt and its
 * amount), so the SAME id can come round again - a vendor re-texting the invoice the manager never confirmed. A row
 * left behind would hand that new proposal the spent budget of the old one and auto-decline it on the first answer.
 */
export async function clearSmsConfirmationCode(db: SupabaseClient, input: { kind: SmsConfirmationSubjectKind; subjectId: string }): Promise<void> {
  const subjectId = String(input.subjectId ?? "").trim();
  if (!subjectId) return;
  await db
    .from(TABLE)
    .delete()
    .eq("subject_kind", input.kind)
    .eq("subject_id", subjectId)
    .then(undefined, () => undefined);
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
