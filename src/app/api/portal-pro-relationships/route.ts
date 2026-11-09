import { relationshipStorageId } from "@/lib/auth/pro-relationship-storage-id.server";
import { createJsonRecordRoute } from "@/lib/portal-record-api";

export const runtime = "nodejs";

const route = createJsonRecordRoute({
  table: "portal_pro_relationship_records",
  existingRowSelect: "id, manager_user_id, row_data",
  deleteRowSelect: "id, manager_user_id, row_data",
  // This is a per-writer presentation mirror, including for admins. Grants
  // continue to come from accepted account links, never these client rows.
  scope: (query, user) => (query as { eq: (column: string, value: string) => unknown }).eq("manager_user_id", user.id),
  projectRead: async ({ user, records }) => {
    const byLogicalId = new Map<string, Record<string, unknown>>();
    for (const record of records) {
      const data = record.row_data;
      if (!data || typeof data !== "object") continue;
      const logicalId = (data as Record<string, unknown>).id ?? record.id;
      if (typeof logicalId !== "string" || !logicalId) continue;
      const current = byLogicalId.get(logicalId);
      if (!current || record.id === relationshipStorageId(user.id, logicalId)) byLogicalId.set(logicalId, record);
    }
    return [...byLogicalId.values()];
  },
  resolveDeleteIds: async ({ db, user, ids }) => {
    const candidates = [...new Set(ids.flatMap((id) => [id, relationshipStorageId(user.id, id)]))];
    const { data, error } = await db.from("portal_pro_relationship_records").select("id, row_data").eq("manager_user_id", user.id).in("id", candidates);
    if (error) throw new Error("Could not verify relationship records.");
    const requested = new Set(ids);
    const owned = (data ?? []).flatMap((record) => {
      const logicalId = record.row_data && typeof record.row_data === "object" ? ((record.row_data as Record<string, unknown>).id ?? record.id) : record.id;
      return typeof logicalId === "string" && requested.has(logicalId) && (record.id === logicalId || record.id === relationshipStorageId(user.id, logicalId)) ? [{ logicalId, id: String(record.id) }] : [];
    });
    return ids.every((id) => owned.some((record) => record.logicalId === id)) ? owned.map((record) => record.id) : [];
  },
  buildUpsert: (row, user) => {
    const safeRow = { ...row, managerUserId: user.id };
    for (const key of ["manager_user_id", "relatedUserId", "related_user_id", "relatedEmail", "related_email"]) delete safeRow[key as keyof typeof safeRow];
    return {
      id: typeof row.id === "string" && row.id ? relationshipStorageId(user.id, row.id) : null,
      manager_user_id: user.id,
      related_user_id: null,
      related_email: null,
      row_data: safeRow,
      updated_at: new Date().toISOString(),
    };
  },
});

export async function GET(req: Request) {
  return route.GET(req);
}
export const POST = route.POST;
