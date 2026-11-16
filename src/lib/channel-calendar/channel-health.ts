/**
 * Channel health: is each channel still reading PropLane's calendar, did it echo our stays back, and which rooms
 * sit closed for a long time without anyone having said so. Pure; `channel-health.server.ts` reads the rows.
 *
 * Plan `channels-sync-1027` (GAP 4, GAP 5). Three kinds of finding feed the Bookings attention list:
 *  - the feed: a channel has not fetched our export for {@link FEED_STALE_AFTER_HOURS} hours (decision D2), or the
 *    last export failed;
 *  - the echo: a stay PropLane exports to Airbnb is still missing from Airbnb's own feed after Airbnb fetched ours
 *    and PropLane synced theirs since (one poll), so the room may be sellable twice;
 *  - the closure: a room closed with no end, or for more than {@link LONG_CLOSURE_NIGHTS} nights, by the manager
 *    (Reopen) or on the channel (Open on Airbnb). A vacant room hidden for a year is the most expensive silent state.
 */
import { isImportedChannelBlock } from "@/lib/channel-calendar/property-bookings";
import { isHostBlockRange } from "@/lib/channel-calendar/host-block";
import type { VacancyRoom } from "@/lib/channel-calendar/vacancy-post";
import type { ChannelCalendarProvider } from "@/lib/channel-calendar/types";
import { tombstoneBelongsToConnection, type ChannelStayTombstone } from "@/lib/channel-calendar/stay-tombstones";
import { coveringIntervals, nextDayKey, previousDayKey, uncovered } from "@/lib/room-occupancy-rule";

/** Decision D2: a channel that has not fetched the export for this long is stale. Airbnb polls every few hours. */
export const FEED_STALE_AFTER_HOURS = 6;
export const FEED_STALE_AFTER_MS = FEED_STALE_AFTER_HOURS * 60 * 60_000;
/** After Airbnb fetches our feed it needs a moment before its own feed carries what it read; sync after this much counts as a poll. */
export const ECHO_GRACE_MS = 30 * 60_000;
/** A closure longer than this many nights is a standing closure, not a stay. */
export const LONG_CLOSURE_NIGHTS = 60;
/**
 * Import sync health (the other direction: PropLane reading the channel). The cron runs every 15 minutes, so a
 * connection unsynced for {@link SYNC_STALE_AFTER_HOURS} has missed several runs; one unsynced for
 * {@link SYNC_NOTICE_AFTER_HOURS} is reported to the manager (`channel-sync-notice.server.ts`).
 */
export const SYNC_STALE_AFTER_HOURS = 2;
export const SYNC_STALE_AFTER_MS = SYNC_STALE_AFTER_HOURS * 60 * 60_000;
export const SYNC_NOTICE_AFTER_HOURS = 6;
export const SYNC_NOTICE_AFTER_MS = SYNC_NOTICE_AFTER_HOURS * 60 * 60_000;
/** "Stays imported in the window": a week back through this many days ahead. */
export const SYNC_WINDOW_BACK_DAYS = 7;
export const SYNC_WINDOW_AHEAD_DAYS = 90;
/** A removed reservation the feed still lists is worth a line while it is current or ended this recently. */
export const REMOVED_STAY_SURFACE_DAYS = 3;
/** Prefix `export/[token]/route.ts` puts on `last_error` when the export failed (the import sync writes its own errors there). */
export const EXPORT_FEED_ERROR_PREFIX = "Export feed failed";

export type FeedState =
  /** Fetched within the threshold. */
  | "fetched"
  /** Has not fetched within the threshold. */
  | "stale"
  /** Linked and synced for longer than the threshold, and the channel never fetched. */
  | "never"
  /** The export route failed on its last build. */
  | "error"
  /** Linked recently: nothing to say yet. */
  | "waiting"
  /** A channel that does not identify its crawler, so a fetch cannot be told from silence. */
  | "unmonitored";

