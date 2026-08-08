import { randomBytes } from "node:crypto";

import type { ManagerListingSubmissionV1, ManagerRoomUnavailableRange } from "@/lib/manager-listing-submission";
import type { MockProperty } from "@/data/types";
import {
  CHANNEL_CALENDAR_IMPORTED_RANGE_PREFIX,
  type ChannelCalendarConnectionPublic,
  type ChannelCalendarConnectionRow,
  type ChannelCalendarImportedRange,
  type ChannelCalendarProvider,
} from "@/lib/channel-calendar/types";
import { resolveShareableAppOrigin } from "@/lib/app-url";

export function mintChannelCalendarExportToken(): string {
  return randomBytes(24).toString("base64url");
}

export function channelImportRangeId(connectionId: string, sourceUid: string): string {
  const safeUid = sourceUid.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 80);
  return `${CHANNEL_CALENDAR_IMPORTED_RANGE_PREFIX}-${connectionId}-${safeUid}`;
}

export function importedRangesToUnavailable(
  connectionId: string,
  ranges: ChannelCalendarImportedRange[],
): ManagerRoomUnavailableRange[] {
  return ranges.map((r) => ({
    id: channelImportRangeId(connectionId, r.sourceUid || r.id),
    start: r.start,
    end: r.end,
  }));
}

export function stripChannelImportedRanges(
  ranges: ManagerRoomUnavailableRange[],
  connectionId: string,
): ManagerRoomUnavailableRange[] {
  const prefix = `${CHANNEL_CALENDAR_IMPORTED_RANGE_PREFIX}-${connectionId}-`;
  return (ranges ?? []).filter((r) => !r.id.startsWith(prefix));
}

export function mergeChannelImportedRanges(
  existing: ManagerRoomUnavailableRange[],
  connectionId: string,
  imported: ChannelCalendarImportedRange[],
): ManagerRoomUnavailableRange[] {
  const kept = stripChannelImportedRanges(existing, connectionId);
  return [...kept, ...importedRangesToUnavailable(connectionId, imported)];
}

export function buildExportCalendarUrl(exportToken: string, browserOrigin?: string): string {
  const trimmed = browserOrigin?.trim().replace(/\/$/, "");
  if (trimmed) {
    return `${trimmed}/api/calendar/export/${encodeURIComponent(exportToken)}.ics`;
  }
  const origin = resolveShareableAppOrigin(browserOrigin);
  return `${origin}/api/calendar/export/${encodeURIComponent(exportToken)}.ics`;
}

export function toPublicConnection(
  row: ChannelCalendarConnectionRow,
  browserOrigin?: string,
): ChannelCalendarConnectionPublic {
  const imported = Array.isArray(row.imported_ranges) ? row.imported_ranges : [];
  return {
    id: row.id,
    propertyId: row.property_id,
    roomId: row.room_id,
    provider: row.provider,
    label: row.label,
    hasImportUrl: Boolean(row.import_url?.trim()),
    exportUrl: buildExportCalendarUrl(row.export_token, browserOrigin),
    importedRangeCount: imported.length,
    lastSyncedAt: row.last_synced_at,
    lastError: row.last_error,
  };
}

export function parseConnectionRow(raw: Record<string, unknown>): ChannelCalendarConnectionRow {
  const importedRaw = raw.imported_ranges;
  const imported: ChannelCalendarImportedRange[] = Array.isArray(importedRaw)
    ? importedRaw
        .map((item) => {
          if (!item || typeof item !== "object") return null;
          const o = item as Record<string, unknown>;
          const start = String(o.start ?? "").trim();
          const end = String(o.end ?? start).trim();
          if (!start) return null;
          return {
            id: String(o.id ?? "").trim() || `${start}:${end}`,
            start,
            end,
            sourceUid: String(o.sourceUid ?? o.source_uid ?? "").trim(),
            summary: String(o.summary ?? "").trim(),
          };
        })
        .filter((x): x is ChannelCalendarImportedRange => Boolean(x))
    : [];

  return {
    id: String(raw.id),
    manager_user_id: String(raw.manager_user_id),
    property_id: String(raw.property_id),
    room_id: String(raw.room_id),
    provider: String(raw.provider ?? "airbnb") as ChannelCalendarProvider,
    label: raw.label == null ? null : String(raw.label),
    import_url: raw.import_url == null ? null : String(raw.import_url),
    export_token: String(raw.export_token),
    imported_ranges: imported,
    last_synced_at: raw.last_synced_at == null ? null : String(raw.last_synced_at),
    last_error: raw.last_error == null ? null : String(raw.last_error),
  };
}

export function listingSubmissionFromProperty(property: MockProperty | null): ManagerListingSubmissionV1 | null {
  const sub = property?.listingSubmission;
  if (!sub || typeof sub !== "object") return null;
  return sub;
}

export function roomUnavailableRangesForExport(
  submission: ManagerListingSubmissionV1 | null,
  roomId: string,
): { start: string; end: string }[] {
  if (!submission) return [];
  const room = submission.rooms.find((r) => r.id === roomId);
  if (!room) return [];
  return (room.manualUnavailableRanges ?? []).map((r) => ({
    start: r.start,
    end: r.end || r.start,
  }));
}
