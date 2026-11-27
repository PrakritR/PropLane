/**
 * The Google connect path throws plain `Error`s AND Supabase `PostgrestError` objects (`throw error`
 * after a failed read or upsert), which are not `instanceof Error`. The callback used to turn the
 * second kind into "unknown" (Muse #83). A thrown `Error` (Google's own reasons, e.g.
 * redirect_uri_mismatch) reaches the user as is; a database error reaches them as a fixed sentence
 * with its code, and its raw text stays in the server log (`googleConnectFailureDetail`).
 */
export function googleConnectFailureMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message.trim();
  if (error && typeof error === "object") {
    const code = googleConnectFailureCode(error);
    const safeCode = code && /^[A-Za-z0-9_-]{1,16}$/.test(code) ? code : null;
    return safeCode
      ? `Could not save your Google connection (code ${safeCode}). Try Connect again.`
      : "Could not save your Google connection. Try Connect again.";
  }
  return "Could not connect Google Calendar. Try Connect again.";
}

/** The raw failure text, for the server log only. */
export function googleConnectFailureDetail(error: unknown): string {
  if (error instanceof Error) return error.message.trim();
  if (error && typeof error === "object") {
    const record = error as { message?: unknown; details?: unknown };
    const parts = [record.message, record.details].filter(
      (part): part is string => typeof part === "string" && Boolean(part.trim()),
    );
    return parts.map((part) => part.trim()).join(" | ");
  }
  return typeof error === "string" ? error.trim() : "";
}

/** A Postgres / PostgREST / Google error code. */
export function googleConnectFailureCode(error: unknown): string | null {
  if (error && typeof error === "object" && "code" in error) {
    const code = (error as { code?: unknown }).code;
    return typeof code === "string" || typeof code === "number" ? String(code) : null;
  }
  return null;
}
