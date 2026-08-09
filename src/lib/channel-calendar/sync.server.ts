import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import { isValidAirbnbImportUrl, normalizeAirbnbImportUrl } from "@/lib/channel-calendar/airbnb-url";
import {
  mergeChannelImportedRanges,
  mintChannelCalendarExportToken,
  parseConnectionRow,
  toPublicConnection,
} from "@/lib/channel-calendar/connections.server";
import type { ChannelCalendarConnectionRow } from "@/lib/channel-calendar/types";
import type { ChannelCalendarImportedRange } from "@/lib/channel-calendar/types";
import { parseIcsCalendar } from "@/lib/ical/parse";
import type { MockProperty } from "@/data/types";
import type { ManagerListingSubmissionV1 } from "@/lib/manager-listing-submission";

const IMPORT_FETCH_TIMEOUT_MS = 15_000;

function icalEventsToImportedRanges(
  events: ReturnType<typeof parseIcsCalendar>,
): ChannelCalendarImportedRange[] {
  return events.map((ev) => ({
    id: ev.uid,
    sourceUid: ev.uid,
    summary: ev.summary,
    start: ev.startDate,
    end: ev.endDate,
  }));
}

async function fetchAirbnbIcs(importUrl: string): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), IMPORT_FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(importUrl, {
      signal: controller.signal,
      headers: { Accept: "text/calendar, text/plain, */*" },
      redirect: "follow",
      cache: "no-store",
    });
    if (!res.ok) {
      throw new Error(`Airbnb calendar returned ${res.status}.`);
    }
    const text = await res.text();
    if (!text.includes("BEGIN:VCALENDAR")) {
      throw new Error("Response was not a valid calendar file.");
    }
    return text;
  } finally {
    clearTimeout(timer);
  }
}

function applyImportedRangesToSubmission(
  submission: ManagerListingSubmissionV1,
  roomId: string,
  connectionId: string,
  imported: ChannelCalendarImportedRange[],
): ManagerListingSubmissionV1 {
  const rooms = submission.rooms.map((room) => {
    if (room.id !== roomId) return room;
    return {
      ...room,
      manualUnavailableRanges: mergeChannelImportedRanges(
        room.manualUnavailableRanges ?? [],
        connectionId,
        imported,
      ),
    };
  });
  return { ...submission, rooms };
}

export async function loadPropertyRecord(
  db: SupabaseClient,
  propertyId: string,
): Promise<{
  managerUserId: string | null;
  property: MockProperty | null;
  rowData: Record<string, unknown> | null;
} | null> {
  const { data, error } = await db
    .from("manager_property_records")
    .select("manager_user_id, property_data, row_data")
    .eq("id", propertyId)
    .maybeSingle();
  if (error || !data) return null;
  return {
    managerUserId: data.manager_user_id ? String(data.manager_user_id) : null,
    property: (data.property_data ?? null) as MockProperty | null,
    rowData: (data.row_data ?? null) as Record<string, unknown> | null,
  };
}

export async function listChannelCalendarConnections(
  db: SupabaseClient,
  propertyId: string,
  browserOrigin?: string,
) {
  const { data, error } = await db
    .from("external_calendar_connections")
    .select("*")
    .eq("property_id", propertyId)
    .order("created_at", { ascending: true });
  if (error) throw new Error(error.message);
  return (data ?? []).map((row) => toPublicConnection(parseConnectionRow(row as Record<string, unknown>), browserOrigin));
}

export async function upsertChannelCalendarConnection(
  db: SupabaseClient,
  input: {
    managerUserId: string;
    propertyId: string;
    roomId: string;
    provider?: "airbnb";
    label?: string | null;
    importUrl?: string | null;
  },
  browserOrigin?: string,
) {
  const importUrlProvided = Object.prototype.hasOwnProperty.call(input, "importUrl");
  let importUrl: string | null | undefined = undefined;
  if (importUrlProvided) {
    importUrl = input.importUrl == null ? null : normalizeAirbnbImportUrl(input.importUrl);
    if (importUrl && !isValidAirbnbImportUrl(importUrl)) {
      throw new Error("Import URL must be an Airbnb calendar link (https://www.airbnb.com/calendar/ical/…).");
    }
  }

  const record = await loadPropertyRecord(db, input.propertyId);
  const ownerUserId = record?.managerUserId?.trim();
  if (!ownerUserId) {
    throw new Error("Property not found.");
  }

  const { data: existing } = await db
    .from("external_calendar_connections")
    .select("id, export_token")
    .eq("property_id", input.propertyId)
    .eq("room_id", input.roomId)
    .eq("provider", input.provider ?? "airbnb")
    .maybeSingle();

  const exportToken = existing?.export_token ? String(existing.export_token) : mintChannelCalendarExportToken();
  const now = new Date().toISOString();

  const payload = {
    manager_user_id: ownerUserId,
    property_id: input.propertyId,
    room_id: input.roomId,
    provider: input.provider ?? "airbnb",
    label: input.label?.trim() || null,
    ...(importUrlProvided ? { import_url: importUrl } : {}),
    export_token: exportToken,
    updated_at: now,
  };

  const { data, error } = await db
    .from("external_calendar_connections")
    .upsert(payload, { onConflict: "property_id,room_id,provider" })
    .select("*")
    .single();
  if (error) throw new Error(error.message);
  return toPublicConnection(parseConnectionRow(data as Record<string, unknown>), browserOrigin);
}

