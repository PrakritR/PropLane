/**
 * Which channel reservation a PropLane stay IS.
 *
 * A manager often types an Airbnb / Booking.com booking into PropLane by hand ("Airbnb HMRRN4XTZ8"),
 * so the same guest exists twice: once as the typed stay, once as the channel's own imported range.
 * `stayDetails.channelLink {provider, reservationCode?, sourceUid?}` says they are one reservation.
 * A linked stay is drawn once, in the channel's colour with the name the manager typed, and it always
 * covers its channel copy (the copy stays in `entries` for the record page and payouts; the calendar,
 * the occupancy count and the server overlap check treat it as the same stay).
 *
 * Pure on purpose: the Bookings hook, the occupancy snapshot (client and server) and the schedule
 * route all read the same two answers, `resolveChannelLinks` and `autoLinkForStay`.
 */
import { isHostBlockRange } from "@/lib/channel-calendar/host-block";
import { isReservationCode } from "@/lib/channel-calendar/reservation-details";

export const CHANNEL_LINK_PROVIDERS = ["airbnb", "booking_com"] as const;
export type ChannelLinkProvider = (typeof CHANNEL_LINK_PROVIDERS)[number];

export type ChannelLink = {
  provider: ChannelLinkProvider;
  /** Airbnb's HM… code. Booking.com's feed carries none. */
  reservationCode?: string;
  /** The feed's own event UID: the only stable identity a Booking.com reservation has. */
  sourceUid?: string;
};

export const CHANNEL_LINK_PROVIDER_LABELS: Record<ChannelLinkProvider, string> = { airbnb: "Airbnb", booking_com: "Booking.com" };

const SOURCE_UID_MAX = 200;
const HM_CODE = /\bHM[A-Z0-9]{6,12}\b/i;
/** Check-in and check-out may each be off by this many nights and still be "the same stay". */
export const AUTO_LINK_DATE_TOLERANCE_NIGHTS = 1;

/** The Source dropdown's value for a booking made on PadSplit (no calendar feed or API: the stay is typed in). */
export const PADSPLIT_SOURCE = "PadSplit";

/** The Source dropdown of the Add and Edit booking sheets, in order. */
export const STAY_SOURCE_OPTIONS: readonly string[] = ["Direct", "Tenant", "Airbnb", "Booking.com", PADSPLIT_SOURCE, "Application", "Other"];

/** The Source dropdown's value for a channel that can be linked, else null. */
export function channelLinkProviderForSource(source: unknown): ChannelLinkProvider | null {
  const value = typeof source === "string" ? source.trim().toLowerCase() : "";
  if (value === "airbnb") return "airbnb";
  if (value === "booking.com" || value === "booking_com") return "booking_com";
  return null;
}

/** A stored or posted link, cleaned. Anything that names no reservation is no link. */
export function normalizeChannelLink(raw: unknown): ChannelLink | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const value = raw as Record<string, unknown>;
  const provider = CHANNEL_LINK_PROVIDERS.find((candidate) => candidate === value.provider);
  if (!provider) return undefined;
  const code = typeof value.reservationCode === "string" ? value.reservationCode.trim().toUpperCase() : "";
  const uid = typeof value.sourceUid === "string" ? value.sourceUid.trim() : "";
  const link: ChannelLink = { provider };
  if (provider === "airbnb" && isReservationCode(code)) link.reservationCode = code;
  if (uid && uid.length <= SOURCE_UID_MAX) link.sourceUid = uid;
  return link.reservationCode || link.sourceUid ? link : undefined;
}

/** The Airbnb reservation code written into free text ("Airbnb HMRRN4XTZ8 - Kumaran"), if any. */
export function hmCodeFromText(...texts: Array<string | null | undefined>): string | null {
  for (const text of texts) {
    const found = HM_CODE.exec(text ?? "")?.[0]?.toUpperCase();
    if (found && isReservationCode(found)) return found;
  }
  return null;
}

/** True for a provider whose reservations a PropLane stay can link to (Airbnb, Booking.com). */
export function isChannelLinkProvider(provider: unknown): provider is ChannelLinkProvider {
  return CHANNEL_LINK_PROVIDERS.some((candidate) => candidate === provider);
}

/**
 * The ONE rule for "may this PropLane stay be auto-linked to a channel reservation": the read-time
 * resolver, the server derive on save, the assistant's block tools and the clash finder all ask it.
 * Only a stay that is not cancelled, not a closed room, and names its guest (or carries an explicit
 * Airbnb HM code in its notes) links. A closure or a nameless hold never does: linking would let it
 * cover the real guest of the reservation on the same nights.
 */
