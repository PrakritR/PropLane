/** Input sanitizers for the manager listing wizard — block letters in numeric fields and digits in text-only labels. */

/** Strip to a valid partial decimal money string (digits, one dot, max 2 fraction digits). */
export function sanitizeMoneyInput(value: string): string {
  let s = value.replace(/[^\d.]/g, "");
  const dot = s.indexOf(".");
  if (dot !== -1) {
    s = s.slice(0, dot + 1) + s.slice(dot + 1).replace(/\./g, "");
    const [whole, frac = ""] = s.split(".");
    return frac.length ? `${whole}.${frac.slice(0, 2)}` : whole + (s.endsWith(".") ? "." : "");
  }
  return s;
}

export function parseSanitizedMoneyNumber(value: string): number {
  const cleaned = sanitizeMoneyInput(value);
  if (!cleaned || cleaned === ".") return 0;
  const n = Number.parseFloat(cleaned);
  return Number.isFinite(n) ? n : 0;
}

export function parseOptionalSanitizedMoneyNumber(value: string): number | undefined {
  const cleaned = sanitizeMoneyInput(value);
  if (!cleaned || cleaned === ".") return undefined;
  const n = Number.parseFloat(cleaned);
  return Number.isFinite(n) ? n : undefined;
}

/** US ZIP — 5 digits or ZIP+4 (#####-####). */
export function sanitizeZipInput(value: string): string {
  const digits = value.replace(/\D/g, "").slice(0, 9);
  if (digits.length <= 5) return digits;
  return `${digits.slice(0, 5)}-${digits.slice(5)}`;
}

export function isValidZipInput(value: string): boolean {
  const digits = value.replace(/\D/g, "");
  return digits.length === 5 || digits.length === 9;
}

/** Whole numbers only. */
export function sanitizeIntegerInput(value: string, maxDigits = 12): string {
  return value.replace(/\D/g, "").slice(0, maxDigits);
}

export function parseSanitizedInteger(value: string, fallback = 0): number {
  const cleaned = sanitizeIntegerInput(value);
  if (!cleaned) return fallback;
  const n = Number.parseInt(cleaned, 10);
  return Number.isFinite(n) ? n : fallback;
}

/** Room, bathroom, and shared-space names — letters, numbers, and common punctuation. */
export function sanitizePlaceNameInput(value: string): string {
  return value.replace(/[^\w\s#\-./&,+'()]/gi, "");
}

/** Building or property names. */
export function sanitizeBuildingNameInput(value: string): string {
  return sanitizePlaceNameInput(value);
}

/** Street address — alphanumeric plus common address punctuation. */
export function sanitizeStreetAddressInput(value: string): string {
  return value.replace(/[^\w\s#\-.,/'()]/gi, "");
}

/** City names — letters and separators only (no digits). */
export function sanitizeCityInput(value: string): string {
  return value.replace(/[^a-zA-Z\s\-'.]/g, "");
}

/** US state / territory postal abbreviation. */
export function sanitizeStateInput(value: string): string {
  return value.replace(/[^a-zA-Z]/g, "").toUpperCase().slice(0, 2);
}

/** Neighborhood names — letters and separators only (no digits). */
export function sanitizeNeighborhoodInput(value: string): string {
  return value.replace(/[^a-zA-Z\s\-'.]/g, "");
}

/** Zelle / Venmo contact — email, phone, or handle characters. */
export function sanitizePaymentContactInput(value: string): string {
  return value.replace(/[^\w@.\-+]/g, "");
}

/** Bank/ACH payment link — permissive for URLs; strips whitespace and characters unsafe in an href/attribute. */
export function sanitizePaymentLinkInput(value: string): string {
  return value.replace(/[\s<>"'`]/g, "");
}

/** Floor / level custom text — alphanumeric and common separators. */
export function sanitizeFloorLabelInput(value: string): string {
  return value.replace(/[^\w\s#\-./]/gi, "");
}

export function isDigitsOnlyLabel(value: string): boolean {
  const t = value.trim();
  return t.length > 0 && /^\d+$/.test(t);
}