export async function deleteChannelCalendarConnection(
  db: SupabaseClient,
  connectionId: string,
): Promise<void> {
  const { data: row } = await db
    .from("external_calendar_connections")
    .select("id, property_id, room_id")
    .eq("id", connectionId)
    .maybeSingle();
  if (!row) throw new Error("Connection not found.");

  const { error } = await db.from("external_calendar_connections").delete().eq("id", connectionId);
  if (error) throw new Error(error.message);

  const record = await loadPropertyRecord(db, String(row.property_id));
  const submission = record?.property?.listingSubmission;
  if (submission) {
    const updated = applyImportedRangesToSubmission(submission, String(row.room_id), connectionId, []);
    await persistListingSubmission(db, String(row.property_id), record.property, updated);
  }
}

async function persistListingSubmission(
  db: SupabaseClient,
  propertyId: string,
  property: MockProperty | null,
  submission: ManagerListingSubmissionV1,
): Promise<void> {
  const nextProperty: MockProperty = {
    ...(property ?? { id: propertyId, title: "", tagline: "", address: "", zip: "", neighborhood: "", beds: 0, baths: 0, rentLabel: "", available: "", petFriendly: false, buildingId: propertyId, buildingName: "", unitLabel: "" }),
    listingSubmission: submission,
  };
  const { error } = await db
    .from("manager_property_records")
    .update({
      property_data: nextProperty,
      updated_at: new Date().toISOString(),
    })
    .eq("id", propertyId);
  if (error) throw new Error(error.message);
}

export async function syncChannelCalendarConnection(
  db: SupabaseClient,
  connectionId: string,
): Promise<ChannelCalendarConnectionRow> {
  const { data: row, error } = await db
    .from("external_calendar_connections")
    .select("*")
    .eq("id", connectionId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!row) throw new Error("Connection not found.");

  const connection = parseConnectionRow(row as Record<string, unknown>);
  const importUrl = connection.import_url?.trim();
  if (!importUrl) {
    throw new Error("Add an Airbnb import URL before syncing.");
  }
  if (!isValidAirbnbImportUrl(importUrl)) {
    throw new Error("Stored import URL is not a valid Airbnb calendar link.");
  }

  const now = new Date().toISOString();
  try {
    const icsText = await fetchAirbnbIcs(importUrl);
    const imported = icalEventsToImportedRanges(parseIcsCalendar(icsText));

    const record = await loadPropertyRecord(db, connection.property_id);
    if (!record?.property?.listingSubmission) {
      throw new Error("Property listing data is not available to apply blocks.");
    }
    const updatedSubmission = applyImportedRangesToSubmission(
      record.property.listingSubmission,
      connection.room_id,
      connection.id,
      imported,
    );
    await persistListingSubmission(db, connection.property_id, record.property, updatedSubmission);

    const { data: saved, error: saveError } = await db
      .from("external_calendar_connections")
      .update({
        imported_ranges: imported,
        last_synced_at: now,
        last_error: null,
        updated_at: now,
      })
      .eq("id", connectionId)
      .select("*")
      .single();
    if (saveError) throw new Error(saveError.message);
    return parseConnectionRow(saved as Record<string, unknown>);
  } catch (e) {
    const message = e instanceof Error ? e.message : "Sync failed.";
    await db
      .from("external_calendar_connections")
      .update({ last_error: message, updated_at: now })
      .eq("id", connectionId);
    throw new Error(message);
  }
}

export async function loadConnectionByExportToken(
  db: SupabaseClient,
  exportToken: string,
): Promise<ChannelCalendarConnectionRow | null> {
  const { data, error } = await db
    .from("external_calendar_connections")
    .select("*")
    .eq("export_token", exportToken)
    .maybeSingle();
  if (error || !data) return null;
  return parseConnectionRow(data as Record<string, unknown>);
}
