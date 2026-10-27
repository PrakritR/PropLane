/**
 * "Does this PropLane stay land on nights a channel already holds?" - the pure half of the server's
 * overlap refusal (`channel-overlap.server.ts` reads the rows, the schedule-records route and the
 * assistant's block tools ask the question).
 *
 * The channel side is each room's imported ranges (Airbnb, Booking.com, ...) after tombstoned stays
 * are dropped. Two things on that side are NOT a clash:
 *   - the reservation this very stay is linked to (it is the stay, `ChannelLink`);
 *   - a host block ("Airbnb (Not available)") that PropLane's own stays explain: PropLane exports each
 *     stay to the channel as unavailable and the channel hands it back (`withoutEchoedHostBlocks`).
 * What is left of a host block after the echo is subtracted is the channel's own closure.
 */
import { channelCalendarProviderLabel } from "@/lib/channel-calendar/airbnb-url";
import {
  autoLinkForStay,
  linkTargetsRange,
  type ChannelLink,
  type LinkableRange,
} from "@/lib/channel-calendar/channel-link";
import { connectionTouchesRoom } from "@/lib/channel-calendar/export-feed";
import { isHostBlockRange, withoutEchoedHostBlocks } from "@/lib/channel-calendar/host-block";
import { bookingRangesOverlap, lastNightBeforeCheckout } from "@/lib/channel-calendar/property-bookings";

/** One imported range of one room, as the overlap check reads it. `start`/`end` are the first and LAST night. */
export type ChannelOverlapRange = Omit<LinkableRange, "provider"> & {
  provider: string;
  connectionId: string;
  /** The "Other calendar" site name. */
  label?: string | null;
  /** The name the manager gave the stay (`channel_stay_details`). */
  guestName?: string;
  /** "Room 8" - what the refusal calls the room. */
  roomLabel?: string;
};

/** A PropLane stay of the house, as far as the echo subtraction needs it. `checkOut` is exclusive. */
export type OverlapNativeStay = {
  id?: string;
  /** Who the stay is for (or its reason, for a closed room): what an alert calls it. */
  name?: string;
  reason?: string;
  roomId: string;
  checkIn: string;
  checkOut: string;
  openEnded?: boolean;
  cancelled?: boolean;
  /** The reservation this stay is explicitly linked to, if any. */
  link?: ChannelLink;
};

export type ChannelOverlapHit = {
  kind: "reservation" | "closed";
  range: ChannelOverlapRange;
  /** First and last night of the clashing part. */
  start: string;
  end: string;
  message: string;
};

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "Nov 12" from a YYYY-MM-DD key; the one date format every overlap refusal uses. */
export function monthDay(key: string): string {
  const [, month, day] = key.split("-").map(Number);
  return month && day ? `${MONTHS[month - 1]} ${day}` : key;
}