export function stayMayAutoLink(stay: { residentName?: string | null; blockKind?: string | null; closed?: boolean; cancelled?: boolean; reason?: string | null }): boolean {
  if (stay.cancelled || stay.closed || stay.blockKind === "closed") return false;
  return Boolean(stay.residentName?.trim() || hmCodeFromText(stay.reason));
}

/** A channel reservation as the linker sees it. `start`/`end` are the first and LAST night, inclusive. */
export type LinkableRange = {
  provider: ChannelLinkProvider;
  propertyId: string;
  roomId: string;
  sourceUid?: string;
  reservationCode?: string;
  start: string;
  end: string;
  hostBlock?: boolean;
  summary?: string | null;
};

/** True when the link names this range. Provider must match; then the code, else the feed UID. */
export function linkTargetsRange(
  link: ChannelLink,
  range: { provider: string; sourceUid?: string | null; reservationCode?: string | null },
): boolean {
  if (range.provider !== link.provider) return false;
  if (link.reservationCode && range.reservationCode && link.reservationCode === range.reservationCode) return true;
  return Boolean(link.sourceUid && range.sourceUid && link.sourceUid === range.sourceUid);
}

/** The link that points at `range` (its code for Airbnb, its UID always). */
export function linkForRange(range: Pick<LinkableRange, "provider" | "sourceUid" | "reservationCode">): ChannelLink {
  return {
    provider: range.provider,
    ...(range.provider === "airbnb" && range.reservationCode && isReservationCode(range.reservationCode) ? { reservationCode: range.reservationCode } : {}),
    ...(range.sourceUid ? { sourceUid: range.sourceUid } : {}),
  };
}

function dayNumber(key: string): number {
  return Math.round(Date.parse(`${key}T00:00:00Z`) / 86_400_000);
}

function nightsApart(a: string, b: string): number {
  return Math.abs(dayNumber(a) - dayNumber(b));
}

function isReservation(range: LinkableRange): boolean {
  return !isHostBlockRange({ hostBlock: range.hostBlock, summary: range.summary }) && Boolean(range.reservationCode || range.sourceUid);
}

export type LinkableStay = {
  propertyId: string;
  /** "" = the whole home: only an HM code in its notes can link it. */
  roomId: string;
  start: string;
  end: string;
  openEnded?: boolean;
  /** The Notes / reason text the manager typed ("Airbnb HMRRN4XTZ8"). */
  reason?: string | null;
};

/**
 * The one-time auto-link: the reservation a hand-typed stay is, or null.
 *   1. an HM code in the stay's notes that is EXACTLY one reservation's code in this house (and room);
 *   2. else exactly one reservation in the same room whose check-in and check-out are each within a
 *      night of the stay's.
 * Two candidates are ambiguous, and ambiguous means no link: a wrong join is worse than none.
 */
export function autoLinkForStay(stay: LinkableStay, ranges: readonly LinkableRange[]): { link: ChannelLink; range: LinkableRange } | null {
  const inHouse = ranges.filter((range) => range.propertyId === stay.propertyId && isReservation(range) && (!stay.roomId || range.roomId === stay.roomId));
  const code = hmCodeFromText(stay.reason);
  if (code) {
    const byCode = inHouse.filter((range) => range.reservationCode === code);
    if (byCode.length === 1) return { link: linkForRange(byCode[0]!), range: byCode[0]! };
    if (byCode.length > 1) return null;
  }
  if (!stay.roomId || stay.openEnded) return null;
  const byDates = inHouse.filter(
    (range) => nightsApart(range.start, stay.start) <= AUTO_LINK_DATE_TOLERANCE_NIGHTS && nightsApart(range.end, stay.end) <= AUTO_LINK_DATE_TOLERANCE_NIGHTS,
  );
  return byDates.length === 1 ? { link: linkForRange(byDates[0]!), range: byDates[0]! } : null;
}

/** Whatever carries the fields of a Bookings entry that linking reads (a `PropertyBookingEntry` is one). */
export type LinkEntry = {
  source: string;
  propertyId: string;
  roomId: string;
  start: string;
  end: string;
  openEnded?: boolean;
  bookingStatus?: string;
  summary?: string | null;
  reason?: string;
  residentName?: string;
  blockKind?: string;
  blockId?: string;
  connectionId?: string;
  sourceUid?: string;
  reservationCode?: string;
  stayDetails?: { channelLink?: unknown } | undefined;
};

