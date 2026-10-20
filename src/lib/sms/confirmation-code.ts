import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * A 4-digit code inside the confirmation a MANAGER PHONE is asked for on the PropLane line (captain, Oct 20).
 *
 * Identity on the line is the inbound `From`, which a caller can spoof, and the service manager phone reaches every
 * PropLane Service workspace with the full manager catalog. So on that line a write is not confirmed by a bare YES:
 * the preview carries a code ("Reply YES 4821"), and only a reply that repeats it confirms. A spoofed sender never
 * sees the preview, so it never learns the code; the real phone always has it in the thread it is answering.
 *
 * The code is DERIVED from the pending action id with a server secret, so nothing extra is stored and it cannot be
 * guessed from the id. A bare YES re-sends the same preview (the code does not change for the same proposal).
 */

const CODE_LENGTH = 4;

function secret(): string {
  return process.env.SUPABASE_SERVICE_ROLE_KEY?.trim() || process.env.CRON_SECRET?.trim() || "proplane-sms-confirmation-code";
}

/** The code for one proposal: stable for its lifetime, different for every other proposal. */
export function smsConfirmationCode(actionId: string): string {
  const digest = createHmac("sha256", secret()).update(`sms-confirm:${String(actionId ?? "")}`).digest();
  const value = digest.readUInt32BE(0) % 10 ** CODE_LENGTH;
  return String(value).padStart(CODE_LENGTH, "0");
}

/** Constant-time compare of a typed code against the expected one. */
export function smsConfirmationCodeMatches(actionId: string, code: string | null | undefined): boolean {
  const typed = String(code ?? "").trim();
  if (typed.length !== CODE_LENGTH) return false;
  const expected = Buffer.from(smsConfirmationCode(actionId));
  const given = Buffer.from(typed);
  return expected.length === given.length && timingSafeEqual(expected, given);
}

const AFFIRMATIVE = new Set(["YES", "Y", "CONFIRM", "CONFIRMED", "APPROVE", "APPROVED"]);

/**
 * "YES 4821" / "confirm 4821" -> the code the sender typed. Null when the reply carries no code at all (a bare YES),
 * so the caller can re-send the preview rather than guess.
 */
export function readSmsConfirmationCode(body: string): string | null {
  const normalized = String(body ?? "").trim().replace(/[.!]+$/, "").replace(/\s+/g, " ");
  const match = /^([A-Za-z]+)[\s:,-]*([0-9]{4})$/.exec(normalized);
  if (!match || !AFFIRMATIVE.has(match[1]!.toUpperCase())) return null;
  return match[2]!;
}

/** The instruction line a coded preview ends with. */
export function codedConfirmationLine(actionId: string): string {
  return `Reply YES ${smsConfirmationCode(actionId)} to confirm or NO to cancel.`;
}

const PLAIN_LINE = "Reply YES to confirm or NO to cancel.";

/** Swap the plain "Reply YES to confirm" instruction of a rendered preview for the coded one. */
export function withConfirmationCode(previewText: string, actionId: string): string {
  const text = String(previewText ?? "");
  const line = codedConfirmationLine(actionId);
  return text.includes(PLAIN_LINE) ? text.replace(PLAIN_LINE, line) : `${text.trimEnd()}\n\n${line}`;
}
