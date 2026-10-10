import "server-only";

import { INQUIRY_EVENT_RECORD_TYPE } from "@/lib/tour-inquiry-create.server";
import { normalizeLeadSource } from "@/lib/listing-channels/lead-source";
import { applicantDisplayName } from "@/lib/rental-application/applicant-name";
import { openApplicantRow } from "@/lib/security/applicant-identity";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import type { ListingSiteLead } from "@/lib/listing-channels/leads";
import type { ListingChannelId } from "@/lib/listing-channels/registry";

/** `.in(...)` becomes a query string, so the property list is asked for in slices. */
const ID_CHUNK = 200;
/** Rows per page of a read; every page is ordered by the primary key. */
const PAGE = 500;
/** The newest leads a site's page lists; a page of leads, not an export. */
export const LISTING_SITE_LEADS_LIMIT = 100;


function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function asObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/**
 * The leads that arrived through one site's tagged link (`?src=<channel>`): tour requests and
 * applications whose `source_channel` is this site, scoped to the listings of the workspace the caller
 * was authenticated into. `propertyIds` must be `workspace.propertyIds` from the session, never from
 * the request. Service client, scoped here; the caller must already have authenticated the manager.
 *
 * A tour request writes one event row per requested time window, so tours are de-duplicated by the
 * inquiry id they carry. Each read is PAGED, ordered by primary key, so a page boundary cannot
 * repeat or skip a row, and the newest 100 are the newest of ALL the tagged rows: ids are not
 * time-ordered, so a plain `limit` would hide the most recent leads of a busy channel. A failed page
 * throws, so the tab reports the failure instead of showing a short list as the whole truth.
 */
export async function listingSiteLeads({
  channel,
  propertyIds,
  now = new Date(),
}: {
  channel: ListingChannelId;
  propertyIds: readonly string[];
  now?: Date;
}): Promise<ListingSiteLead[]> {
  if (!normalizeLeadSource(channel) || propertyIds.length === 0) return [];
  const db = createSupabaseServiceRoleClient();
  const leads: ListingSiteLead[] = [];

  const tours = new Map<string, ListingSiteLead>();
  for (const slice of chunk(propertyIds, ID_CHUNK)) {
    for (let from = 0; ; from += PAGE) {
      const { data, error } = await db
        .from("portal_schedule_records")
        .select("id, property_id, starts_at, row_data")
        .eq("record_type", INQUIRY_EVENT_RECORD_TYPE)
        .eq("source_channel", channel)
        .in("property_id", slice)
        .order("id", { ascending: true })
        .range(from, from + PAGE - 1);
      if (error) throw new Error(error.message);
      if (!data) break;
      for (const row of data as { id: unknown; property_id: unknown; starts_at: unknown; row_data: unknown }[]) {
        const payload = asObject(asObject(row.row_data)?.payload);
        const tourId = text(payload?.id);
        if (!payload || !tourId) continue;
        const startsAt = text(row.starts_at) || null;
        const existing = tours.get(tourId);
        // Several windows -> several rows; the lead is dated by its earliest requested window.
        if (existing && (!startsAt || (existing.at && existing.at <= startsAt))) continue;
        const started = startsAt ? new Date(startsAt).getTime() : NaN;
        tours.set(tourId, {
          kind: "tour",
          id: tourId,
          propertyId: String(row.property_id),
          name: applicantDisplayName({ name: text(payload.name), email: text(payload.email) }, "Tour request"),
          at: startsAt,
          bucket: Number.isFinite(started) && started < now.getTime() ? "past" : "pending",
        });
      }
      if (data.length < PAGE) break;
    }
  }
  leads.push(...tours.values());

  for (const slice of chunk(propertyIds, ID_CHUNK)) {
    for (let from = 0; ; from += PAGE) {
      const { data, error } = await db
        .from("manager_application_records")
        .select("id, property_id, row_data, updated_at")
        .eq("source_channel", channel)
        .in("property_id", slice)
        .order("id", { ascending: true })
        .range(from, from + PAGE - 1);
      if (error) throw new Error(error.message);
      if (!data) break;
      for (const record of data as { id: unknown; property_id: unknown; row_data: unknown; updated_at: unknown }[]) {
        if (!record.row_data) continue;
        const id = String(record.id);
        // Soft open: one undecryptable row must not hide the rest.
        const row = openApplicantRow(record.row_data, id, undefined, { soft: true });
        leads.push({
          kind: "application",
          id,
          propertyId: String(record.property_id),
          name: applicantDisplayName(row, "Applicant"),
          at: text(record.updated_at) || null,
          bucket: row.bucket === "approved" ? "approved" : row.bucket === "rejected" ? "rejected" : "pending",
        });
      }
      if (data.length < PAGE) break;
    }
  }

  leads.sort((a, b) => (b.at ?? "").localeCompare(a.at ?? ""));
  return leads.slice(0, LISTING_SITE_LEADS_LIMIT);
}
