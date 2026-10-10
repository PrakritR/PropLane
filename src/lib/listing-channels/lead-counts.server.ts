import "server-only";

import { INQUIRY_EVENT_RECORD_TYPE } from "@/lib/tour-inquiry-create.server";
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
 * counted over the listings this session already resolved.
 *
 * `propertyIds` must be the session's own list, narrowed by `leadReadablePropertyIds` exactly as the
 * Leads tab narrows it, and never re-derived from `manager_property_records.workspace_id`: in a
 * shared workspace the viewer holds a subset of the owner's houses, a workspace-wide re-read counted
 * the houses they were not assigned, and `workspace.propertyIds` alone would badge a count of
 * applicants and tour requesters whose identities the Leads tab deliberately withholds.
 *
 * A tour request writes one row per requested time window, all carrying the same channel, so tours
 * are counted by the inquiry id they share — the same collapse the Leads tab makes, so the badge and
 * the list can never disagree. Only `tour_inquiry` schedule rows are leads.
 *
 * Every paged read is ordered by the primary key: PostgREST leaves row order unspecified without
 * one, so past the first page the same row could be counted twice or skipped and the counts would
 * be silently wrong. A failed page THROWS rather than returning what it had: a badge quietly short
 * of the leads the tab lists is worse than no badge, and the caller already degrades to no counts.
 */
export async function leadCountsByChannel({
  propertyIds,
  propertyId,
}: {
  propertyIds: readonly string[];
  propertyId?: string;
}): Promise<Record<string, number>> {
  const scoped = [...new Set(propertyIds.map((id) => id.trim()).filter(Boolean))];
  // A property named in the request only narrows; it can never reach past the session's own list.
  const ids = propertyId ? scoped.filter((id) => id === propertyId) : scoped;
  if (ids.length === 0) return {};

  const db = createSupabaseServiceRoleClient();
  const counts: Record<string, number> = {};
  const bump = (raw: unknown) => {
    const channel = normalizeLeadSource(raw);
    if (channel) counts[channel] = (counts[channel] ?? 0) + 1;
  };

  // Tours: several rows per request, one lead. Deduped on the inquiry id the rows share.
  const seenTours = new Set<string>();
  for (const slice of chunk(ids, ID_CHUNK)) {
    for (let from = 0; ; from += PAGE) {
      const { data, error } = await db
        .from("portal_schedule_records")
        .select("id, source_channel, inquiry:row_data->payload->>id")
        .eq("record_type", INQUIRY_EVENT_RECORD_TYPE)
        .in("property_id", slice)
        .not("source_channel", "is", null)
        .order("id", { ascending: true })
        .range(from, from + PAGE - 1);
      if (error) throw new Error(error.message);
      if (!data) break;
      for (const row of data as { id: unknown; source_channel: unknown; inquiry: unknown }[]) {
        const inquiryId = typeof row.inquiry === "string" ? row.inquiry.trim() : "";
        const key = inquiryId || `row:${String(row.id)}`;
        if (seenTours.has(key)) continue;
        seenTours.add(key);
        bump(row.source_channel);
      }
      if (data.length < PAGE) break;
    }
  }

  for (const slice of chunk(ids, ID_CHUNK)) {
    for (let from = 0; ; from += PAGE) {
      const { data, error } = await db
        .from("manager_application_records")
        .select("id, source_channel")
        .in("property_id", slice)
        .not("source_channel", "is", null)
        .order("id", { ascending: true })
        .range(from, from + PAGE - 1);
      if (error) throw new Error(error.message);
      if (!data) break;
      for (const row of data as { source_channel: unknown }[]) bump(row.source_channel);
      if (data.length < PAGE) break;
    }
  }
  return counts;
}