function nextDay(key: string): string {
  return new Date(Date.parse(`${key}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
}

export function channelClashMessage(hit: Pick<ChannelOverlapHit, "kind" | "range" | "start" | "end">): string {
  const room = hit.range.roomLabel?.trim() || "That room";
  const channel = channelCalendarProviderLabel(hit.range.provider as Parameters<typeof channelCalendarProviderLabel>[0], hit.range.label);
  const dates = `${monthDay(hit.start)} – ${monthDay(nextDay(hit.end))}`;
  if (hit.kind === "closed") return `${room} is closed on ${channel} ${dates}. Pick other dates or another room.`;
  const who = hit.range.guestName?.trim() || hit.range.reservationCode?.trim();
  return `${room} is booked ${dates} on ${channel}${who ? ` (${who})` : ""}. Pick other dates or another room.`;
}

/**
 * The reservation a stay being saved is linked to: its own link if some range really is that
 * reservation, else the one-time auto-link (HM code in its notes, or the same room and dates within a
 * night) against the reservations no other stay explicitly claimed.
 */
export function linkedRangeForStay(input: {
  propertyId: string;
  roomId: string;
  checkIn: string;
  checkOut: string;
  openEnded?: boolean;
  reason?: string | null;
  link?: ChannelLink;
  ranges: readonly ChannelOverlapRange[];
  /** Links other stays of the house already hold; their reservations are not available to auto-link. */
  otherLinks?: readonly ChannelLink[];
}): { link: ChannelLink | undefined; range: ChannelOverlapRange | undefined; verified: boolean; derived: boolean } {
  const reservations = input.ranges.filter((range) => !isHostBlockRange({ hostBlock: range.hostBlock, summary: range.summary }));
  if (input.link) {
    const range = reservations.find(
      (candidate) => (!input.roomId || candidate.roomId === input.roomId) && linkTargetsRange(input.link!, candidate),
    );
    return { link: input.link, range, verified: Boolean(range), derived: false };
  }
  const free = reservations.filter((range) => !(input.otherLinks ?? []).some((other) => linkTargetsRange(other, range)));
  const hit = autoLinkForStay(
    {
      propertyId: input.propertyId,
      roomId: input.roomId,
      start: input.checkIn,
      end: input.openEnded ? "9999-12-30" : lastNightBeforeCheckout(input.checkOut),
      openEnded: input.openEnded,
      reason: input.reason,
    },
    free.map((range) => ({ ...range, provider: range.provider as LinkableRange["provider"] })),
  );
  if (!hit) return { link: undefined, range: undefined, verified: false, derived: false };
  const range = free.find((candidate) => candidate.connectionId === (hit.range as ChannelOverlapRange).connectionId && candidate.sourceUid === hit.range.sourceUid && candidate.start === hit.range.start);
  return { link: hit.link, range, verified: true, derived: true };
}

/** The first clash between the nights `[checkIn, checkOut)` in `roomId` and what the channels hold, or null. */
export function findChannelOverlap(input: {
  propertyId: string;
  roomId: string;
  checkIn: string;
  checkOut: string;
  openEnded?: boolean;
  ranges: readonly ChannelOverlapRange[];
  /** Every PropLane stay of the house (this one's stored copy included): their echoes are not channel closures. */
  natives: readonly OverlapNativeStay[];
  /** The range this stay is (see `linkedRangeForStay`): never a clash with itself. */
  linked?: ChannelOverlapRange;
}): ChannelOverlapHit | null {
  const start = input.checkIn;
  const end = input.openEnded ? "9999-12-30" : lastNightBeforeCheckout(input.checkOut);
  if (!start || !end || end < start) return null;
  // A whole-home stay (no room id) holds every room, so every room's channel calendar is relevant to it.
  const relevant = input.ranges.filter((range) => !input.roomId || connectionTouchesRoom(range.roomId, input.roomId, input.propertyId));
  const sameRange = (a: ChannelOverlapRange, b: ChannelOverlapRange) => a.connectionId === b.connectionId && a.sourceUid === b.sourceUid && a.start === b.start && a.end === b.end;
  const reservations = relevant
    .filter((range) => !isHostBlockRange({ hostBlock: range.hostBlock, summary: range.summary }))
    .filter((range) => !(input.linked && sameRange(range, input.linked)))
    .filter((range) => bookingRangesOverlap({ start: range.start, end: range.end }, { start, end }))
    .sort((a, b) => a.start.localeCompare(b.start));
  const first = reservations[0];
  if (first) {
    const hit = { kind: "reservation" as const, range: first, start: first.start > start ? first.start : start, end: first.end < end ? first.end : end };
    return { ...hit, message: channelClashMessage(hit) };
  }
  // Host blocks: subtract everything PropLane itself exports to that room.
  const locals = input.natives
    .filter((native) => !native.cancelled)
    .map((native) => ({
      source: "block",
      propertyId: input.propertyId,
      roomId: native.roomId,
      start: native.checkIn,
      end: native.openEnded ? "9999-12-30" : lastNightBeforeCheckout(native.checkOut),
      openEnded: native.openEnded,
    }));
  const hostBlocks = relevant
    .filter((range) => isHostBlockRange({ hostBlock: range.hostBlock, summary: range.summary }))
    .map((range) => ({ source: range.provider, propertyId: input.propertyId, roomId: range.roomId, start: range.start, end: range.end, hostBlock: true, summary: range.summary ?? "Not available", range }));
  const remainders = withoutEchoedHostBlocks([...locals, ...hostBlocks]).filter(
    (entry): entry is typeof hostBlocks[number] => "range" in entry && entry.source !== "block",
  );
  for (const piece of remainders.sort((a, b) => a.start.localeCompare(b.start))) {
    if (!bookingRangesOverlap({ start: piece.start, end: piece.end }, { start, end })) continue;
    const hit = { kind: "closed" as const, range: piece.range, start: piece.start > start ? piece.start : start, end: piece.end < end ? piece.end : end };
    return { ...hit, message: channelClashMessage(hit) };
  }
  return null;
}

/** A double booking between two things that hold one room on the same nights. */
export type ChannelClash = {
  /** Stable across syncs and across which connection's sync found it: the alert's idempotency key. */
  key: string;
  propertyId: string;
  roomId: string;
  roomLabel: string;
  /** First and last night both hold. */
  start: string;
  end: string;
  sides: Array<{ kind: "channel"; label: string; range: ChannelOverlapRange } | { kind: "native"; label: string; id: string }>;
};

function sideId(side: ChannelClash["sides"][number]): string {
  return side.kind === "channel" ? `${side.range.connectionId}/${side.range.sourceUid ?? ""}/${side.range.start}` : `block/${side.id}`;
}

function channelSide(range: ChannelOverlapRange): ChannelClash["sides"][number] {
  return { kind: "channel", label: channelCalendarProviderLabel(range.provider as Parameters<typeof channelCalendarProviderLabel>[0], range.label), range };
}

/**
 * Every double booking among a house's real reservations and PropLane stays, found after a sync:
 *   - two channels holding the same room on the same nights (Airbnb and Booking.com both sold it);
 *   - a channel reservation on nights a PropLane stay holds, unless that stay IS the reservation (linked).
 * A host block is never a side: it is a closure, not a booking. `connectionId` limits the answer to clashes
 * the syncing connection is part of, and `today` drops clashes that are already over.
 */
export function findChannelClashes(input: {
  propertyId: string;
  ranges: readonly ChannelOverlapRange[];
  natives: ReadonlyArray<OverlapNativeStay & { id: string }>;
  connectionId?: string;
  today?: string;
}): ChannelClash[] {
  const { propertyId } = input;
  const reservations = input.ranges.filter((range) => !isHostBlockRange({ hostBlock: range.hostBlock, summary: range.summary }));
  const out = new Map<string, ChannelClash>();
  const add = (sides: ChannelClash["sides"], roomId: string, roomLabel: string, a: { start: string; end: string }, b: { start: string; end: string }) => {
    const start = a.start > b.start ? a.start : b.start;
    const end = a.end < b.end ? a.end : b.end;
    if (end < start || (input.today && end < input.today)) return;
    const key = `clash:${propertyId}:${[...sides.map(sideId)].sort().join("|")}:${start}:${end}`;
    if (!out.has(key)) out.set(key, { key, propertyId, roomId, roomLabel, start, end, sides });
  };
  const touches = (a: string, b: string) => !a || !b || a === b || a === propertyId || b === propertyId;
  for (let i = 0; i < reservations.length; i += 1) {
    for (let j = i + 1; j < reservations.length; j += 1) {
      const a = reservations[i]!;
      const b = reservations[j]!;
      if (a.connectionId === b.connectionId) continue;
      if (input.connectionId && a.connectionId !== input.connectionId && b.connectionId !== input.connectionId) continue;
      if (!touches(a.roomId, b.roomId) || !bookingRangesOverlap(a, b)) continue;
      const narrower = a.roomId === propertyId ? b : a;
      add([channelSide(a), channelSide(b)], narrower.roomId, narrower.roomLabel?.trim() || "That room", a, b);
    }
  }
  const links = input.natives.filter((native) => native.link && !native.cancelled).map((native) => native.link!);
  for (const native of input.natives) {
    if (native.cancelled || !native.checkIn || !native.checkOut) continue;
    // A channel import mirrored into a block is the channel's own stay, never a PropLane one.
    if (/^(airbnb|booking)$/i.test((native.reason ?? "").trim())) continue;
    const nights = { start: native.checkIn, end: native.openEnded ? "9999-12-30" : lastNightBeforeCheckout(native.checkOut) };
    const own = linkedRangeForStay({
      propertyId,
      roomId: native.roomId,
      checkIn: native.checkIn,
      checkOut: native.checkOut,
      openEnded: native.openEnded,
      reason: native.reason,
      link: native.link,
      ranges: reservations,
      otherLinks: links.filter((link) => link !== native.link),
    }).range;
    for (const range of reservations) {
      if (input.connectionId && range.connectionId !== input.connectionId) continue;
      if (own && range.connectionId === own.connectionId && range.sourceUid === own.sourceUid && range.start === own.start) continue;
      if (!touches(native.roomId, range.roomId) || !bookingRangesOverlap(nights, range)) continue;
      add([channelSide(range), { kind: "native", label: native.name?.trim() || native.reason?.trim() || "a PropLane booking", id: native.id }], native.roomId || range.roomId, range.roomLabel?.trim() || "That room", nights, range);
    }
  }
  return [...out.values()].sort((a, b) => a.start.localeCompare(b.start) || a.key.localeCompare(b.key));
}

/** "Room 8 is double-booked Oct 29 – Nov 1 (Airbnb and Booking.com)". */
export function channelClashText(clash: Pick<ChannelClash, "roomLabel" | "start" | "end" | "sides">): string {
  const names = clash.sides.map((side) => (side.kind === "channel" ? side.label : "PropLane"));
  const unique = [...new Set(names)];
  const who = unique.length === 1 ? `two ${unique[0]} stays` : unique.join(" and ");
  return `${clash.roomLabel} is double-booked ${monthDay(clash.start)} – ${monthDay(nextDay(clash.end))} (${who})`;
}
