/**
 * Client-safe extraction of human work-order references from untrusted text.
 *
 * This parser identifies claims only. A returned reference is never authorization:
 * callers must resolve it through the resident, vendor, or manager scoped lookup
 * introduced by PRP-261 before reading or changing a work order.
 */

const REFERENCE_DIGITS = "([1-9]\\d{3,7})";
const LABELED_REFERENCE_RE = new RegExp(
  `\\b(?:wo|work[\\s-]*order|job|ticket|status)\\s*(?:number|no\\.?)?\\s*[-:#]?\\s*${REFERENCE_DIGITS}\\b`,
  "gi",
);
const HASH_REFERENCE_RE = new RegExp(`(?:^|[\\s(])#${REFERENCE_DIGITS}\\b`, "g");
const BARE_REFERENCE_RE = new RegExp(`^\\s*${REFERENCE_DIGITS}\\s*[.!?]?\\s*$`);

export const MAX_WORK_ORDER_REFERENCE_CANDIDATES = 5;

export function formatWorkOrderReference(sequence: string | number): string | null {
  const digits = String(sequence).trim();
  if (!/^[1-9]\d{3,7}$/.test(digits)) return null;
  return `WO-${digits}`;
}

/**
 * Extract normalized references in message order.
 *
 * Accepted examples: `WO-1042`, `wo 1042`, `work order #1042`, `#1042`,
 * `status 1042`, and a message consisting only of `1042`. Arbitrary numbers in
 * prose are ignored so rent amounts, dates, phone numbers, and confirmation codes
 * do not silently become work-order claims.
 */
export function resolveWorkOrderReference(text: string): string[] {
  const input = String(text ?? "");
  if (!input.trim()) return [];

  const matches: Array<{ index: number; reference: string }> = [];
  const collect = (pattern: RegExp) => {
    pattern.lastIndex = 0;
    for (const match of input.matchAll(pattern)) {
      const digits = match[1];
      const reference = digits ? formatWorkOrderReference(digits) : null;
      if (reference) matches.push({ index: match.index, reference });
    }
  };

  collect(LABELED_REFERENCE_RE);
  collect(HASH_REFERENCE_RE);

  const bare = input.match(BARE_REFERENCE_RE);
  const bareReference = bare?.[1] ? formatWorkOrderReference(bare[1]) : null;
  if (bareReference) matches.push({ index: bare?.index ?? 0, reference: bareReference });

  matches.sort((a, b) => a.index - b.index);
  return [...new Set(matches.map((match) => match.reference))].slice(
    0,
    MAX_WORK_ORDER_REFERENCE_CANDIDATES,
  );
}
