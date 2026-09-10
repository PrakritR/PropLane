type DbError = { code?: string; message?: string } | null | undefined;

/** True when account_recovery_requests is absent (migrations not pushed yet). */
export function isMissingAccountRecoveryTableError(error: DbError): boolean {
  if (!error) return false;
  if (error.code === "PGRST205") {
    return error.message === "Could not find the table 'public.account_recovery_requests' in the schema cache";
  }
  if (error.code === "42P01") {
    return /^relation "(?:public\.)?account_recovery_requests" does not exist$/.test(error.message ?? "");
  }
  return false;
}

/** True when an account_recovery_* RPC has not been deployed. */
export function isMissingAccountRecoveryRpcError(error: DbError): boolean {
  if (!error) return false;
  const message = error.message ?? "";
  if (error.code === "PGRST202") return /account_recovery_/i.test(message);
  return /function public\.account_recovery_\w+.*does not exist/i.test(message);
}

/** Fall back to the pre-recovery delete path when retention schema is not live. */
export function shouldUseLegacyPortalAccountDeletion(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const wrapped = error as Error & { code?: string };
  if (isMissingAccountRecoveryTableError(wrapped)) return true;
  if (isMissingAccountRecoveryRpcError(wrapped)) return true;
  if (isMissingAccountRecoveryTableError({ code: "PGRST205", message: wrapped.message })) return true;
  if (isMissingAccountRecoveryRpcError({ code: "PGRST202", message: wrapped.message })) return true;
  return /account_recovery_(begin|finish_archival|open)/i.test(wrapped.message)
    && /(does not exist|schema cache)/i.test(wrapped.message);
}
