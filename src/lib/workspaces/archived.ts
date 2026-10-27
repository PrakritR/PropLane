/**
 * Archived workspaces. "Combine all into one" (Admin > Accounts > Managed by PropLane) moves an owner's houses into one
 * PropLane-managed workspace and ARCHIVES the emptied ones (`portal_workspaces.archived_at`, reversible by clearing it).
 * An archived workspace is left out of every workspace list. Pure and client-safe.
 *
 * A project that has not run `20261027030000_portal_workspaces_archived_combine.sql` has no such column: that one error
 * shape (the SQLSTATE or PostgREST code, never a message) means "nothing is archived", and the caller reads again
 * without the column, so a workspace list never breaks on a database one migration behind.
 */

export const WORKSPACE_ARCHIVED_COLUMN = "archived_at";

export function isMissingArchivedColumn(error: { code?: string | null } | null | undefined): boolean {
  const code = String(error?.code ?? "");
  return code === "42703" || code === "PGRST204";
}

/** True for a row whose `archived_at` is set. A row without the field is not archived. */
export function isArchivedWorkspaceRow(row: unknown): boolean {
  if (!row || typeof row !== "object") return false;
  const value = (row as { archived_at?: unknown }).archived_at;
  return value !== null && value !== undefined && value !== "";
}

export function withoutArchivedWorkspaces<T>(rows: readonly T[] | null | undefined): T[] {
  return (rows ?? []).filter((row) => !isArchivedWorkspaceRow(row));
}
