/**
 * What a manager's data export must NEVER contain, expressed as key patterns.
 *
 * The export walks every table the purge manifest says the manager owns and hands the
 * rows back verbatim — so the only thing standing between an applicant's SSN and a file
 * on a laptop is this list. It is applied to column names AND, recursively, to every key
 * inside a `row_data` JSON blob, because the portal record tables keep their payload as
 * JSON (`manager_application_records.row_data.application.ssn`,
 * `row_data._applicantIdentity.ciphertext`) and a column-only filter would miss all of it.
 *
 * Matching is on a normalized key: camelCase is folded to snake_case and lower-cased, so
 * `dateOfBirth`, `date_of_birth` and `DateOfBirth` are one pattern. A pattern matches as a
 * SUBSTRING (`*ssn*`), so `applicant_ssn_last4` and `ssnEncrypted` both go. Prefer a false
 * positive here: a dropped column is a support ticket, a leaked identity number is not.
 *
 * `tests/unit/account-export-pii-exclusion.test.ts` pins every entry.
 */

/** Substrings of a normalized (snake_case, lower) key that mark it as excluded. */
export const EXPORT_EXCLUDED_KEY_PATTERNS: readonly string[] = [
  // Government identity numbers
  "ssn",
  "social_security",
  "dob",
  "date_of_birth",
  "birth_date",
  "birthdate",
  "license",
  "dl_number",
  "drivers_licence",
  "id_number",
  "passport",
  "tin",
  "ein",
  // Payment instruments
  "card",
  "routing",
  "account_number",
  "iban",
  "cvv",
  // Encrypted identity envelopes and every other opaque secret
  "encrypted",
  "ciphertext",
  "envelope",
  "token",
  "secret",
  "api_key",
  "password",
  "_hash",
  "private_key",
];

/**
 * Values that are themselves an encrypted envelope (`proplane:v1:…`) are dropped wherever
 * they sit, even under an innocuous key — they are useless to the manager and a decryption
 * target to anyone else. Mirrors `isEncryptedSensitiveValue` in
 * `src/lib/security/data-encryption.ts`, which is server-only and cannot be imported here.
 */
const ENCRYPTED_VALUE_PREFIX = "proplane:";

/** `dateOfBirth` → `date_of_birth`, `SSNLast4` → `ssn_last4`, `_applicantIdentity` → `_applicant_identity`. */
export function normalizeExportKey(key: string): string {
  return key
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .replace(/[\s.-]+/g, "_")
    .toLowerCase();
}

/**
 * Whole-segment patterns: `tin`, `ein`, `dob` and `cvv` are short enough to sit inside
 * ordinary words (`routing` and `setting` contain `tin`, `being` contains `ein`), so they
 * only match as a complete `_`-delimited segment. Every other pattern is a substring.
 */
const WHOLE_SEGMENT_PATTERNS = new Set(["tin", "ein", "dob", "cvv"]);

export function isExcludedExportKey(key: string): boolean {
  const normalized = normalizeExportKey(key);
  const segments = normalized.split("_").filter(Boolean);
  return EXPORT_EXCLUDED_KEY_PATTERNS.some((pattern) =>
    WHOLE_SEGMENT_PATTERNS.has(pattern) ? segments.includes(pattern) : normalized.includes(pattern),
  );
}

function isEncryptedValue(value: unknown): boolean {
  return typeof value === "string" && value.startsWith(ENCRYPTED_VALUE_PREFIX);
}

/**
 * Return a deep copy of `value` with every excluded key removed at every depth, and every
 * encrypted-envelope string dropped (object members are deleted; array members become
 * `null` so positions are preserved). Primitives pass through unchanged.
 */
export function stripExcludedExportKeys<T>(value: T): T {
  return strip(value) as T;
}

function strip(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => (isEncryptedValue(item) ? null : strip(item)));
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, member] of Object.entries(value as Record<string, unknown>)) {
      if (isExcludedExportKey(key)) continue;
      if (isEncryptedValue(member)) continue;
      out[key] = strip(member);
    }
    return out;
  }
  return value;
}
