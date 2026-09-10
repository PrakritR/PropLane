import type { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { purgeAccountStorageFolder } from "@/lib/auth/purge-account-storage";

type ServiceDb = ReturnType<typeof createSupabaseServiceRoleClient>;

/** Run after personal rows are removed, before Auth deletion. Shared copies remain readable. */
export async function purgeSharedAccountAttachments(db: ServiceDb, userId: string): Promise<void> {
  for (const [bucket, folder] of [
    ["portal-inbox-attachments", userId],
    ["bug-feedback-attachments", `bug-feedback/${userId}`],
  ]) {
    await purgeAccountStorageFolder(db, bucket, folder, async paths => {
      const { data, error } = await db.rpc("account_referenced_attachment_paths", {
        p_candidates: paths.map(path => ({ path, encoded: encodeURIComponent(path) })),
      });
      if (error) throw new Error(`Attachment ownership check failed: ${error.message}`);
      if (!Array.isArray(data) || data.some(path => typeof path !== "string")) {
        throw new Error("Attachment ownership check returned invalid data.");
      }
      return new Set(data as string[]);
    });
  }
}
