import { normalizeE164 } from "@/lib/phone-e164";

/** Split free-typed Other recipients into emails vs E.164 phones. */

export function normalizePhoneE164(phone: string): string | null {
  // The one phone normalizer: see `normalizeE164` (src/lib/phone-e164.ts).
  return normalizeE164(phone);
}

export type OtherRecipientToken = {
  kind: "email" | "phone";
  /** Canonical value used when sending (email lowercased, phone E.164). */
  value: string;
  /** Display label in the chip. */
  label: string;
};

function formatPhoneChipLabel(e164: string): string {
  const digits = e164.replace(/\D/g, "");
  if (digits.length === 11 && digits.startsWith("1")) {
    return `(${digits.slice(1, 4)}) ${digits.slice(4, 7)}-${digits.slice(7)}`;
  }
  if (digits.length === 10) {
    return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
  }
  return e164;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/i;

/** Turn a typed fragment into a chip token, or null if not ready yet. */
export function commitOtherRecipientToken(raw: string): OtherRecipientToken | null {
  const token = raw.trim().replace(/[,;]+$/g, "").trim();
  if (!token) return null;
  if (token.includes("@")) {
    if (!EMAIL_RE.test(token)) return null;
    const value = token.toLowerCase();
    return { kind: "email", value, label: value };
  }
  const e164 = normalizePhoneE164(token);
  if (!e164) return null;
  return { kind: "phone", value: e164, label: formatPhoneChipLabel(e164) };
}

export function parseOtherRecipientTokens(tokens: OtherRecipientToken[]): {
  emails: string[];
  phones: string[];
} {
  const emails: string[] = [];
  const phones: string[] = [];
  const seenEmail = new Set<string>();
  const seenPhone = new Set<string>();
  for (const t of tokens) {
    if (t.kind === "email") {
      if (seenEmail.has(t.value)) continue;
      seenEmail.add(t.value);
      emails.push(t.value);
    } else {
      if (seenPhone.has(t.value)) continue;
      seenPhone.add(t.value);
      phones.push(t.value);
    }
  }
  return { emails, phones };
}

export function parseOtherRecipients(raw: string): { emails: string[]; phones: string[] } {
  const tokens: OtherRecipientToken[] = [];
  const seen = new Set<string>();
  for (const part of raw.split(/[,;\n]+/)) {
    const committed = commitOtherRecipientToken(part);
    if (!committed) continue;
    if (seen.has(`${committed.kind}:${committed.value}`)) continue;
    seen.add(`${committed.kind}:${committed.value}`);
    tokens.push(committed);
  }
  return parseOtherRecipientTokens(tokens);
}