export type HealthConnection = {
  id: string;
  propertyId: string;
  roomId: string;
  roomLabel: string;
  /** The house's name, so two houses that both have a "Room 3" read apart. Optional. */
  houseLabel?: string;
  provider: ChannelCalendarProvider;
  label: string | null;
  lastSyncedAt: string | null;
  lastError: string | null;
  exportLastFetchedAt: string | null;
  /** A pasted import link; a connection with none is export-only and never syncs. Absent reads as linked. */
  hasImportUrl?: boolean;
  /** The imported ranges, last night INCLUSIVE (`ChannelCalendarImportedRange`). */
  ranges: ReadonlyArray<{ start: string; end: string; hostBlock?: boolean; summary?: string | null }>;
};

/** A PropLane block (stay or manager closure) as the health reader needs it. `checkOut` is exclusive. */
export type HealthStay = {
  id: string;
  propertyId: string;
  /** "" = the whole home. */
  roomId: string;
  roomLabel: string;
  houseLabel?: string;
  name: string;
  reason: string;
  checkIn: string;
  checkOut: string;
  openEnded: boolean;
  cancelled: boolean;
  closed: boolean;
  createdAt: string | null;
};

export type ChannelAttentionItem = {
  id: string;
  kind: "stale_feed" | "feed_error" | "sync_error" | "sync_stale" | "removed_stay_hidden" | "missing_echo" | "manager_closure" | "channel_closure" | "unassigned_approval";
  propertyId: string;
  roomId: string;
  /** One plain sentence. No subtext. */
  text: string;
  action?:
    | { kind: "reopen"; blockId: string }
    | { kind: "open_on_channel"; provider: ChannelCalendarProvider };
};

export type ChannelHealthChannel = {
  provider: ChannelCalendarProvider;
  /** The site name of an "Other calendar" link. */
  label: string | null;
  linked: number;
  total: number;
  feed: FeedState;
};

export type ChannelHealthHouse = {
  propertyId: string;
  label: string;
  rooms: number;
  /** Null when the occupancy read failed: nothing is advertised on an unverified read. */
  vacancy: VacancyRoom[] | null;
  /** The post for this house, built from `vacancy` and the workspace's text number. Null with `vacancy`. */
  post: string | null;
  channels: ChannelHealthChannel[];
};

/** One room x platform: when PropLane last read that channel, what it said, and what it holds. */
export type ChannelSyncRow = {
  connectionId: string;
  propertyId: string;
  roomId: string;
  houseLabel: string;
  roomLabel: string;
  provider: ChannelCalendarProvider;
  label: string | null;
  lastSyncedAt: string | null;
  /** The last sync's failure, or null. The export feed's own error is not an import failure and is left out. */
  lastError: string | null;
  /** Reservations (not host blocks) stored in the window. */
  staysInWindow: number;
  /** Removed stays the channel still lists, which PropLane is holding back on purpose. */
  hiddenRemoved: number;
  state: "ok" | "never" | "stale" | "error";
};

export type ChannelHealth = { houses: ChannelHealthHouse[]; items: ChannelAttentionItem[]; sync?: ChannelSyncRow[] };

function ms(iso: string | null | undefined): number {
  const value = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(value) ? value : NaN;
}

/** "5257 Brooklyn · " when the house is known. */
function housePrefix(house: string | undefined): string {
  return house?.trim() ? `${house.trim()} \u00b7 ` : "";
}

function channelName(provider: ChannelCalendarProvider, label: string | null): string {
  if (provider === "airbnb") return "Airbnb";
  if (provider === "booking_com") return "Booking.com";
  if (provider === "vrbo") return "Vrbo";
  return label?.trim() || "The calendar site";
}

/** Whole hours, rounded down, never below 1 in a sentence. */
function hoursText(durationMs: number): string {
  const hours = Math.max(1, Math.floor(durationMs / 3_600_000));
  return hours >= 48 ? `${Math.floor(hours / 24)} days` : `${hours} hours`;
}

/** The state of one connection's export feed at `now`. Only Airbnb's crawler is recognised, so only Airbnb can go stale. */
export function feedStateFor(
  connection: Pick<HealthConnection, "provider" | "exportLastFetchedAt" | "lastSyncedAt" | "lastError">,
  now: Date,
  thresholdMs: number = FEED_STALE_AFTER_MS,
): FeedState {
  if (connection.lastError?.startsWith(EXPORT_FEED_ERROR_PREFIX)) return "error";
  if (connection.provider !== "airbnb") return "unmonitored";
  const fetched = ms(connection.exportLastFetchedAt);
  if (Number.isFinite(fetched)) return now.getTime() - fetched > thresholdMs ? "stale" : "fetched";
  const synced = ms(connection.lastSyncedAt);
  return Number.isFinite(synced) && now.getTime() - synced > thresholdMs ? "never" : "waiting";
}

