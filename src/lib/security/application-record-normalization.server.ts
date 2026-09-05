import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { normalizeApplicationAxisId } from "@/lib/manager-applications-storage";
import { applicationPhotoFolderKey } from "@/lib/rental-application/application-photos.server";

export type ApplicationRecordSnapshot = {
  id: string;
  manager_user_id?: string | null;
  resident_email?: string | null;
  property_id?: string | null;
  assigned_property_id?: string | null;
  row_data: unknown;
};

/** After actor authorization and identity decrypt/reseal for the exact old/new PKs.
 * The RPC atomically moves document aliases and parent references before deleting
 * the old row. It rechecks the trusted source snapshot and never replaces an
 * existing target application, including another account's case/legacy alias.
 */
export async function persistRenamedApplicationRecord(
  db: SupabaseClient,
  existing: ApplicationRecordSnapshot,
  next: ApplicationRecordSnapshot,
): Promise<void> {
  if (!existing.id || existing.id === next.id || normalizeApplicationAxisId(existing.id) !== next.id ||
      applicationPhotoFolderKey(existing.id) !== applicationPhotoFolderKey(next.id)) {
    throw new Error("Application identifier cannot be safely normalized.");
  }
  const { error } = await db.rpc("normalize_application_record_id", {
    p_old_id: existing.id,
    p_expected: {
      row_data: existing.row_data,
      manager_user_id: existing.manager_user_id ?? null,
      resident_email: existing.resident_email ?? null,
      property_id: existing.property_id ?? null,
      assigned_property_id: existing.assigned_property_id ?? null,
    },
    p_next: next,
  });
  if (error) throw new Error("Application normalization could not be completed safely. Refresh and retry.");
}
