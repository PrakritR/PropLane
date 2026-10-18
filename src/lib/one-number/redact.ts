/**
 * Card, bank and social security number redaction for inbound texts. A texted card or bank
 * number is never stored, never shown to an agent and never repeated: it is
 * replaced with `[redacted]` BEFORE the body reaches the receipt, the
 * projection turn or the inbound log, and the sender is pointed at the secure
 * payment link instead. Pure; no I/O.
 */

export const REDACTION_MARK = "[redacted]";

export const SECURE_PAYMENT_REPLY =
  "For your security, please do not text card or bank numbers. Use your secure payment link instead.";

export type RedactionKind = "card" | "bank" | "ssn";

export type RedactionResult = {
  text: string;
  redacted: boolean;
  kinds: RedactionKind[];
};

/** Luhn checksum over a digit string. */
export function passesLuhn(digits: string): boolean {
  if (!/^\d+$/.test(digits)) return false;
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    let n = digits.charCodeAt(i) - 48;
    if (double) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    double = !double;
  }
  return sum % 10 === 0;
}

/** ABA routing number checksum (9 digits, weights 3-7-1). */
export function isValidAbaRouting(digits: string): boolean {
  if (!/^\d{9}$/.test(digits)) return false;
  const d = Array.from(digits, (c) => c.charCodeAt(0) - 48);
  const sum = 3 * (d[0] + d[3] + d[6]) + 7 * (d[1] + d[4] + d[7]) + (d[2] + d[5] + d[8]);
  return sum % 10 === 0;
}

// 13-19 digits, optionally grouped by single spaces or dashes, not part of a longer digit run.
const CARD_CANDIDATE = /(?<![\d])\d(?:[ -]?\d){12,18}(?![\d])/g;
// "account/acct/acc number/no/#", "routing", "aba" followed by 6-17 digits (spaces/dashes allowed inside).
const BANK_KEYWORD =
  /\b(?:acct|account|acc|routing|aba)\b(?:\s*(?:number|num|no|#))?\s*(?:is|:|-|=)?\s*#?\s*(\d(?:[ -]?\d){5,16})(?![\d])/gi;
// A dashed US social security number (123-45-6789), not part of a longer dashed or digit run.
const SSN_DASHED = /(?<![\d-])\d{3}-\d{2}-\d{4}(?![\d-])/g;
const NINE_DIGITS = /(?<![\d])\d{9}(?![\d])/g;
const ACCOUNT_RUN = /(?<![\d])\d{6,17}(?![\d])/g;

function redactCards(text: string, kinds: Set<RedactionKind>): string {
  return text.replace(CARD_CANDIDATE, (match) => {
    const digits = match.replace(/\D/g, "");
    if (digits.length < 13 || digits.length > 19 || !passesLuhn(digits)) return match;
    kinds.add("card");
    return REDACTION_MARK;
  });
}

function redactSsn(text: string, kinds: Set<RedactionKind>): string {
  return text.replace(SSN_DASHED, () => {
    kinds.add("ssn");
    return REDACTION_MARK;
  });
}

function redactBank(text: string, kinds: Set<RedactionKind>): string {
  let out = text.replace(BANK_KEYWORD, (match, digitsRaw: string) => {
    const digits = digitsRaw.replace(/\D/g, "");
    if (digits.length < 6 || digits.length > 17) return match;
    kinds.add("bank");
    return match.slice(0, match.length - digitsRaw.length) + REDACTION_MARK;
  });
  // A valid 9-digit routing number sitting next to another long digit run is a
  // routing + account pair even without a keyword ("021000021 123456789012").
  const routing: Array<{ start: number; end: number }> = [];
  for (const m of out.matchAll(NINE_DIGITS)) {
    if (m.index !== undefined && isValidAbaRouting(m[0])) routing.push({ start: m.index, end: m.index + m[0].length });
  }
  if (routing.length) {
    const spans = new Set<string>();
    for (const r of routing) {
      const window = out.slice(Math.max(0, r.start - 40), Math.min(out.length, r.end + 40));
      const offset = Math.max(0, r.start - 40);
      for (const acct of window.matchAll(ACCOUNT_RUN)) {
        if (acct.index === undefined) continue;
        const aStart = offset + acct.index;
        if (aStart === r.start) continue;
        spans.add(`${aStart}:${aStart + acct[0].length}`);
      }
      spans.add(`${r.start}:${r.end}`);
    }
    if (spans.size > 1) {
      const sorted = [...spans].map((s) => s.split(":").map(Number) as [number, number]).sort((a, b) => b[0] - a[0]);
      for (const [s, e] of sorted) out = out.slice(0, s) + REDACTION_MARK + out.slice(e);
      kinds.add("bank");
    }
  }
  return out;
}

/** Replace card and bank numbers in `body` with `[redacted]`. Non-sensitive text is untouched. */
export function redactSensitiveNumbers(body: string): RedactionResult {
  const kinds = new Set<RedactionKind>();
  const original = String(body ?? "");
  let text = redactCards(original, kinds);
  text = redactSsn(text, kinds);
  text = redactBank(text, kinds);
  return { text, redacted: kinds.size > 0, kinds: [...kinds] };
}
