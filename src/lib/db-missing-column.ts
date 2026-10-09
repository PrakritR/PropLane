/**
 * "That column is not there yet."
 *
 * Schema parity in this project is a manual `npm run db:push` (`AGENTS.md` § Database
 * environments), so code can reach an environment ahead of its migration. A write that is the only
 * thing a new column adds retries once without it rather than failing the user's request; the
 * surface that reads the column reports the schema as not ready instead.
 */
export function isMissingColumnError(error: unknown, column: string): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as { code?: unknown; message?: unknown; details?: unknown };
  // Postgres `undefined_column`.
  if (String(candidate.code ?? "") === "42703") return true;
  // PostgREST's schema-cache miss names the column it could not find, and so does the Postgres
  // message a caller may already have wrapped in an `Error` without carrying the code along.
  const text = `${candidate.message ?? ""} ${candidate.details ?? ""}`.toLowerCase();
  if (!text.includes(column.toLowerCase())) return false;
  return String(candidate.code ?? "") === "PGRST204" || (text.includes("column") && text.includes("does not exist"));
}