function feedItems(connections: readonly HealthConnection[], now: Date, thresholdMs: number): ChannelAttentionItem[] {
  const items: ChannelAttentionItem[] = [];
  for (const connection of connections) {
    const state = feedStateFor(connection, now, thresholdMs);
    const place = `${housePrefix(connection.houseLabel)}${channelName(connection.provider, connection.label)} \u00b7 ${connection.roomLabel}`;
    if (state === "stale") {
      const since = now.getTime() - ms(connection.exportLastFetchedAt);
      items.push({ id: `stale_feed:${connection.id}`, kind: "stale_feed", propertyId: connection.propertyId, roomId: connection.roomId, text: `${place} has not read PropLane's calendar in ${hoursText(since)}` });
    } else if (state === "never") {
      items.push({ id: `stale_feed:${connection.id}`, kind: "stale_feed", propertyId: connection.propertyId, roomId: connection.roomId, text: `${place} has never read PropLane's calendar` });
    } else if (state === "error") {
      items.push({ id: `feed_error:${connection.id}`, kind: "feed_error", propertyId: connection.propertyId, roomId: connection.roomId, text: `${place}: PropLane's calendar could not be built on the last fetch` });
    }
  }
  return items;
}

function lastNightOf(stay: Pick<HealthStay, "checkOut" | "openEnded">): string | null {
  return stay.openEnded || stay.checkOut >= "9999-12-31" ? null : previousDayKey(stay.checkOut);
}

