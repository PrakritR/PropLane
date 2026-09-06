/**
 * Coerce a stored phone to a trim-safe string.
 *
 * JSON / PostgREST sometimes hands back a numeric `18559168031` instead of
 * `"+18559168031"`. Calling `.trim()` on that number is the Communication
 * `x.trim is not a function` crash.
 */
export function coercePhoneInput(value: unknown): string {
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(Math.trunc(Math.abs(value)));
  }
  return typeof value === "string" ? value.trim() : "";
}

export function normalizeE164(phone: unknown): string | null {
  const trimmed = coercePhoneInput(phone);
  // Already-international input ("+44 20 7946 0958") passes through; bare
  // digits keep the US default so existing 10/11-digit data still works.
  if (trimmed.startsWith("+")) {
    const digits = trimmed.slice(1).replace(/\D/g, "");
    if (!/^[1-9]\d{6,14}$/.test(digits)) return null;
    // NANP country code 1 is always 10 national digits. PhoneNumberField emits
    // +1… while the user is still typing, so a 7-digit "+1206555" must not
    // count as a deliverable number.
    if (digits.startsWith("1") && digits.length !== 11) return null;
    return `+${digits}`;
  }
  const digits = trimmed.replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return null;
}

/**
 * Manager-facing phone label for Communication. Numbers are public knowledge
 * on this surface, so show a readable NANP form (or the E.164 when non-US).
 */
export function formatSmsPhoneLabel(phone: string | null | undefined): string | null {
  const raw = String(phone ?? "").trim();
  if (!raw) return null;
  const e164 = normalizeE164(raw) ?? (raw.startsWith("+") ? raw : null);
  const digits = (e164 ?? raw).replace(/\D/g, "");
  if (digits.length === 11 && digits.startsWith("1")) {
    return `+1 (${digits.slice(1, 4)}) ${digits.slice(4, 7)}-${digits.slice(7)}`;
  }
  if (digits.length === 10) {
    return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
  }
  return e164 ?? raw;
}
