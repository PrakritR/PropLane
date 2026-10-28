import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import {
  ChannelCalendarInputError,
  channelCalendarProviderLabel,
  channelImportUrlErrorMessage,
  icalLabelKey,
  isValidChannelImportUrl,
  normalizeChannelImportUrl,
  normalizeIcalLabel,
} from "@/lib/channel-calendar/airbnb-url";
import { invalidateFeedReads } from "@/lib/channel-calendar/export-feed-reads.server";
import { isPrivateOrInternalHostname } from "@/lib/channel-calendar/ical-host";
import { fetchPinnedPublicHttps, NonPublicHostError } from "@/lib/sheet-sync/public-host.server";
import {
  buildExportCalendarUrl,
  mergeChannelImportedRanges,
  mintChannelCalendarExportToken,
  parseConnectionRow,
  toPublicConnection,
} from "@/lib/channel-calendar/connections.server";
import type {
  ChannelCalendarConnectionRow,
  ChannelCalendarImportedRange,
  ChannelCalendarProvider,
} from "@/lib/channel-calendar/types";
import { isHostBlockSummary } from "@/lib/channel-calendar/host-block";
import { parseReservationDescription } from "@/lib/channel-calendar/reservation-details";
import {
  diffChannelReservations,
  reservationIdentities,
  reservationIdentitiesElsewhere,
  withoutMovedReservations,
} from "@/lib/channel-calendar/channel-booking-diff";
import { emitChannelBookingEvent, emitChannelClashEvent } from "@/lib/channel-booking-events.server";
import { detectChannelClashes } from "@/lib/channel-calendar/channel-overlap.server";
import { parseIcsCalendar } from "@/lib/ical/parse";
import { pacificCalendarDateYmd } from "@/lib/pacific-time";
import type { MockProperty } from "@/data/types";
import type { ManagerListingSubmissionV1 } from "@/lib/manager-listing-submission";
import { releaseAirbnbResidentsAbsentFromFeed } from "@/lib/channel-calendar/airbnb-residents.server";
import { importedRangeUid, pruneTombstonedRanges } from "@/lib/channel-calendar/stay-tombstones";
import {
  clearChannelStayTombstonesForRoom,
  loadChannelStayTombstoneKeys,
} from "@/lib/channel-calendar/stay-tombstones.server";

const IMPORT_FETCH_TIMEOUT_MS = 15_000;

export function icalEventsToImportedRanges(
  events: ReturnType<typeof parseIcsCalendar>,
): ChannelCalendarImportedRange[] {
  return events.map((ev) => {
    const hostBlock = isHostBlockSummary(ev.summary);
    // Only the reservation code and phone suffix survive; the description itself is dropped.
    const details = hostBlock ? {} : parseReservationDescription(ev.description);
    return {
      id: ev.uid,
      sourceUid: ev.uid,
      summary: ev.summary,
      ...(hostBlock ? { hostBlock: true } : {}),
      ...(details.reservationCode ? { reservationCode: details.reservationCode } : {}),
      ...(details.phoneLast4 ? { phoneLast4: details.phoneLast4 } : {}),
      start: ev.startDate,
      end: ev.endDate,
    };
  });
}

/** A real channel export is a few hundred KB at most; anything past this is not a calendar. */
export const IMPORT_MAX_BYTES = 2 * 1024 * 1024;
const IMPORT_MAX_REDIRECTS = 3;

