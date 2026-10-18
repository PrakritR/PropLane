import { createHash } from "node:crypto";

/**
 * SHA-256 hex of a presented share token: the one place a bearer token becomes a database key.
 * Share links store only this hash (`token_hash`); the raw token is shown to its creator once.
 */
export function hashShareToken(token: string): string {
  return createHash("sha256").update(token.trim(), "utf8").digest("hex");
}

/**
 * The migration that added `token_hash` has not run on this database yet (production runs code
 * before migrations): Postgres 42703 undefined column, PostgREST PGRST204.
 */
export function isMissingTokenHashColumn(error: { code?: string | null; message?: string | null } | null | undefined): boolean {
  const code = String(error?.code ?? "");
  if (code === "PGRST204") return true;
  return code === "42703" && /token_hash/i.test(String(error?.message ?? ""));
}
