/**
 * As-you-type US/Canada phone entry for a field with a fixed "+1" in front of it. Pure and client-safe.
 * The server still re-validates everything (`normalizeE164` / `isAllowedPhoneAuthDestination`).
 */

/** "+44 20 7946 0958" is typed on purpose and passed through untouched so the server can say "US and Canada only". */
function isNonNanpInternational(raw: string): boolean {
  const trimmed = raw.trim();
  if (!trimmed.startsWith("+")) return false;
  const digits = trimmed.slice(1).replace(/\D/g, "");
  return digits.length > 0 && !digits.startsWith("1");
}

/** The national digits (max 10) from whatever was typed or pasted: "+1 510-309-8345", "15103098345", "(510) 309-8345". */
export function phoneNationalDigits(raw: string): string {
  let digits = raw.replace(/\D/g, "");
  // The country code is already on screen, and no NANP area code starts with 1, so a leading 1 is always the country code.
  if (digits.startsWith("1")) digits = digits.slice(1);
  return digits.slice(0, 10);
}

/** "5103098" -> "(510) 309-8"; partial input never gains trailing punctuation. */
export function formatPhoneNational(digits: string): string {
  const d = digits.replace(/\D/g, "").slice(0, 10);
  if (d.length === 0) return "";
  if (d.length <= 3) return `(${d}`;
  if (d.length <= 6) return `(${d.slice(0, 3)}) ${d.slice(3)}`;
  return `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`;
}

/** The text the field shows for what was typed or pasted. */
export function formatPhoneInput(raw: string): string {
  if (isNonNanpInternational(raw)) return raw.trim();
  return formatPhoneNational(phoneNationalDigits(raw));
}

/**
 * What the form sends: "+1" + 10 digits when the field holds a full US/Canada number, otherwise the text as typed
 * (a non-US "+44…" or a short number) so the server answers with its own `not_us` / `bad_number`.
 */
export function phoneSubmitValue(display: string): string {
  const trimmed = display.trim();
  if (!trimmed || isNonNanpInternational(trimmed)) return trimmed;
  const digits = phoneNationalDigits(trimmed);
  return digits.length === 10 ? `+1${digits}` : digits;
}

/** The label under the code boxes: "(510) 309-8345" for a US number, the raw text otherwise. */
export function phoneDisplayLabel(display: string): string {
  const trimmed = display.trim();
  if (isNonNanpInternational(trimmed)) return trimmed;
  const digits = phoneNationalDigits(trimmed);
  return digits.length === 10 ? formatPhoneNational(digits) : trimmed;
}