/** The identity under which a covered channel stay is dropped from the calendar. */
export function channelStayCoverKey(entry: Pick<LinkEntry, "connectionId" | "sourceUid" | "start" | "end">): string {
  return `${entry.connectionId ?? ""}\0${entry.sourceUid ?? ""}\0${entry.start}\0${entry.end}`;
}

export type ResolvedChannelLinks = {
  /** blockId -> the stay's link (its own, else the auto-linked one). */
  links: Map<string, ChannelLink>;
  /** The blockIds whose link was derived rather than stored. */
  derived: Set<string>;
  /** Channel stays a linked stay covers (see `channelStayCoverKey`) -> the covering stay's blockId. */
  covered: Map<string, string>;
};

const NO_LINKS: ResolvedChannelLinks = { links: new Map(), derived: new Set(), covered: new Map() };

function isLinkableChannelEntry(entry: LinkEntry): boolean {
  return (entry.source === "airbnb" || entry.source === "booking_com") && entry.bookingStatus !== "cancelled";
}

function toRange(entry: LinkEntry): LinkableRange {
  return {
    provider: entry.source as ChannelLinkProvider,
    propertyId: entry.propertyId,
    roomId: entry.roomId,
    sourceUid: entry.sourceUid,
    reservationCode: entry.reservationCode,
    start: entry.start,
    end: entry.end,
    summary: entry.summary,
  };
}

/**
 * Pairs every PropLane stay with the channel reservation it is. Explicit links (`stayDetails.channelLink`)
 * are honoured first; a stay without one is auto-linked (`autoLinkForStay`) against the reservations no
 * explicit link already took, and a reservation two stays both claim is claimed by neither.
 * Nothing is stored: this is a read-time answer over the entry list.
 */
export function resolveChannelLinks(entries: readonly LinkEntry[]): ResolvedChannelLinks {
  const natives: LinkEntry[] = [];
  const channel: LinkEntry[] = [];
  for (const entry of entries) {
    if (entry.source === "block" && entry.blockId && entry.bookingStatus !== "cancelled") natives.push(entry);
    else if (isLinkableChannelEntry(entry)) channel.push(entry);
  }
  if (natives.length === 0 || channel.length === 0) {
    // A stored link still marks its stay even when its reservation has left the feed.
    const links = new Map<string, ChannelLink>();
    for (const native of natives) {
      const own = normalizeChannelLink(native.stayDetails?.channelLink);
      if (own) links.set(native.blockId!, own);
    }
    return links.size === 0 ? NO_LINKS : { links, derived: new Set(), covered: new Map() };
  }
  const reservations = channel.filter((entry) => isReservation(toRange(entry)));
  const links = new Map<string, ChannelLink>();
  const derived = new Set<string>();
  const covered = new Map<string, string>();
  const unlinked: LinkEntry[] = [];
  for (const native of natives) {
    const own = normalizeChannelLink(native.stayDetails?.channelLink);
    if (!own) {
      // Same eligibility as the server derive (`stayMayAutoLink`): closures and nameless holds never link.
      if (stayMayAutoLink({ residentName: native.residentName, blockKind: native.blockKind, cancelled: native.bookingStatus === "cancelled", reason: native.reason })) unlinked.push(native);
      continue;
    }
    links.set(native.blockId!, own);
    for (const entry of reservations) {
      if (entry.propertyId !== native.propertyId || (native.roomId && entry.roomId !== native.roomId)) continue;
      if (linkTargetsRange(own, { provider: entry.source, sourceUid: entry.sourceUid, reservationCode: entry.reservationCode })) covered.set(channelStayCoverKey(entry), native.blockId!);
    }
  }
  const free = reservations.filter((entry) => !covered.has(channelStayCoverKey(entry)));
  const freeRanges = free.map(toRange);
  const claims = new Map<LinkableRange, Array<{ native: LinkEntry; link: ChannelLink }>>();
  for (const native of unlinked) {
    const hit = autoLinkForStay(
      { propertyId: native.propertyId, roomId: native.roomId, start: native.start, end: native.end, openEnded: native.openEnded, reason: native.reason },
      freeRanges,
    );
    if (!hit) continue;
    const list = claims.get(hit.range) ?? [];
    list.push({ native, link: hit.link });
    claims.set(hit.range, list);
  }
  freeRanges.forEach((range, index) => {
    const list = claims.get(range);
    if (!list || list.length !== 1) return;
    const { native, link } = list[0]!;
    if (links.has(native.blockId!)) return;
    links.set(native.blockId!, link);
    derived.add(native.blockId!);
    covered.set(channelStayCoverKey(free[index]!), native.blockId!);
  });
  return { links, derived, covered };
}

