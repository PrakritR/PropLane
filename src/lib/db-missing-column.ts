/**
 * "That column is not there yet."
 *
 * Schema parity in this project is a manual `npm run db:push` (`AGENTS.md` § Database
 * environments), so code can reach an environment ahead of its migration. A write that is the only
 * thing a new column adds retries once without it rather than failing the user's request; the
 * surface that reads the column reports the schema as not ready instead.
 */
function namesMissingColumn(error: unknown, column: string): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as { code?: unknown; message?: unknown; details?: unknown };
  const code = String(candidate.code ?? "");
  const text = `${candidate.message ?? ""} ${candidate.details ?? ""}`.trim().toLowerCase();
  // Postgres `undefined_column` and PostgREST's schema-cache miss both name the column, so a
  // 42703 about an unrelated column is not this one's problem.
  const named = text.includes(column.toLowerCase());
  if (code === "42703") return named || text === "";
  if (code === "PGRST204") return named;
  return named && text.includes("column") && (text.includes("does not exist") || text.includes("schema cache"));
}

/**
 * A caller that wraps the failure in its own `Error` must pass the original along as `cause`,
 * since its own prefix hides whether the database said anything useful.
 */
export function isMissingColumnError(error: unknown, column: string): boolean {
  if (namesMissingColumn(error, column)) return true;
  const cause = (error as { cause?: unknown } | null | undefined)?.cause;
  return cause !== error && namesMissingColumn(cause, column);
}
