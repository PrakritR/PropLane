/**
 * The Google connect path throws plain `Error`s AND Supabase `PostgrestError` objects (`throw error`
 * after a failed read or upsert), which are not `instanceof Error`. The callback used to turn the
 * second kind into "unknown" (Muse #83). Reading `.message` from either keeps the reason honest.
 */
export function googleConnectFailureMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message.trim();
  if (error && typeof error === "object") {
    const record = error as { message?: unknown; details?: unknown };
    if (typeof record.message === "string" && record.message.trim()) return record.message.trim();
    if (typeof record.details === "string" && record.details.trim()) return record.details.trim();
  }
  return "Could not connect Google Calendar. Try Connect again.";
}

/** A Postgres / PostgREST / Google error code, for the server log only. */
export function googleConnectFailureCode(error: unknown): string | null {
  if (error && typeof error === "object" && "code" in error) {
    const code = (error as { code?: unknown }).code;
    return typeof code === "string" || typeof code === "number" ? String(code) : null;
  }
  return null;
}
