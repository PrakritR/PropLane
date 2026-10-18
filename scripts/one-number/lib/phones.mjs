/**
 * Phone normalisation for the migration scripts. A plain-JS mirror of `normalizeE164`
 * (src/lib/phone-e164.ts) and `normalizeConsentPhone` (src/lib/sms-consent.ts); the parity test
 * (tests/unit/one-number-migration-phones.test.ts) runs both over a corpus so they cannot drift.
 */

function coerce(value) {
  if (typeof value === "number" && Number.isFinite(value)) return String(Math.trunc(Math.abs(value)));
  return typeof value === "string" ? value.trim() : "";
}

export function normalizeE164(phone) {
  const trimmed = coerce(phone);
  if (trimmed.startsWith("+")) {
    const digits = trimmed.slice(1).replace(/\D/g, "");
    if (!/^[1-9]\d{6,14}$/.test(digits)) return null;
    if (digits.startsWith("1") && digits.length !== 11) return null;
    return `+${digits}`;
  }
  const digits = trimmed.replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return null;
}

/** US numbers reduce to 10 digits, everything else to its digits: the key every SMS table uses. */
export function phoneKey(phone) {
  const e164 = normalizeE164(phone);
  if (e164?.startsWith("+1")) return e164.slice(2);
  const digits = String(phone ?? "").replace(/\D/g, "");
  if (digits.length === 11 && digits.startsWith("1")) return digits.slice(1);
  return digits;
}

/** "(206) 555-0100" for a US number, the E.164 otherwise. */
export function formatDisplay(phone) {
  const e164 = normalizeE164(phone);
  if (!e164) return String(phone ?? "");
  if (e164.startsWith("+1")) return `(${e164.slice(2, 5)}) ${e164.slice(5, 8)}-${e164.slice(8)}`;
  return e164;
}
