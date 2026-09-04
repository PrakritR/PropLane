import { createJsonRecordRoute } from "@/lib/portal-record-api";
import { orFilterForIdentity } from "@/lib/supabase/or-filter";

export const runtime = "nodejs";

const route = createJsonRecordRoute({
  table: "portal_resident_lease_upload_records",
  scope: (query, user) => {
    const q = query as { or: (expr: string) => unknown };
    if (user.role === "admin") return query;
    const scope = orFilterForIdentity([
      ["resident_user_id", user.id],
      ["resident_email", user.email],
    ]);
    // No identity means no rows, never the whole table.
    return scope ? q.or(scope) : (query as { eq: (c: string, v: string) => unknown }).eq("resident_user_id", "");
  },
  buildUpsert: (row) => ({
    id: row.id,
    resident_user_id: row.residentUserId ?? row.resident_user_id ?? null,
    resident_email: row.email ?? row.residentEmail ?? row.resident_email ?? null,
    row_data: row,
    updated_at: new Date().toISOString(),
  }),
  assignOwnership: (record, user) =>
    user.role === "admin"
      ? record
      : { ...record, resident_user_id: user.id, resident_email: user.email ?? record.resident_email ?? null },
});

export const GET = route.GET;
export const POST = route.POST;