/**
 * The entry list with the links applied: a linked stay carries `channelLink` (so it draws in the
 * channel's colour with a channel mark) and the channel copy it covers takes the stay's name when it
 * has none of its own, so the record page of either one says who the guest is.
 */
export function withLinkedChannelStays<T extends LinkEntry & { channelLink?: ChannelLink; guestName?: string; residentName?: string }>(entries: readonly T[]): T[] {
  const resolved = resolveChannelLinks(entries);
  if (resolved.links.size === 0) return [...entries];
  const nameByBlock = new Map<string, string>();
  for (const entry of entries) if (entry.blockId && entry.residentName?.trim()) nameByBlock.set(entry.blockId, entry.residentName.trim());
  return entries.map((entry) => {
    if (entry.source === "block" && entry.blockId) {
      const link = resolved.links.get(entry.blockId);
      return link ? { ...entry, channelLink: link } : entry;
    }
    const coverer = resolved.covered.get(channelStayCoverKey(entry));
    const name = coverer ? nameByBlock.get(coverer) : undefined;
    return name && !entry.guestName?.trim() ? { ...entry, guestName: name } : entry;
  });
}

/** Drops the channel stays a linked stay covers. Calendar-only, like `withoutChannelStaysCoveredByResidents`. */
export function withoutChannelStaysCoveredByLinks<T extends LinkEntry>(entries: readonly T[]): T[] {
  const { covered } = resolveChannelLinks(entries);
  if (covered.size === 0) return [...entries];
  return entries.filter((entry) => !(isLinkableChannelEntry(entry) && covered.has(channelStayCoverKey(entry))));
}

/**
 * The reservations a stay in `roomId` of `propertyId` could be linked to, closest dates first.
 * Host blocks and reservations the manager removed (they are not in the list) never appear.
 */
export function reservationOptionsForStay<T extends LinkEntry>(
  entries: readonly T[],
  stay: { provider: ChannelLinkProvider; propertyId: string; roomId: string; start: string; end: string },
): T[] {
  return entries
    .filter(
      (entry) =>
        entry.source === stay.provider &&
        entry.bookingStatus !== "cancelled" &&
        entry.propertyId === stay.propertyId &&
        (!stay.roomId || entry.roomId === stay.roomId) &&
        isReservation(toRange(entry)),
    )
    .map((entry) => ({ entry, distance: nightsApart(entry.start, stay.start) + nightsApart(entry.end, stay.end) }))
    .sort((a, b) => a.distance - b.distance || a.entry.start.localeCompare(b.entry.start))
    .map((item) => item.entry);
}

/**
 * `details` with the resolved link filled in, so a sheet opened on a stay that was only auto-linked
 * shows (and, on the manager's next Save, stores) the link. A Source that says nothing yet
 * ("Direct" / "Other" / empty) takes the channel's name, because the stay IS that channel's booking.
 */
export function stayDetailsWithLink<D extends { source?: string; channelLink?: ChannelLink }>(details: D | undefined, resolved: ChannelLink | undefined): D {
  const base = (details ?? {}) as D;
  if (!resolved) return base;
  const source = (base.source ?? "").trim();
  const sayNothing = !source || source === "Direct" || source === "Other";
  return { ...base, channelLink: resolved, ...(sayNothing ? { source: CHANNEL_LINK_PROVIDER_LABELS[resolved.provider] } : {}) };
}

/** The sheet's next details after the Source dropdown moved: a link to another channel (or none) is dropped. */
export function stayDetailsWithSource<D extends { source?: string; channelLink?: ChannelLink }>(details: D, source: string): D {
  const provider = channelLinkProviderForSource(source);
  const { channelLink, ...rest } = details;
  const keep = provider && channelLink?.provider === provider;
  return { ...rest, source, ...(keep ? { channelLink } : {}) } as D;
}

/** The entries minus the one reservation the stay being saved IS: it is never a clash with itself. */
export function withoutLinkedReservation<T extends LinkEntry>(entries: readonly T[], link: ChannelLink | undefined): T[] {
  if (!link) return [...entries];
  return entries.filter(
    (entry) => !(isLinkableChannelEntry(entry) && linkTargetsRange(link, { provider: entry.source, sourceUid: entry.sourceUid, reservationCode: entry.reservationCode })),
  );
}
