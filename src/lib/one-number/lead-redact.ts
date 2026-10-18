/**
 * What a lead's stored message may keep. A card, bank or SSN number texted by a stranger is never
 * stored: it is replaced before the turn is written. This is the local call site for the transport
 * workstream's `redactSensitiveNumbers` (src/lib/one-number/redact.ts); swap the body for that
 * function when the two branches meet. Ten-digit phone numbers are left alone.
 */
export const LEAD_REDACTION_MARK = "[redacted]";

export function redactLeadBody(body: string): string {
  return String(body ?? "")
    .replace(/\b(?:\d[ -]?){12,18}\d\b/g, LEAD_REDACTION_MARK)
    .replace(/\b\d{3}-\d{2}-\d{4}\b/g, LEAD_REDACTION_MARK)
    .replace(/\b(acct|account|routing|aba)(\s*(?:#|number|no\.?|num)?\s*[:#-]?\s*)\d{6,17}\b/gi, `$1$2${LEAD_REDACTION_MARK}`)
    .slice(0, 1000);
}
