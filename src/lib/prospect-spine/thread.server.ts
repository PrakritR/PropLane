import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";

/** The manager inbox scope every prospect thread lives in. */
export const MANAGER_INBOX_SCOPE = "axis_portal_inbox_manager_v1";

type Row = Record<string, unknown>;
const str = (v: unknown): string => (typeof v === "string" ? v.trim() : v == null ? "" : String(v).trim());

/** Postgres / PostgREST "that table, column or function is not there yet" (the migration has not reached this environment). */
export function isMissingSchema(error: { code?: string; message?: string } | null | undefined): boolean {
  if (!error) return false;
  const code = String(error.code ?? "");
  return ["42P01", "42703", "42883", "PGRST202", "PGRST204", "PGRST205"].includes(code);
}

export type ThreadSnapshot = { id: string; ownerUserId: string; rowData: Row; workspaceId: string | null };

export async function readThread(db: SupabaseClient, threadId: string): Promise<ThreadSnapshot | null> {
  const { data, error } = await db
    .from("portal_inbox_thread_records")
    .select("id, owner_user_id, row_data, workspace_id")
    .eq("id", threadId)
    .maybeSingle();
  if (error || !data) return null;
  const row = data as Row;
  return {
    id: str(row.id),
    ownerUserId: str(row.owner_user_id),
    rowData: (row.row_data && typeof row.row_data === "object" ? row.row_data : {}) as Row,
    workspaceId: str(row.workspace_id) || null,
  };
}

/** Does this thread already hold a turn with this id (the root turn included)? */
export function threadHasMessage(rowData: Row, messageId: string): boolean {
  if (str(rowData.rootMessageId) === messageId) return true;
  const messages = Array.isArray(rowData.messages) ? (rowData.messages as Row[]) : [];
  return messages.some((m) => str(m?.id) === messageId);
}

/**
 * Atomically merge keys into a thread row's row_data (and drop `remove`). The database function holds a row lock, so a stamp
 * never overwrites a turn another writer just appended. Falls back to a compare-and-set read/write where the function is
 * not deployed yet. Never throws; false = not written.
 */
export async function mergeThreadRowData(
  db: SupabaseClient,
  input: { threadId: string; ownerUserId: string; patch?: Row; remove?: string[] },
): Promise<boolean> {
  const patch = input.patch ?? {};
  const remove = input.remove ?? [];
  try {
    const { data, error } = await db.rpc("merge_inbox_thread_row_data", {
      p_thread_id: input.threadId,
      p_owner: input.ownerUserId,
      p_patch: patch,
      p_remove: remove,
    });
    if (!error) return data === true;
    if (!isMissingSchema(error)) return false;
  } catch {
    /* fall through to the read/write path */
  }
  try {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const { data } = await db
        .from("portal_inbox_thread_records")
        .select("row_data, updated_at")
        .eq("id", input.threadId)
        .eq("owner_user_id", input.ownerUserId)
        .maybeSingle();
      if (!data) return false;
      const current = ((data as Row).row_data && typeof (data as Row).row_data === "object" ? (data as Row).row_data : {}) as Row;
      const next: Row = { ...current, ...patch };
      for (const key of remove) delete next[key];
      const { data: updated, error } = await db
        .from("portal_inbox_thread_records")
        .update({ row_data: next })
        .eq("id", input.threadId)
        .eq("owner_user_id", input.ownerUserId)
        .eq("updated_at", str((data as Row).updated_at))
        .select("id");
      if (!error && Array.isArray(updated) && updated.length > 0) return true;
    }
  } catch {
    /* best effort */
  }
  return false;
}
