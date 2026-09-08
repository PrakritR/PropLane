type DatabaseError = { code?: string; message: string } | null | undefined;

/** Older environments may lack a table. A missing COLUMN is a bug, never success. */
export function assertAccountCleanupSucceeded(error: DatabaseError): void {
  if (!error || error.code === "42P01" || error.code === "PGRST205") return;
  throw new Error(`Account cleanup failed: ${error.message}`);
}
