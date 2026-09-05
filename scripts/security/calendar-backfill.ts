import { decryptSensitiveValue, encryptSensitiveValue, isEncryptedSensitiveValue } from "../../src/lib/security/data-encryption";

/** Preserve unrelated metadata and protect stale copies as well as active tokens. */
export function protectCalendarTokens(raw: unknown, ownerId: string) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { value: raw, changed: false, plaintext: 0 };
  const value = { ...(raw as Record<string, unknown>) };
  let changed = false;
  let plaintext = 0;
  for (const field of ["accessToken", "refreshToken"] as const) {
    const token = value[field];
    if (token == null || token === "") continue;
    if (typeof token !== "string") throw new Error("Malformed calendar credential.");
    const context = { purpose: "google-calendar-oauth", ownerId, recordId: ownerId, field };
    const encrypted = isEncryptedSensitiveValue(token);
    const opened = encrypted ? decryptSensitiveValue(token, context) : token;
    if (!encrypted) plaintext++;
    // Verify even current-key ciphertext; never silently skip corrupt records.
    if (!encrypted || !token.startsWith(`proplane:v1:${process.env.DATA_ENCRYPTION_ACTIVE_KEY_ID}:`)) {
      value[field] = encryptSensitiveValue(opened, context);
      changed = true;
    }
  }
  return { value, changed, plaintext };
}

/** Require both declared project and actual database endpoint to agree. */
export function assertCalendarBackfillTarget(connectionString: string, projectUrl: string, apply: boolean) {
  const project = new URL(projectUrl).hostname;
  const ref = project.split(".")[0];
  if (project !== `${ref}.supabase.co`) throw new Error("Expected a hosted Supabase project.");
  const allowed = ["emstjswhotsnyksqhqyf", "xwszcafaontidfgznlxd"];
  if (apply && !allowed.includes(ref)) throw new Error("Apply is restricted to the dev and staging projects.");
  const db = new URL(connectionString);
  const direct = db.hostname === `db.${ref}.supabase.co`;
  const pooler = db.hostname.endsWith(".pooler.supabase.com") && decodeURIComponent(db.username) === `postgres.${ref}`;
  if (!direct && !pooler) throw new Error("Database endpoint does not match the declared project.");
}
