import "server-only";

import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { normalizeLeadSource } from "@/lib/listing-channels/lead-source";

const PAGE = 1000;

/**
 * Leads per listing site: rows carrying a `source_channel` (tour requests and applications),
 * scoped to the workspace's own listings (and one listing when `propertyId` is given).
 * Service client, scoped here by workspace; the caller must already have authenticated the manager.
 */
export async function leadCountsByChannel({
  workspaceId,
  propertyId,
}: {
  workspaceId: string;
  propertyId?: string;
}): Promise<Record<string, number>> {
  const db = createSupabaseServiceRoleClient();
  const { data: props, error } = await db.from("manager_property_records").select("id").eq("workspace_id", workspaceId);
  if (error) return {};
  let ids = (props ?? []).map((p) => String((p as { id: unknown }).id));
  if (propertyId) ids = ids.filter((id) => id === propertyId);
  if (ids.length === 0) return {};

  const counts: Record<string, number> = {};
  for (const table of ["portal_schedule_records", "manager_application_records"] as const) {
    for (let from = 0; ; from += PAGE) {
      const { data, error: readError } = await db
        .from(table)
        .select("source_channel")
        .in("property_id", ids)
        .not("source_channel", "is", null)
        .range(from, from + PAGE - 1);
      if (readError || !data) break;
      for (const row of data as { source_channel: unknown }[]) {
        const channel = normalizeLeadSource(row.source_channel);
        if (channel) counts[channel] = (counts[channel] ?? 0) + 1;
      }
      if (data.length < PAGE) break;
    }
  }
  return counts;
}
