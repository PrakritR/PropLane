import "server-only";

import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { normalizeLeadSource } from "@/lib/listing-channels/lead-source";

const PAGE = 1000;
/** `.in(...)` becomes a query string, so the property list is asked for in slices. */
const ID_CHUNK = 200;

function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * Leads per listing site: rows carrying a `source_channel` (tour requests and applications),
 * scoped to the workspace's own listings (and one listing when `propertyId` is given).
 * Service client, scoped here by workspace; the caller must already have authenticated the manager.
 *
 * Every paged read is ordered by the primary key: PostgREST leaves row order unspecified without
 * one, so past the first page the same row could be counted twice or skipped and the counts would
 * be silently wrong.
 */
export async function leadCountsByChannel({
  workspaceId,
  propertyId,
}: {
  workspaceId: string;
  propertyId?: string;
}): Promise<Record<string, number>> {
  const db = createSupabaseServiceRoleClient();

  let ids: string[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await db
      .from("manager_property_records")
      .select("id")
      .eq("workspace_id", workspaceId)
      .order("id", { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) return {};
    const page = (data ?? []) as { id: unknown }[];
    for (const row of page) ids.push(String(row.id));
    if (page.length < PAGE) break;
  }
  if (propertyId) ids = ids.filter((id) => id === propertyId);
  if (ids.length === 0) return {};

  const counts: Record<string, number> = {};
  for (const table of ["portal_schedule_records", "manager_application_records"] as const) {
    for (const slice of chunk(ids, ID_CHUNK)) {
      for (let from = 0; ; from += PAGE) {
        const { data, error: readError } = await db
          .from(table)
          .select("id, source_channel")
          .in("property_id", slice)
          .not("source_channel", "is", null)
          .order("id", { ascending: true })
          .range(from, from + PAGE - 1);
        if (readError || !data) break;
        for (const row of data as { source_channel: unknown }[]) {
          const channel = normalizeLeadSource(row.source_channel);
          if (channel) counts[channel] = (counts[channel] ?? 0) + 1;
        }
        if (data.length < PAGE) break;
      }
    }
  }
  return counts;
}
