import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { DispatchRunRow } from "./types";

export function isTerminalService(row: unknown): boolean {
  if (!row || typeof row !== "object" || Array.isArray(row)) return true;
  const value = row as Record<string, unknown>;
  const terminal = (field: unknown) => typeof field === "string" && ["completed", "cancelled", "canceled"].includes(field.trim().toLowerCase());
  return terminal(value.bucket) || terminal(value.status) || (value.completedAt != null && String(value.completedAt) !== "");
}

export async function dispatchWorkOrderIsOpen(db: SupabaseClient, run: DispatchRunRow, residentUserId?: string): Promise<boolean> {
  if (run.source_type !== "work_order") return true;
  const { data, error } = await db.from("portal_work_order_records").select("resident_user_id, row_data")
    .eq("id", run.source_id).eq("manager_user_id", run.owner_user_id).maybeSingle();
  const record = data as { resident_user_id?: string | null; row_data?: unknown } | null;
  return !error && Boolean(record) && (!residentUserId || record?.resident_user_id === residentUserId) && !isTerminalService(record?.row_data);
}
