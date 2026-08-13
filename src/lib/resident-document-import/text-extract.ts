const EMAIL_RE = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const PHONE_RE = /(?:\+?1[-.\s]?)?(?:\(?\d{3}\)?[-.\s]?){2}\d{4}\b/g;
const MONEY_RE = /\$\s?[\d,]+(?:\.\d{2})?/g;
const ISO_DATE_RE = /\b(20\d{2})[-/](0[1-9]|1[0-2])[-/](0[1-9]|[12]\d|3[01])\b/g;
const US_DATE_RE = /\b(0?[1-9]|1[0-2])[/.-](0?[1-9]|[12]\d|3[01])[/.-](20\d{2})\b/g;

export function normalizeDocumentText(text: string): string {
  return String(text ?? "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/\u00a0/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .trim();
}

export function firstEmail(text: string): string | null {
  const match = text.match(EMAIL_RE);
  return match?.[0]?.trim().toLowerCase() ?? null;
}

export function allEmails(text: string): string[] {
  const seen = new Set<string>();
  for (const raw of text.match(EMAIL_RE) ?? []) {
    const email = raw.trim().toLowerCase();
    if (email) seen.add(email);
  }
  return [...seen];
}

export function firstPhone(text: string): string | null {
  const match = text.match(PHONE_RE);
  return match?.[0]?.trim() ?? null;
}

export function firstMoneyAmount(text: string): string | null {
  const match = text.match(MONEY_RE);
  return match?.[0]?.replace(/\s/g, "") ?? null;
}

export function firstIsoDate(text: string): string | null {
  const match = text.match(ISO_DATE_RE);
  return match?.[0] ?? null;
}

export function firstUsDate(text: string): string | null {
  const match = text.match(US_DATE_RE);
  return match?.[0] ?? null;
}

/** Label-aware single-value extraction — returns null when ambiguous. */
export function labeledValue(text: string, labels: string[]): string | null {
  const normalized = normalizeDocumentText(text);
  const lines = normalized.split("\n");
  const hits: string[] = [];
  for (const line of lines) {
    const lower = line.toLowerCase();
    for (const label of labels) {
      const idx = lower.indexOf(label.toLowerCase());
      if (idx === -1) continue;
      const after = line.slice(idx + label.length).replace(/^[\s:.-]+/, "").trim();
      if (after.length >= 2 && after.length <= 200) hits.push(after);
    }
  }
  const unique = [...new Set(hits.map((v) => v.trim()).filter(Boolean))];
  if (unique.length === 1) return unique[0]!;
  return null;
}

export function truncateForModel(text: string, maxChars = 24_000): string {
  const normalized = normalizeDocumentText(text);
  if (normalized.length <= maxChars) return normalized;
  const head = normalized.slice(0, Math.floor(maxChars * 0.7));
  const tail = normalized.slice(-Math.floor(maxChars * 0.25));
  return `${head}\n\n[… middle truncated …]\n\n${tail}`;
}