/** Read a response body as text, stopping (and cancelling the stream) the moment it passes the cap. */
async function readCappedText(res: Response, maxBytes: number): Promise<string> {
  const tooBig = () => new Error("The calendar file is too large to import.");
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await res.body?.cancel().catch(() => undefined);
    throw tooBig();
  }
  if (!res.body) {
    const text = await res.text();
    if (new TextEncoder().encode(text).byteLength > maxBytes) throw tooBig();
    return text;
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let received = 0;
  let text = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    if (received > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw tooBig();
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

/** "Other calendar" redirects may land on any https site, but never on a private or internal host. */
function isSafeIcalRedirect(raw: string): boolean {
  try {
    const url = new URL(raw);
    return url.protocol === "https:" && !url.username && !url.password && !isPrivateOrInternalHostname(url.hostname);
  } catch {
    return false;
  }
}

/** A calendar answers `text/calendar` or opens with BEGIN:VCALENDAR; HTML and JSON do neither. */
export function looksLikeIcalResponse(contentType: string | null, body: string): boolean {
  if ((contentType ?? "").toLowerCase().includes("text/calendar")) return body.includes("BEGIN:VCALENDAR");
  return body.replace(/^\uFEFF/, "").trimStart().startsWith("BEGIN:VCALENDAR");
}

/**
 * Fetches a channel's iCal export. The stored URL passed `isValidChannelImportUrl`, but the provider
 * may answer with a redirect, and `redirect: "follow"` would carry the server to any host it names.
 * Redirects are followed by hand (at most three), and every `Location` must itself be a valid
 * HTTPS import URL for the same provider. The body is read as a stream and abandoned at 2 MB.
 *
 * "Other calendar" (`ical`) has no host allowlist, so it is fetched through the pinned public-host
 * client instead: the name is resolved once, every address must be public, and the connection is
 * made to exactly those addresses (no DNS rebinding). Each redirect hop is re-vetted the same way.
 *
 * `timeoutMs` is the budget for the WHOLE fetch, not per hop: every hop is given only what is left of
 * it, so a slow host cannot hold a request for hop-count times the caller's deadline (the manager's
 * check gives up at 8s and the validate route promises 6s).
 */
export async function fetchChannelIcs(
  importUrl: string,
  provider: ChannelCalendarProvider,
  opts: { label?: string | null; timeoutMs?: number } = {},
): Promise<string> {
  const timeoutMs = opts.timeoutMs ?? IMPORT_FETCH_TIMEOUT_MS;
  const name = channelCalendarProviderLabel(provider, opts.label);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const deadline = Date.now() + timeoutMs;
  const isIcal = provider === "ical";
  const get = async (target: string): Promise<Response> => {
    if (!isIcal) {
      return fetch(target, {
        signal: controller.signal,
        headers: { Accept: "text/calendar, text/plain, */*" },
        redirect: "manual",
        cache: "no-store",
      });
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error(`Could not reach the ${name} calendar link.`);
    try {
      return await fetchPinnedPublicHttps(target, {
        headers: { accept: "text/calendar, text/plain, */*" },
        timeoutMs: remaining,
        totalTimeoutMs: remaining,
      });
    } catch (e) {
      if (e instanceof NonPublicHostError) throw new Error(`${name} calendar link points at a private or internal address.`);
      throw new Error(`Could not reach the ${name} calendar link.`);
    }
  };
  try {
    let target = importUrl;
    for (let hop = 0; ; hop++) {
      const res = await get(target);
      if (res.status >= 300 && res.status < 400) {
        await res.body?.cancel().catch(() => undefined);
        const location = res.headers.get("location");
        if (!location || hop >= IMPORT_MAX_REDIRECTS) {
          throw new Error(`${name} calendar redirected too many times.`);
        }
        let next: string;
        try {
          next = new URL(location, target).toString();
        } catch {
          throw new Error(`${name} calendar redirected to an invalid address.`);
        }
        if (isIcal ? !isSafeIcalRedirect(next) : !isValidChannelImportUrl(provider, next)) {
          throw new Error(`${name} calendar redirected to an address outside its own calendar links.`);
        }
        target = next;
        continue;
      }
      if (!res.ok) {
        await res.body?.cancel().catch(() => undefined);
        throw new Error(`${name} calendar returned ${res.status}.`);
      }
      const text = await readCappedText(res, IMPORT_MAX_BYTES);
      if (isIcal ? !looksLikeIcalResponse(res.headers.get("content-type"), text) : !text.includes("BEGIN:VCALENDAR")) {
        throw new Error("Response was not a valid calendar file.");
      }
      return text;
    }
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
  /** The row's `occupancy_revision` (the compare-and-set token of {@link updateListingSubmission}); null when the read did not carry it. */
  occupancyRevision: number | null;
} | null> {
  const { data, error } = await db
    .from("manager_property_records")
    .select("manager_user_id, property_data, row_data, occupancy_revision")
    .eq("id", propertyId)
    .maybeSingle();
  if (error || !data) return null;
  return {
    managerUserId: data.manager_user_id ? String(data.manager_user_id) : null,
    property: (data.property_data ?? null) as MockProperty | null,
    rowData: (data.row_data ?? null) as Record<string, unknown> | null,
    occupancyRevision: Number.isFinite(Number((data as { occupancy_revision?: unknown }).occupancy_revision))
      && (data as { occupancy_revision?: unknown }).occupancy_revision != null
      ? Number((data as { occupancy_revision?: unknown }).occupancy_revision)
      : null,
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

type ConnectionKey = {
  propertyId: string;
  roomId: string;
  provider: ChannelCalendarProvider;
  /** Only an "Other calendar" key carries one: the site name is part of its identity. */
  label?: string | null;
};

/**
 * One room holds one connection per (channel), except "Other calendar", which holds one per site
 * name (Houfy and Furnished Finder on the same room). The match is by hand rather than PostgREST's
 * `onConflict`: the ical uniqueness is an expression index (`lower(coalesce(label,''))`), which an
 * upsert cannot target.
 */
async function findConnectionRow(db: SupabaseClient, key: ConnectionKey): Promise<Record<string, unknown> | null> {
  const { data } = await db
    .from("external_calendar_connections")
    .select("*")
    .eq("property_id", key.propertyId)
    .eq("room_id", key.roomId)
    .eq("provider", key.provider);
  const rows = (data ?? []) as Record<string, unknown>[];
  if (key.provider !== "ical") return rows[0] ?? null;
  const want = icalLabelKey(key.label);
  return rows.find((row) => icalLabelKey(row.label) === want) ?? null;
}

export async function upsertChannelCalendarConnection(
  db: SupabaseClient,
  input: {
    managerUserId: string;
    propertyId: string;
    roomId: string;
    provider?: ChannelCalendarProvider;
    label?: string | null;
    importUrl?: string | null;
  },
  browserOrigin?: string,
) {
  const provider = input.provider ?? "airbnb";
  // An "Other calendar" link IS the site it names: no name, no link.
  const label = provider === "ical" ? normalizeIcalLabel(input.label) : input.label?.trim() || "";
  if (provider === "ical" && !label) {
    throw new ChannelCalendarInputError("Name the site this calendar is for, such as Houfy.", "label");
  }
  const importUrlProvided = Object.prototype.hasOwnProperty.call(input, "importUrl");
  let importUrl: string | null | undefined = undefined;
  if (importUrlProvided) {
    importUrl = input.importUrl == null ? null : normalizeChannelImportUrl(input.importUrl);
    if (importUrl && !isValidChannelImportUrl(provider, importUrl)) {
      throw new ChannelCalendarInputError(channelImportUrlErrorMessage(provider));
    }
  }

  const record = await loadPropertyRecord(db, input.propertyId);
  const ownerUserId = record?.managerUserId?.trim();
  if (!ownerUserId) {
    throw new Error("Property not found.");
  }

  const key: ConnectionKey = { propertyId: input.propertyId, roomId: input.roomId, provider, label };
  const existing = await findConnectionRow(db, key);
  const exportToken = existing?.export_token ? String(existing.export_token) : mintChannelCalendarExportToken();
  const now = new Date().toISOString();
  const unlinking = importUrlProvided && importUrl === null;
  // Read the stays this feed had imported BEFORE the row is rewritten: unlinking
  // has to take their listing blocks and placeholder residents with them.
  const priorImportUrl = importUrlProvided && typeof existing?.import_url === "string" && existing.import_url.trim() ? existing.import_url.trim() : null;
  const priorRanges = unlinking && Array.isArray(existing?.imported_ranges)
    ? (existing.imported_ranges as ChannelCalendarImportedRange[])
    : [];

  const payload = {
    manager_user_id: ownerUserId,
    property_id: input.propertyId,
    room_id: input.roomId,
    provider,
    label: label || null,
    ...(importUrlProvided ? { import_url: importUrl } : {}),
    // Unlinking leaves nothing to re-sync, so the stays this feed imported go with the link —
    // otherwise they keep drawing on the calendar and blocking beds with no source to refresh them.
    ...(unlinking ? { imported_ranges: [], last_synced_at: null, last_error: null } : {}),
    export_token: exportToken,
    updated_at: now,
  };

  const write = (id: string | null) =>
    id
      ? db.from("external_calendar_connections").update(payload).eq("id", id).select("*").single()
      : db.from("external_calendar_connections").insert(payload).select("*").single();
  let { data, error } = await write(existing ? String(existing.id) : null);
  if (error && !existing && (error as { code?: string }).code === "23505") {
    // A concurrent save made the same link first; fold into it instead of failing the second click.
    const raced = await findConnectionRow(db, key);
    if (raced) ({ data, error } = await write(String(raced.id)));
  }
  if (error) throw new Error(error.message);
  invalidateFeedReads();
  const saved = parseConnectionRow(data as Record<string, unknown>);
  // The row is already rewritten, so releasing what the old feed imported comes first: its stays,
  // listing blocks and placeholder residents are what the `priorRanges` read above was taken for,
  // and nothing below may stand between an unlink and that cleanup.
  if (unlinking) {
    await releaseConnectionImportedStays(db, saved, priorRanges);
  }
  // A new feed has new event identities, so the old feed's removed-stay tombstones must not
  // prune its stays (Airbnb reuses one UID for every host block). Hygiene on an already-committed
  // row: a read or delete failure here is logged, never thrown past the write it follows.
  if (importUrlProvided && (priorImportUrl ?? null) !== (importUrl ?? null)) {
    try {
      await clearChannelStayTombstonesForRoom(db, { propertyId: input.propertyId, roomId: input.roomId, provider });
    } catch (e) {
      // Ids go in as `%s` arguments, never interpolated into the format string:
      // a `%d` inside a caller-supplied id would otherwise consume the error
      // argument and garble the log (CodeQL js/tainted-format-string).
      console.error(
        "[channel-calendar] could not clear stay tombstones for %s/%s/%s",
        input.propertyId,
        input.roomId,
        provider,
        e,
      );
    }
  }
  return toPublicConnection(saved, browserOrigin);
}

/**
 * Give back everything a feed's imported stays were holding: the room's
 * `channel-import-<id>-*` blocks on the listing and the `@import.proplane.local`
 * placeholder residents the sync filed. Used when the link is removed (unlinked
 * or deleted) — nothing is left to refresh them, so nothing may keep the bed.
 */
async function releaseConnectionImportedStays(
  db: SupabaseClient,
  connection: ChannelCalendarConnectionRow,
  priorRanges: readonly ChannelCalendarImportedRange[],
): Promise<void> {
  await updateListingSubmission(db, connection.property_id, (submission) =>
    applyImportedRangesToSubmission(submission, connection.room_id, connection.id, []),
  );
  const uids = [
    ...new Set(
      priorRanges
        .map((range) => String(range.sourceUid ?? range.id ?? "").trim())
        .filter(Boolean),
    ),
  ];
  for (const uid of uids) {
    await db
      .from("manager_application_records")
      .delete()
      .eq("manager_user_id", connection.manager_user_id)
      .eq("row_data->>icalConnectionId", connection.id)
      .eq("row_data->>icalSourceUid", uid)
      .like("resident_email", "%@import.proplane.local");
  }
}

export async function deleteChannelCalendarConnection(
  db: SupabaseClient,
  connectionId: string,
): Promise<void> {
  const { data: row } = await db
    .from("external_calendar_connections")
    .select("*")
    .eq("id", connectionId)
    .maybeSingle();
  if (!row) throw new Error("Connection not found.");
  const connection = parseConnectionRow(row as Record<string, unknown>);

  // Release BEFORE the row goes: the release is a compare-and-set write that can lose to a concurrent sync and throw
  // (ListingSubmissionConflictError). Deleting first and releasing after left the imported ranges on the listing with
  // no connection left to release them, so the room published as blocked forever. This order fails the other way —
  // the ranges are gone and the connection is still there, which the next sync re-imports.
  await releaseConnectionImportedStays(db, connection, connection.imported_ranges ?? []);

  const { error } = await db.from("external_calendar_connections").delete().eq("id", connectionId);
  if (error) throw new Error(error.message);
  invalidateFeedReads();
}

/**
 * Compare-and-set misses tolerated before a write gives up. Sync-all runs {@link SYNC_ALL_CONCURRENCY} rooms at once,
 * and every one of them can land on the same house: one write wins per round, so the last needs that many rounds
 * plus a spare.
 */
const LISTING_SUBMISSION_WRITE_ATTEMPTS = 6;

export class ListingSubmissionConflictError extends Error {
  constructor() {
    super("The listing changed while it was being updated. Try again.");
    this.name = "ListingSubmissionConflictError";
  }
}

/**
 * Read-modify-write of a house's `listingSubmission`, safe against another writer.
 *
 * A sync-all runs several rooms of one house at once, and each used to read the whole `property_data`, change its own
 * room, and write the WHOLE blob back with no check: whichever finished last erased the other room's ranges (a lost
 * update). The write is now compare-and-set on `manager_property_records.occupancy_revision` (the token the placement
 * triggers already bump): it lands only if the revision is still the one this attempt read, and it bumps it. On a miss
 * it re-reads and re-applies `apply` to the fresh row, up to {@link LISTING_SUBMISSION_WRITE_ATTEMPTS} times, then
 * throws {@link ListingSubmissionConflictError} rather than overwrite. `apply` runs again on every attempt, so it must
 * be a pure function of the submission it is handed. A house with no listing submission is left alone (returns null).
 * A read that carries no revision (an older database) falls back to the plain write.
 */
export async function updateListingSubmission(
  db: SupabaseClient,
  propertyId: string,
  apply: (submission: ManagerListingSubmissionV1) => ManagerListingSubmissionV1,
): Promise<{ property: MockProperty; submission: ManagerListingSubmissionV1 } | null> {
  for (let attempt = 0; attempt < LISTING_SUBMISSION_WRITE_ATTEMPTS; attempt += 1) {
    // Jittered, so writers that just collided do not collide again in step.
    if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, Math.floor(Math.random() * 15 * attempt)));
    const record = await loadPropertyRecord(db, propertyId);
    const submission = record?.property?.listingSubmission;
    if (!record || !submission) return null;
    const next = apply(submission);
    const nextProperty: MockProperty = { ...(record.property as MockProperty), listingSubmission: next };
    const payload = { property_data: nextProperty, updated_at: new Date().toISOString() };
    if (record.occupancyRevision === null) {
      const { error } = await db.from("manager_property_records").update(payload).eq("id", propertyId);
      if (error) throw new Error(error.message);
      invalidateFeedReads();
      return { property: nextProperty, submission: next };
    }
    const { data, error } = await db
      .from("manager_property_records")
      .update({ ...payload, occupancy_revision: record.occupancyRevision + 1 })
      .eq("id", propertyId)
      .eq("occupancy_revision", record.occupancyRevision)
      .select("id");
    if (error) throw new Error(error.message);
    if (Array.isArray(data) && data.length > 0) {
      invalidateFeedReads();
      return { property: nextProperty, submission: next };
    }
  }
  throw new ListingSubmissionConflictError();
}

/**
 * Writes a connection's stored ranges (and the dates they close on the listing)
 * without touching the feed. Used by Remove stay / Undo, which change what is
 * stored but never what the channel says.
 */
export async function persistConnectionImportedRanges(
  db: SupabaseClient,
  connection: ChannelCalendarConnectionRow,
  ranges: ChannelCalendarImportedRange[],
  opts: { removedUids?: readonly string[]; restoredRanges?: readonly ChannelCalendarImportedRange[] } = {},
): Promise<void> {
  await updateListingSubmission(db, connection.property_id, (submission) =>
    applyImportedRangesToSubmission(submission, connection.room_id, connection.id, ranges),
  );
  const { error } = await db
    .from("external_calendar_connections")
    .update({ imported_ranges: ranges, updated_at: new Date().toISOString() })
    .eq("id", connection.id);
  if (error) throw new Error(error.message);
  invalidateFeedReads();

  // The placeholder resident the sync filed for a removed reservation leaves with
  // it. Only the `@import.proplane.local` placeholder is ever touched — a row a
  // real person attached an account to is not an iCal ghost and stays.
  for (const uid of opts.removedUids ?? []) {
    await db
      .from("manager_application_records")
      .delete()
      .eq("manager_user_id", connection.manager_user_id)
      .eq("row_data->>icalConnectionId", connection.id)
      .eq("row_data->>icalSourceUid", uid)
      .like("resident_email", "%@import.proplane.local");
  }
  // An Undo no longer files a resident for the stay it brings back: a channel guest is DERIVED from the booking
  // rows (the Residents list's `channelGuestRows`), so there is nothing to place and no capacity trigger to trip.
}

/**
 * How long a reservation that LEFT a feed is remembered, so the room that gains it reads a move rather than a
 * new booking. Stored on the losing connection's own row (`released_identities`), not in process memory: a
 * "Sync all" or the cron can land the two syncs on different serverless instances.
 *
 * One hour: long enough for the other rooms of the workspace to sync after a relink, short enough that a stay
 * genuinely cancelled in one room cannot quietly swallow a later booking's alert in another.
 */
const RELEASED_MEMORY_MS = 60 * 60_000;

type ReleasedIdentities = Record<string, string>;

function readReleasedIdentities(raw: unknown, now: number): ReleasedIdentities {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: ReleasedIdentities = {};
  for (const [identity, at] of Object.entries(raw as Record<string, unknown>)) {
    const releasedAt = Date.parse(String(at ?? ""));
    if (!identity || !Number.isFinite(releasedAt) || now - releasedAt >= RELEASED_MEMORY_MS) continue;
    out[identity] = new Date(releasedAt).toISOString();
  }
  return out;
}

/**
 * Record what just left THIS feed, for the room of the same workspace that gains it. Best-effort and pruned
 * to {@link RELEASED_MEMORY_MS} on every write; a failure only means the next sync may alert.
 */
async function rememberReleased(
  db: SupabaseClient,
  connection: ChannelCalendarConnectionRow,
  released: readonly ChannelCalendarImportedRange[],
  storedRaw: unknown,
): Promise<void> {
  const now = Date.now();
  const kept = readReleasedIdentities(storedRaw, now);
  const storedCount = storedRaw && typeof storedRaw === "object" && !Array.isArray(storedRaw) ? Object.keys(storedRaw).length : 0;
  const pruned = Object.keys(kept).length !== storedCount;
  const at = new Date(now).toISOString();
  let added = false;
  for (const range of released) {
    for (const identity of reservationIdentities(range)) {
      if (!kept[identity]) added = true;
      kept[identity] = at;
    }
  }
  if (!added && !pruned) return;
  const { error } = await db
    .from("external_calendar_connections")
    .update({ released_identities: kept })
    .eq("id", connection.id);
  if (error) {
    console.warn("[channel-calendar] released identities not stored", { connectionId: connection.id, message: error.message });
  }
}

type SiblingConnection = {
  id: string;
  provider: ChannelCalendarProvider;
  label: string | null;
  import_url: string | null;
  last_synced_at: string | null;
  imported_ranges: ChannelCalendarImportedRange[];
  released: ReleasedIdentities;
};

/**
 * The manager's other channel connections in the SAME workspace as this one, most recently synced first. A
 * relink moves stays between rooms of one workspace, so a UID held in another of the manager's workspaces is
 * a different booking and must never suppress its alert.
 */
async function workspaceSiblingConnections(
  db: SupabaseClient,
  connection: ChannelCalendarConnectionRow,
): Promise<SiblingConnection[]> {
  const others = await db
    .from("external_calendar_connections")
    .select("id, property_id, provider, label, import_url, imported_ranges, released_identities, last_synced_at")
    .eq("manager_user_id", connection.manager_user_id)
    .neq("id", connection.id);
  if (others.error || !Array.isArray(others.data)) return [];
  const rows = others.data as Array<{
    id: unknown;
    property_id: unknown;
    provider: unknown;
    label: unknown;
    import_url: unknown;
    imported_ranges: unknown;
    released_identities: unknown;
    last_synced_at: unknown;
  }>;
  const propertyIds = [...new Set([connection.property_id, ...rows.map((row) => String(row.property_id ?? ""))].filter(Boolean))];
  const houses = await db.from("manager_property_records").select("id, workspace_id").in("id", propertyIds);
  if (houses.error) return [];
  const workspaceByProperty = new Map(
    ((houses.data ?? []) as Array<{ id: unknown; workspace_id: unknown }>).map((row) => [
      String(row.id),
      String(row.workspace_id ?? ""),
    ]),
  );
  const ownWorkspace = workspaceByProperty.get(connection.property_id) ?? "";
  const now = Date.now();
  return rows
    .filter((row) => (workspaceByProperty.get(String(row.property_id ?? "")) ?? "") === ownWorkspace)
    .map((row) => ({
      id: String(row.id),
      provider: String(row.provider ?? "airbnb") as ChannelCalendarProvider,
      label: typeof row.label === "string" ? row.label : null,
      import_url: typeof row.import_url === "string" ? row.import_url : null,
      last_synced_at: typeof row.last_synced_at === "string" ? row.last_synced_at : null,
      imported_ranges: Array.isArray(row.imported_ranges) ? (row.imported_ranges as ChannelCalendarImportedRange[]) : [],
      released: readReleasedIdentities(row.released_identities, now),
    }))
    .sort((a, b) => String(b.last_synced_at ?? "").localeCompare(String(a.last_synced_at ?? "")));
}

/** Identities the workspace's other rooms released recently: a stay that left one of them is not new here. */
function releasedElsewhere(siblings: readonly SiblingConnection[]): Set<string> {
  const out = new Set<string>();
  for (const sibling of siblings) for (const identity of Object.keys(sibling.released)) out.add(identity);
  return out;
}

/** The sibling-feed sweep: how many feeds at once, how many in one run, and how long the whole sweep may take. */
const MOVE_FEED_CONCURRENCY = 4;
const MOVE_FEED_READS_PER_RUN = 8;
const MOVE_FEED_SWEEP_BUDGET_MS = 10_000;

/**
 * Which identities of the stays still in question the LIVE feeds of the workspace's other rooms on the SAME
 * channel carry (a relink moves a stay between rooms of one listing on one channel). `questioned` is one group
 * of identities per stay - its UID and its reservation code - and a stay is accounted for as soon as ANY of
 * its identities turns up, since a feed carries whichever of them it knows.
 *
 * Most recently synced first, four feeds at a time, at most {@link MOVE_FEED_READS_PER_RUN} in one sync and
 * never past {@link MOVE_FEED_SWEEP_BUDGET_MS}: this runs on the sync request, after the calendar itself is
 * already saved, so it must never spend the whole function budget. It stops the moment every stay in question
 * is accounted for. A feed that cannot be read is skipped - an unread feed says nothing about a move, so the
 * alert goes out as it always did.
 */
async function freshSiblingIdentities(
  siblings: readonly SiblingConnection[],
  provider: ChannelCalendarProvider,
  questioned: readonly (readonly string[])[],
): Promise<Set<string>> {
  const found = new Set<string>();
  const groups = questioned.filter((group) => group.length > 0);
  if (groups.length === 0) return found;
  const wanted = new Set(groups.flat());
  const queue = siblings
    .filter((sibling) => sibling.provider === provider)
    .filter((sibling) => {
      const url = sibling.import_url?.trim();
      return Boolean(url) && isValidChannelImportUrl(sibling.provider, url!);
    })
    .slice(0, MOVE_FEED_READS_PER_RUN);
  if (queue.length === 0) return found;

  const deadline = Date.now() + MOVE_FEED_SWEEP_BUDGET_MS;
  const answered = () => groups.every((group) => group.some((identity) => found.has(identity)));
  let next = 0;
  const worker = async (): Promise<void> => {
    while (!answered() && Date.now() < deadline) {
      const sibling = queue[next++];
      if (!sibling) return;
      try {
        const text = await fetchChannelIcs(sibling.import_url!.trim(), sibling.provider, {
          label: sibling.label,
          timeoutMs: Math.max(0, deadline - Date.now()),
        });
        for (const identity of reservationIdentitiesElsewhere([icalEventsToImportedRanges(parseIcsCalendar(text))])) {
          if (wanted.has(identity)) found.add(identity);
        }
      } catch {
        /* a feed that cannot be read says nothing about a move: the alert goes out as it always did */
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(MOVE_FEED_CONCURRENCY, queue.length) }, worker));
  return found;
}

/**
 * Drop the created / cancelled pair a relink produces, whichever room syncs first:
 *   * a stay another room of the workspace already HOLDS is still there (stored ranges);
 *   * a stay another room RELEASED within {@link RELEASED_MEMORY_MS} is not new here (its own stored memory);
 *   * a stay another room's LIVE feed now carries has moved there, even though that room has not stored it yet.
 * Everything is scoped to this connection's workspace. An unreadable neighbour set is "no moves known": the
 * alert goes out as it always did.
 */
async function withoutMoves(
  db: SupabaseClient,
  connection: ChannelCalendarConnectionRow,
  diff: ReturnType<typeof diffChannelReservations>,
): Promise<ReturnType<typeof diffChannelReservations>> {
  if (diff.created.length === 0 && diff.cancelled.length === 0) return diff;
  try {
    const siblings = await workspaceSiblingConnections(db, connection);
    const elsewhere = reservationIdentitiesElsewhere(siblings.map((sibling) => sibling.imported_ranges));
    for (const identity of releasedElsewhere(siblings)) elsewhere.add(identity);
    let narrowed = withoutMovedReservations(diff, elsewhere);
    if (narrowed.cancelled.length > 0 && siblings.length > 0) {
      // Only the stays still in question are worth a feed read, and the sweep stops once it has them all.
      const questioned = [...narrowed.cancelled, ...narrowed.created].map((range) => reservationIdentities(range));
      const fresh = await freshSiblingIdentities(siblings, connection.provider, questioned);
      if (fresh.size > 0) narrowed = withoutMovedReservations({ created: narrowed.created, cancelled: narrowed.cancelled }, fresh);
    }
    return { created: narrowed.created, cancelled: narrowed.cancelled };
  } catch {
    return diff;
  }
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
    throw new Error(`Add a ${channelCalendarProviderLabel(connection.provider, connection.label)} import URL before syncing.`);
  }
  if (!isValidChannelImportUrl(connection.provider, importUrl)) {
    throw new Error(`Stored import URL is not a valid ${channelCalendarProviderLabel(connection.provider, connection.label)} calendar link.`);
  }

  // The row names a property, and a sync writes room blocks onto it. Connections are written only by the
  // server routes (which stamp the property's own owner), but this stays the backstop: a row whose manager is
  // not the property's owner (hand-written, or left over from an ownership move) is skipped, never synced.
  const owning = await loadPropertyRecord(db, connection.property_id);
  if (!owning?.managerUserId || owning.managerUserId !== connection.manager_user_id) {
    console.warn("[channel-calendar] channel_sync_foreign_property", {
      connectionId: connection.id,
      propertyId: connection.property_id,
    });
    throw new Error("channel_sync_foreign_property");
  }

  const now = new Date().toISOString();
  try {
    const icsText = await fetchChannelIcs(importUrl, connection.provider, { label: connection.label });
    // C2-AB7: a stay the manager removed is not stored again, so neither Bookings
    // nor the public room calendar nor the occupancy snapshot ever see it back.
    const tombstoneKeys = await loadChannelStayTombstoneKeys(db, [connection.property_id]);
    const firstPass = pruneTombstonedRanges(
      icalEventsToImportedRanges(parseIcsCalendar(icsText)),
      { propertyId: connection.property_id, roomId: connection.room_id, provider: connection.provider },
      tombstoneKeys,
    );
    const imported = firstPass.kept;
    if (firstPass.dropped.length > 0) {
      // Diagnostics only (last_error means failure): a sync that stores fewer ranges than the feed
      // carried should say so, with the UIDs, so a wrongly pruned stay is findable.
      console.info(
        `[channel-calendar] sync ${connection.id}: pruned_count=${firstPass.dropped.length} (${firstPass.dropped
          .map((r) => `${importedRangeUid(r)}@${r.start}..${r.end}`)
          .join(", ")}) kept=${imported.length}`,
      );
    }

    const applied = await updateListingSubmission(db, connection.property_id, (submission) =>
      applyImportedRangesToSubmission(submission, connection.room_id, connection.id, imported),
    );
    if (!applied) throw new Error("Property listing data is not available to apply blocks.");
    const record = { property: applied.property };
    const updatedSubmission = applied.submission;
    // No resident is filed for an imported stay. The import's own room block already holds those nights, so a
    // placement for the same dates is refused by `assert_room_placement_capacity` ("This room is blocked for the
    // requested dates") on every run; the Residents list derives channel guests from the booking rows instead.

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
    invalidateFeedReads();
    // A Remove that landed while this sync was reading the feed wrote its
    // tombstone after the keys above were read; re-check once so the stay it
    // removed cannot slip back in through the save we just made.
    const latestKeys = await loadChannelStayTombstoneKeys(db, [connection.property_id]);
    const recheck = pruneTombstonedRanges(
      imported,
      { propertyId: connection.property_id, roomId: connection.room_id, provider: connection.provider },
      latestKeys,
    );
    if (recheck.dropped.length > 0) {
      await persistConnectionImportedRanges(db, parseConnectionRow(saved as Record<string, unknown>), recheck.kept);
    }
    // The placeholder for a reservation that left this feed has to leave with it. Best-effort,
    // and retried on the next sync: a resident row must never fail the calendar sync.
    const today = pacificCalendarDateYmd(new Date(now));
    try {
      await releaseAirbnbResidentsAbsentFromFeed(db, {
        managerUserId: connection.manager_user_id,
        connectionId: connection.id,
        ranges: recheck.kept,
        today,
      });
    } catch (releaseError) {
      console.warn("[channel-calendar] cancelled resident release failed", {
        connectionId: connection.id,
        message: releaseError instanceof Error ? releaseError.message : String(releaseError),
      });
    }
    // Every sync path (cron, Sync, Sync all) ends here, so the alert diff lives here too.
    // Best-effort: an alert that cannot be sent must never fail a calendar sync.
    try {
      const room = updatedSubmission.rooms.find((item) => item.id === connection.room_id);
      const rawDiff = diffChannelReservations({
        previous: connection.imported_ranges ?? [],
        next: recheck.kept,
        // Never synced = the first read of this channel: record what is there, announce nothing.
        baseline: !connection.last_synced_at,
        // The Pacific wall date, like every other date key here: a UTC date is
        // already tomorrow after 17:00 PT, which filed today's stays as history.
        today,
      });
      // A relink moves the same stays between rooms of this workspace: a stay the workspace's other rooms
      // hold, or whose live feed now carries it, is moved - never "new" in one room and "cancelled" in the
      // other, in either sync order.
      const diff = await withoutMoves(db, connection, rawDiff);
      // Then remember what left THIS feed, for the room of this workspace that gains it. Recorded after the
      // diff above, so a stay this sync released never suppresses its own cancellation, and on the row
      // itself, so any instance running the other room's sync can read it.
      await rememberReleased(db, connection, rawDiff.cancelled, (row as Record<string, unknown>).released_identities);
      const base = {
        connectionId: connection.id,
        managerUserId: connection.manager_user_id,
        propertyId: connection.property_id,
        roomId: connection.room_id,
        provider: connection.provider,
        channelLabel: connection.provider === "ical" ? connection.label : null,
        propertyLabel: record.property.buildingName?.trim() || record.property.title?.trim() || undefined,
        roomLabel: room?.name?.trim() || connection.label?.trim() || undefined,
      };
      for (const range of diff.created) await emitChannelBookingEvent(db, { ...base, event: "channel_booking_created", range });
      for (const range of diff.cancelled) await emitChannelBookingEvent(db, { ...base, event: "channel_booking_cancelled", range });
    } catch (alertError) {
      // Delivery has its own retry; the sync result is the calendar. Never swallow it silently:
      // a rejected action_events insert (a domain missing from the DB check) hid every alert for weeks.
      console.warn("[channel-calendar] booking alert failed", {
        connectionId: connection.id,
        message: alertError instanceof Error ? alertError.message : String(alertError),
      });
    }
    // Two things holding one room on the same nights (Airbnb and Booking.com both sold it, or a channel reservation
    // landed on a PropLane stay that is not it): ONE alert per clash, idempotent on the clash's own key, so whichever
    // room syncs first announces it. Best-effort like the alerts above.
    try {
      const clashes = await detectChannelClashes(db, { propertyId: connection.property_id, connectionId: connection.id, today });
      for (const clash of clashes) {
        await emitChannelClashEvent(db, {
          clash,
          managerUserId: connection.manager_user_id,
          propertyLabel: record.property.buildingName?.trim() || record.property.title?.trim() || undefined,
        });
      }
    } catch (clashError) {
      console.warn("[channel-calendar] clash alert failed", {
        connectionId: connection.id,
        message: clashError instanceof Error ? clashError.message : String(clashError),
      });
    }
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

/**
 * One PropLane export link per (room, channel) - reuses the existing token when present.
 * `destination` is the site the link is pasted into. "other" (any site without a channel of its own) has no channel of
 * its own: it reuses any link the room already has, or mints an Airbnb-channel one, and adds
 * `?channels=all` so the feed carries every channel's bookings.
 */
export async function ensureRoomExportCalendarUrl(
  db: SupabaseClient,
  input: {
    propertyId: string;
    roomId: string;
    label?: string | null;
    destination?: ChannelCalendarProvider | "other";
  },
  browserOrigin?: string,
): Promise<string> {
  const destination = input.destination ?? "airbnb";
  const provider: ChannelCalendarProvider = destination === "other" ? "airbnb" : destination;
  const suffix = destination === "other" ? "?channels=all" : "";
  let token: unknown;
  if (provider === "ical" && destination !== "other") {
    // One link per site name: Houfy's feed is not Furnished Finder's.
    token = (await findConnectionRow(db, { propertyId: input.propertyId, roomId: input.roomId, provider, label: input.label }))?.export_token;
  } else {
    let query = db
      .from("external_calendar_connections")
      .select("export_token")
      .eq("property_id", input.propertyId)
      .eq("room_id", input.roomId);
    if (destination !== "other") query = query.eq("provider", provider);
    const { data: existing } = await query.limit(1);
    token = existing?.[0]?.export_token;
  }
  if (token) return `${buildExportCalendarUrl(String(token), browserOrigin)}${suffix}`;

  const record = await loadPropertyRecord(db, input.propertyId);
  const ownerUserId = record?.managerUserId?.trim();
  if (!ownerUserId) throw new Error("Property not found.");

  const connection = await upsertChannelCalendarConnection(
    db,
    {
      managerUserId: ownerUserId,
      propertyId: input.propertyId,
      roomId: input.roomId,
      provider,
      label: input.label ?? null,
    },
    browserOrigin,
  );
  return `${connection.exportUrl}${suffix}`;
}

/** The cron route's `maxDuration` in ms (`api/cron/sync-channel-calendars`); a test keeps the two in step. */
export const CHANNEL_SYNC_CRON_MAX_DURATION_MS = 120_000;
/** Feeds fetched at once. Four keeps 56+ feeds inside the cron without hammering one channel. */
export const SYNC_ALL_CONCURRENCY = 4;
/** No new fetch starts once less than this is left of the cron's duration (a fetch may run 15s). */
export const SYNC_ALL_STOP_SCHEDULING_MS = 20_000;

export type SyncAllResult = { synced: number; failed: number; skipped: number };

/**
 * Sync every saved import URL, {@link SYNC_ALL_CONCURRENCY} at a time. The least recently synced
 * connections go first, and no new fetch is scheduled once the cron's time budget has under
 * {@link SYNC_ALL_STOP_SCHEDULING_MS} left; whatever was not started is reported as `skipped` and goes
 * first on the next run, so a large portfolio converges instead of running out the clock mid-write.
 */
type SyncPoolOptions = {
  concurrency?: number;
  budgetMs?: number;
  stopSchedulingMs?: number;
  now?: () => number;
  syncOne?: (db: SupabaseClient, connectionId: string) => Promise<unknown>;
};

/**
 * Sync the given connections, {@link SYNC_ALL_CONCURRENCY} at a time, in the order given. Stops
 * scheduling new fetches with under {@link SYNC_ALL_STOP_SCHEDULING_MS} left of the budget; whatever
 * was not started is `skipped`. The cron and the portal's Sync all both run through this.
 */
export async function syncChannelCalendarConnectionIds(
  db: SupabaseClient,
  connectionIds: readonly string[],
  options: SyncPoolOptions = {},
): Promise<SyncAllResult> {
  const now = options.now ?? Date.now;
  const startedAt = now();
  const budgetMs = options.budgetMs ?? CHANNEL_SYNC_CRON_MAX_DURATION_MS;
  const stopSchedulingMs = options.stopSchedulingMs ?? SYNC_ALL_STOP_SCHEDULING_MS;
  const syncOne = options.syncOne ?? syncChannelCalendarConnection;
  const result: SyncAllResult = { synced: 0, failed: 0, skipped: 0 };
  let next = 0;
  const worker = async () => {
    for (;;) {
      if (budgetMs - (now() - startedAt) < stopSchedulingMs) return;
      const id = connectionIds[next];
      if (id === undefined) return;
      next += 1;
      try {
        await syncOne(db, id);
        result.synced += 1;
      } catch {
        result.failed += 1;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(options.concurrency ?? SYNC_ALL_CONCURRENCY, connectionIds.length || 1)) }, worker));
  result.skipped = Math.max(0, connectionIds.length - next);
  return result;
}

export async function syncAllChannelCalendarImports(db: SupabaseClient, options: SyncPoolOptions = {}): Promise<SyncAllResult> {
  const { data, error } = await db
    .from("external_calendar_connections")
    .select("id, import_url, last_synced_at")
    .not("import_url", "is", null);
  if (error) throw new Error(error.message);

  const queue = (data ?? [])
    .filter((row) => String(row.import_url ?? "").trim())
    .sort((a, b) => String(a.last_synced_at ?? "").localeCompare(String(b.last_synced_at ?? "")))
    .map((row) => String(row.id));
  return syncChannelCalendarConnectionIds(db, queue, options);
}

export async function loadConnectionByExportToken(
  db: SupabaseClient,
  exportToken: string,
): Promise<ChannelCalendarConnectionRow | null> {
  const { data, error } = await db
    .from("external_calendar_connections")
    .select("*")
    .eq("export_token", exportToken)
    .limit(1)
    .maybeSingle();
  if (error || !data) return null;
  return parseConnectionRow(data as Record<string, unknown>);
}
