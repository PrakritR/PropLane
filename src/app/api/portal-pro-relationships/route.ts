import { createJsonRecordRoute } from "@/lib/portal-record-api";
import { orFilterForIdentity } from "@/lib/supabase/or-filter";

export const runtime = "nodejs";

const route = createJsonRecordRoute({
  table: "portal_pro_relationship_records",
  scope: (query, user) => {
    const q = query as { or: (expr: string) => unknown };
    if (user.role === "admin") return query;
    const scope = orFilterForIdentity([
      ["manager_user_id", user.id],
      ["related_user_id", user.id],
      ["related_email", user.email],
    ]);
    // No identity means no rows, never the whole table.
    return scope ? q.or(scope) : (query as { eq: (c: string, v: string) => unknown }).eq("manager_user_id", "");
  },
  buildUpsert: (row) => ({
    id: row.id,
    manager_user_id: row.managerUserId ?? row.manager_user_id ?? null,
    // related_user_id is intentionally NOT populated from the record's
    // linkedUserId. This mirror is per-writer: each participant's row carries
    // THAT writer's perspective (linkDirection, linkedAxisId, perms). Letting the
    // counterpart read it via related_user_id fed a co-manager's incoming row back
    // to the primary manager, who then mis-derived themselves as non-primary and
    // lost the Co-managers nav. Cross-participant reads are unnecessary here — the
    // relationships page reads the authoritative /api/pro/account-links, and inbox
    // scope reads account_link_invites — so each user reads only their OWN rows.
    related_user_id: row.relatedUserId ?? row.related_user_id ?? null,
    related_email: row.relatedEmail ?? row.related_email ?? null,
    row_data: row,
    updated_at: new Date().toISOString(),
  }),
  assignOwnership: (record, user) =>
    user.role === "admin" ? record : { ...record, manager_user_id: user.id },
});

export const GET = route.GET;
export const POST = route.POST;