function dayDiff(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T12:00:00Z`) - Date.parse(`${from}T12:00:00Z`)) / 86_400_000);
}

function shortDay(day: string): string {
  return new Date(`${day}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

function longDay(day: string): string {
  return new Date(`${day}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
}

/**
 * Stays PropLane exports to Airbnb that Airbnb's feed does not carry back, once Airbnb has read the export (one poll)
 * and PropLane has synced Airbnb's feed since. A stay created after Airbnb's last read is simply not due yet.
 */
function echoItems(connections: readonly HealthConnection[], stays: readonly HealthStay[], today: string): ChannelAttentionItem[] {
  const items: ChannelAttentionItem[] = [];
  for (const connection of connections) {
    if (connection.provider !== "airbnb") continue;
    const fetched = ms(connection.exportLastFetchedAt);
    const synced = ms(connection.lastSyncedAt);
    if (!Number.isFinite(fetched) || !Number.isFinite(synced) || synced < fetched + ECHO_GRACE_MS) continue;
    const covering = coveringIntervals(connection.ranges.map((range) => ({ start: range.start, end: range.end || range.start })));
    for (const stay of stays) {
      if (stay.cancelled || stay.propertyId !== connection.propertyId) continue;
      if (stay.roomId && stay.roomId !== connection.roomId && stay.roomId !== stay.propertyId) continue;
      // A stay that IS an Airbnb / Booking.com import is not ours to echo.
      if (isImportedChannelBlock({ reason: stay.reason })) continue;
      const created = ms(stay.createdAt);
      if (!Number.isFinite(created) || created > fetched) continue;
      const last = lastNightOf(stay);
      if (last === null || last < today) continue;
      const gaps = uncovered({ start: stay.checkIn > today ? stay.checkIn : today, end: last }, covering);
      if (gaps.length === 0) continue;
      const first = gaps[0]!;
      items.push({
        id: `missing_echo:${connection.id}:${stay.id}`,
        kind: "missing_echo",
        propertyId: connection.propertyId,
        roomId: connection.roomId,
        text: `${housePrefix(connection.houseLabel)}${stay.roomLabel || connection.roomLabel}: ${stay.name.trim() || "A PropLane stay"} (${shortDay(first.start)}${first.end && first.end !== first.start ? ` – ${shortDay(first.end)}` : ""}) is not on ${channelName(connection.provider, connection.label)} yet`,
      });
    }
  }
  return items;
}

/** Manager closures with no end, or past {@link LONG_CLOSURE_NIGHTS} nights, that have started. A vacant room hidden this way earns nothing. */
function managerClosureItems(stays: readonly HealthStay[], today: string): ChannelAttentionItem[] {
  const items: ChannelAttentionItem[] = [];
  for (const stay of stays) {
    if (stay.cancelled || !stay.closed || isImportedChannelBlock({ reason: stay.reason })) continue;
    const last = lastNightOf(stay);
    if (stay.checkIn > today) continue;
    if (last !== null && (last < today || dayDiff(stay.checkIn, last) + 1 <= LONG_CLOSURE_NIGHTS)) continue;
    const where = `${housePrefix(stay.houseLabel)}${stay.roomLabel || "The whole home"}`;
    items.push({
      id: `manager_closure:${stay.id}`,
      kind: "manager_closure",
      propertyId: stay.propertyId,
      roomId: stay.roomId,
      text: last === null ? `${where} has been closed since ${shortDay(stay.checkIn)} with no end date` : `${where} is closed until ${longDay(nextDayKey(last))}`,
      action: { kind: "reopen", blockId: stay.id },
    });
  }
  return items;
}

/** A channel's own host block past {@link LONG_CLOSURE_NIGHTS} nights that covers today or lies ahead. */
function channelClosureItems(connections: readonly HealthConnection[], today: string): ChannelAttentionItem[] {
  const items: ChannelAttentionItem[] = [];
  for (const connection of connections) {
    for (const range of connection.ranges) {
      if (!isHostBlockRange({ hostBlock: range.hostBlock, summary: range.summary })) continue;
      const end = range.end || range.start;
      if (end < today || dayDiff(range.start, end) + 1 <= LONG_CLOSURE_NIGHTS) continue;
      items.push({
        id: `channel_closure:${connection.id}:${range.start}:${end}`,
        kind: "channel_closure",
        propertyId: connection.propertyId,
        roomId: connection.roomId,
        text: `${housePrefix(connection.houseLabel)}${connection.roomLabel} is closed on ${channelName(connection.provider, connection.label)} until ${longDay(nextDayKey(end))}`,
        action: { kind: "open_on_channel", provider: connection.provider },
      });
    }
  }
  return items;
}

/** An approved resident whose application never chose a room, in a house let by the room (the manager picks it). */
export type UnassignedApproval = { id: string; propertyId: string; houseLabel: string; name: string };

/**
 * The export holds no room for such a resident (it cannot tell which), so the nights stay open on every channel until
 * the manager assigns one. Said plainly, once per resident.
 */
function unassignedApprovalItems(approvals: readonly UnassignedApproval[]): ChannelAttentionItem[] {
  return approvals.map((approval) => {
    const first = approval.name.trim().split(/\s+/)[0] || "A resident";
    return {
      id: `unassigned_approval:${approval.id}`,
      kind: "unassigned_approval" as const,
      propertyId: approval.propertyId,
      roomId: "",
      text: `Approved application with no room assigned \u2014 ${first}, ${approval.houseLabel}`,
    };
  });
}

function addDays(day: string, days: number): string {
  return new Date(Date.parse(`${day}T12:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

/** The removed RESERVATIONS of a connection that are current or recently ended: the channel still lists them. */
function hiddenRemovedFor(connection: HealthConnection, removed: readonly ChannelStayTombstone[], today: string): ChannelStayTombstone[] {
  const since = addDays(today, -REMOVED_STAY_SURFACE_DAYS);
  return removed.filter(
    (t) =>
      !isHostBlockRange(t.range) &&
      tombstoneBelongsToConnection(t, { id: connection.id, property_id: connection.propertyId, room_id: connection.roomId, provider: connection.provider }) &&
      (t.range.end || t.range.start) >= since,
  );
}

/**
 * One row per linked room x platform. Pure; reads only what the Channels read already holds (the connection row, its
 * stored ranges and the removed-stay tombstones), so it costs no extra poll. `never` = linked and never read yet.
 */
export function buildSyncRows(input: {
  connections: readonly HealthConnection[];
  removed?: readonly ChannelStayTombstone[];
  now: Date;
  today: string;
  thresholdMs?: number;
}): ChannelSyncRow[] {
  const from = addDays(input.today, -SYNC_WINDOW_BACK_DAYS);
  const to = addDays(input.today, SYNC_WINDOW_AHEAD_DAYS);
  const rows: ChannelSyncRow[] = [];
  for (const connection of input.connections) {
    if (connection.hasImportUrl === false) continue;
    const importError = connection.lastError && !connection.lastError.startsWith(EXPORT_FEED_ERROR_PREFIX) ? connection.lastError : null;
    const synced = ms(connection.lastSyncedAt);
    const age = Number.isFinite(synced) ? input.now.getTime() - synced : NaN;
    const stays = connection.ranges.filter((range) => !isHostBlockRange(range) && (range.end || range.start) >= from && range.start <= to).length;
    const state: ChannelSyncRow["state"] = importError
      ? "error"
      : !Number.isFinite(synced)
        ? "never"
        : age > (input.thresholdMs ?? SYNC_STALE_AFTER_MS)
          ? "stale"
          : "ok";
    rows.push({
      connectionId: connection.id,
      propertyId: connection.propertyId,
      roomId: connection.roomId,
      houseLabel: connection.houseLabel ?? "",
      roomLabel: connection.roomLabel,
      provider: connection.provider,
      label: connection.label,
      lastSyncedAt: connection.lastSyncedAt,
      lastError: importError,
      staysInWindow: stays,
      hiddenRemoved: hiddenRemovedFor(connection, input.removed ?? [], input.today).length,
      state,
    });
  }
  return rows;
}

function syncItems(rows: readonly ChannelSyncRow[], now: Date): ChannelAttentionItem[] {
  const items: ChannelAttentionItem[] = [];
  for (const row of rows) {
    const place = `${housePrefix(row.houseLabel)}${channelName(row.provider, row.label)} \u00b7 ${row.roomLabel}`;
    if (row.state === "error") {
      items.push({ id: `sync_error:${row.connectionId}`, kind: "sync_error", propertyId: row.propertyId, roomId: row.roomId, text: `${place} could not be read: ${row.lastError}` });
    } else if (row.state === "stale") {
      items.push({ id: `sync_stale:${row.connectionId}`, kind: "sync_stale", propertyId: row.propertyId, roomId: row.roomId, text: `${place} was last read ${hoursText(now.getTime() - ms(row.lastSyncedAt))} ago` });
    }
    if (row.hiddenRemoved > 0) {
      items.push({
        id: `removed_stay_hidden:${row.connectionId}`,
        kind: "removed_stay_hidden",
        propertyId: row.propertyId,
        roomId: row.roomId,
        text: `${place}: ${row.hiddenRemoved} removed ${row.hiddenRemoved === 1 ? "stay is" : "stays are"} still on the channel and held back (restore from Removed stays)`,
      });
    }
  }
  return items;
}

/** Every finding, stalest feed first, then echoes, then closures. */
export function buildAttentionItems(input: {
  connections: readonly HealthConnection[];
  stays: readonly HealthStay[];
  now: Date;
  /** Pacific wall day, YYYY-MM-DD. */
  today: string;
  thresholdMs?: number;
  unassigned?: readonly UnassignedApproval[];
  /** Import sync rows (`buildSyncRows`); their failures and held-back removals join the list. */
  sync?: readonly ChannelSyncRow[];
}): ChannelAttentionItem[] {
  return [
    ...syncItems(input.sync ?? [], input.now),
    ...feedItems(input.connections, input.now, input.thresholdMs ?? FEED_STALE_AFTER_MS),
    ...echoItems(input.connections, input.stays, input.today),
    ...managerClosureItems(input.stays, input.today),
    ...channelClosureItems(input.connections, input.today),
    ...unassignedApprovalItems(input.unassigned ?? []),
  ];
}

export { channelName as healthChannelName };

/**
 * What Reopen saves for a manager closure: a closure that has started ends TODAY (check-out is exclusive, so the
 * room is open from today), and one that has not started yet is cancelled outright. Only the end changes, so the
 * block's name, kind and reason pass the server's name rule untouched.
 */
export function reopenClosureEdit(
  block: { checkIn: string; openEnded?: boolean },
  today: string,
): { bookingStatus: "cancelled" } | { openEnded: false; checkOut: string } {
  return block.checkIn >= today ? { bookingStatus: "cancelled" } : { openEnded: false, checkOut: today };
}
