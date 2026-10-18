/**
 * Workspace stamps for the SMS tables. `workspace_id` landed as a nullable
 * column on `sms_outbox`, `manager_sms_messages`, `inbound_sms_log` and
 * `manager_sms_contacts`; production runs code before its migrations, so a
 * write that names the column must degrade to the old row shape, never fail.
 *
 * `withWorkspaceStamp` runs a write with `{ workspace_id }` when a workspace is
 * known, and re-runs it WITHOUT the column when Postgres/PostgREST says the
 * column (or table) is not there yet (42703, 42P01, PGRST204, PGRST205).
 */

const MISSING_SCHEMA_CODES = new Set(["42P01", "42703", "PGRST204", "PGRST205"]);

type StampError = { code?: string | null; message?: string | null } | null | undefined;

export function isMissingWorkspaceColumn(error: StampError): boolean {
  if (!error) return false;
  if (MISSING_SCHEMA_CODES.has(String(error.code ?? ""))) return true;
  return /workspace_id/i.test(String(error.message ?? "")) && /column|schema cache/i.test(String(error.message ?? ""));
}

/** The `workspace_id` field to spread into an insert/upsert row, or nothing when no workspace is known. */
export function workspaceStampFields(workspaceId: string | null | undefined): { workspace_id?: string } {
  const id = String(workspaceId ?? "").trim();
  return id ? { workspace_id: id } : {};
}

export async function withWorkspaceStamp<T extends { error: StampError }>(
  workspaceId: string | null | undefined,
  run: (stamp: { workspace_id?: string }) => PromiseLike<T>,
): Promise<T> {
  const stamp = workspaceStampFields(workspaceId);
  if (!stamp.workspace_id) return run({});
  const first = await run(stamp);
  if (first.error && isMissingWorkspaceColumn(first.error)) return run({});
  return first;
}
