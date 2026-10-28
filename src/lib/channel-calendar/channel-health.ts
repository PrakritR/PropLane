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
import { coveringIntervals, nextDayKey, previousDayKey, uncovered } from "@/lib/room-occupancy-rule";

/** Decision D2: a channel that has not fetched the export for this long is stale. Airbnb polls every few hours. */
export const FEED_STALE_AFTER_HOURS = 6;
export const FEED_STALE_AFTER_MS = FEED_STALE_AFTER_HOURS * 60 * 60_000;
/** After Airbnb fetches our feed it needs a moment before its own feed carries what it read; sync after this much counts as a poll. */
export const ECHO_GRACE_MS = 30 * 60_000;
/** A closure longer than this many nights is a standing closure, not a stay. */
export const LONG_CLOSURE_NIGHTS = 60;
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
  provider: ChannelCalendarProvider;
  label: string | null;
  lastSyncedAt: string | null;
  lastError: string | null;
  exportLastFetchedAt: string | null;
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
  kind: "stale_feed" | "feed_error" | "missing_echo" | "manager_closure" | "channel_closure";
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

export type ChannelHealth = { houses: ChannelHealthHouse[]; items: ChannelAttentionItem[] };

function ms(iso: string | null | undefined): number {
  const value = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(value) ? value : NaN;
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
    const place = `${channelName(connection.provider, connection.label)} · ${connection.roomLabel}`;
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
        text: `${stay.roomLabel || connection.roomLabel}: ${stay.name.trim() || "A PropLane stay"} (${shortDay(first.start)}${first.end && first.end !== first.start ? ` – ${shortDay(first.end)}` : ""}) is not on ${channelName(connection.provider, connection.label)} yet`,
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
    const where = stay.roomLabel || "The whole home";
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
        text: `${connection.roomLabel} is closed on ${channelName(connection.provider, connection.label)} until ${longDay(nextDayKey(end))}`,
        action: { kind: "open_on_channel", provider: connection.provider },
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
}): ChannelAttentionItem[] {
  return [
    ...feedItems(input.connections, input.now, input.thresholdMs ?? FEED_STALE_AFTER_MS),
    ...echoItems(input.connections, input.stays, input.today),
    ...managerClosureItems(input.stays, input.today),
    ...channelClosureItems(input.connections, input.today),
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
