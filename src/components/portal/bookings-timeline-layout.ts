import { LONG_CLOSURE_NIGHTS } from "@/lib/channel-calendar/channel-health";
import { bookingActiveOn, bookingCheckout, calendarOccupancy, calendarRange, type BookingCalendarView } from "@/lib/channel-calendar/bookings-calendar-view";
import { addDaysToDateKey, bookingEntryMatchesSearch } from "@/lib/channel-calendar/bookings-ui";
import { entryTimedStay, formatGapDuration, type EntryStayTimes } from "@/components/portal/bookings-stay-times";
import { DEFAULT_PROPERTY_STAY_TIMES, formatStayTime, halfDayBarSpan, stayEndWall, stayStartWall, staysOverlap, stayTimeMinutes, type PropertyStayTimes, type TimedStay } from "@/lib/bookings/stay-times";
import { isAvailabilityBlockRow } from "@/lib/occupancy/snapshot";
import { isHostBlockSummary } from "@/lib/channel-calendar/host-block";
import { bookingSourceLabel } from "@/lib/channel-calendar/bookings-ui";
import { bookingEntryNamedLabel } from "@/lib/channel-calendar/booking-guest-label";
import { isChannelBookingSource, type PropertyBookingEntry } from "@/lib/channel-calendar/property-bookings";
import type { OccupancyCapacities } from "@/lib/occupancy/snapshot";

/**
 * Pure geometry and row-model helpers for the Bookings timeline. Nothing here touches React or the listing
 * store, so the windowing, the search narrowing and the narrow-bar rule are unit-tested directly.
 */

/** One lane is a 44px touch target; the visible bar inside it is 32px. */
export const LANE_PITCH = 44;
export const BAR_VISUAL_HEIGHT = 32;
/** A room row is never shorter than this, even empty. */
export const ROOM_ROW_MIN_HEIGHT = 52;
export const HOUSE_ROW_HEIGHT = 56;
/** Below this many px a bar draws no name; it shows its source glyph (from `NARROW_GLYPH_PX`) or nothing. Text never leaves the bar. */
export const NARROW_BAR_PX = 56;
/** A narrow bar at least this wide shows its source glyph, centred. */
export const NARROW_GLYPH_PX = 20;
/** Rows are windowed only from this many on, so a small portfolio always renders every row. */
export const WINDOW_MIN_ROWS = 60;
/** Rows kept rendered beyond the viewport on each side, in px. */
export const WINDOW_BUFFER_PX = 600;
/** The sticky day header's height; the body starts below it. */
export const HEADER_HEIGHT = 56;

export const labelWidthPx = (phone: boolean) => (phone ? 120 : 208);

// Floors, in px. Week is 28 (not 40): seven columns plus the 120px phone label must fit a 390px phone (a 330px
// card in the portal) with no sideways scroll. Month on a desktop is 26 so a full month fits beside the sidebar.
const MIN_COLUMN_PX = { week: 28, month: 36, monthWide: 26, year: 56, day: 240 } as const;

/**
 * One column's width in px. A measured track divides evenly across the days when that is wider than the
 * floor (so Week fits a 390px phone with no horizontal scroll); otherwise the floor wins and the grid scrolls.
 * With no measurement (jsdom, first paint) the track is treated as exactly the floor.
 */
export function columnPx(view: BookingCalendarView, dayCount: number, trackWidth: number, phone: boolean): number {
  if (view === "day") return trackWidth > 0 ? trackWidth : 320;
  const floor = view === "week" ? MIN_COLUMN_PX.week : view === "year" ? MIN_COLUMN_PX.year : phone ? MIN_COLUMN_PX.month : MIN_COLUMN_PX.monthWide;
  return trackWidth > 0 ? Math.max(floor, trackWidth / Math.max(1, dayCount)) : floor;
}

export const dayDiff = (a: string, b: string) => Math.round((Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86400000);

export type TimelineRoom = { id: string; label: string; rent: string };

/** `start` / `end` are fractional day-cell offsets from the range's first day: a check-in at or after noon starts mid-cell. */
export type PlacedBarSpec = { entry: PropertyBookingEntry; key: string; lane: number; start: number; end: number; conflict: boolean; times?: EntryStayTimes };

/**
 * The gap between one guest checking out and the next checking in on a room. `start` / `end` are the same
 * fractional day offsets as a bar (the strip runs from the bar's right edge to the next bar's left edge), `lane`
 * the checking-out bar's lane. `short` = the next guest arrives before the property's cleaning buffer is up.
 */
export type TurnoverSpec = {
  key: string;
  entry: PropertyBookingEntry;
  next: PropertyBookingEntry | null;
  lane: number;
  start: number;
  end: number;
  short: boolean;
  /** Minutes from checkout to the next check-in; null when no guest follows within a day. */
  gapMinutes: number | null;
  bufferMinutes: number;
  outTime: string;
  /** "HH:MM" the cleaning window ends: the next check-in, else checkout + buffer. */
  endTime: string;
};

export type RoomLayout = {
  room: TimelineRoom;
  all: PropertyBookingEntry[];
  /** Per day index: any stay at all holds the room (a search never frees a night a hidden stay holds). */
  busy: boolean[];
  bars: PlacedBarSpec[];
  /** Cleaning gaps between consecutive guests; the render draws one when a cleaning job exists or the gap is short. */
  turnovers: TurnoverSpec[];
  /** Day view only: the stays active (or leaving) on the anchor day. */
  dayEntries: PropertyBookingEntry[];
  monthPercents: number[];
  height: number;
};

export function roomRowHeight(laneCount: number): number {
  return Math.max(ROOM_ROW_MIN_HEIGHT, laneCount * LANE_PITCH + 8);
}

/**
 * One room's bars, in day units (the pixel geometry is applied at render, from the measured column width).
 * Called only for a house that is expanded: a collapsed house never lays out a room.
 */
export function layoutRoom(args: {
  room: TimelineRoom;
  /** Every stay of the room: capacity, conflicts and which nights are free read this. */
  all: PropertyBookingEntry[];
  /** The stays to draw when a search narrows the room; defaults to `all`. */
  shown?: PropertyBookingEntry[];
  view: BookingCalendarView;
  days: string[];
  anchor: string;
  propertyId: string;
  capacities: OccupancyCapacities;
  entryKey: (entry: PropertyBookingEntry) => string;
  /** The property's stay-time defaults (check-in, check-out, cleaning buffer); the 3 pm / 11 am / 3 h defaults when absent. */
  times?: PropertyStayTimes;
}): RoomLayout {
  const { room, all, view, days, anchor, propertyId, capacities, entryKey } = args;
  const property = args.times ?? DEFAULT_PROPERTY_STAY_TIMES;
  const shown = args.shown ?? all;
  const capacity = capacities.roomCapacity(propertyId, room.id);
  if (view === "year") {
    const monthPercents = days.map(month => calendarOccupancy(all, calendarRange("month", month), propertyId, { bedsTotal: () => capacity, roomCapacity: () => capacity }));
    return { room, all, busy: [], bars: [], turnovers: [], dayEntries: [], monthPercents, height: ROOM_ROW_MIN_HEIGHT };
  }
  if (view === "day") {
    const dayEntries = shown.filter(entry => bookingActiveOn(entry, anchor) || bookingCheckout(entry) === anchor);
    return { room, all, busy: [], bars: [], turnovers: [], dayEntries, monthPercents: [], height: 64 };
  }
  const firstDay = days[0]!, lastDay = days.at(-1)!;
  // A stay that checks out on the first day still draws its morning half; one that checks in on the last day, its afternoon half.
  const inRange = (entry: PropertyBookingEntry) => entry.start <= lastDay && (entry.openEnded || bookingCheckout(entry)! >= firstDay);
  const busy = new Array<boolean>(days.length).fill(false);
  for (const entry of all) {
    if (!inRange(entry)) continue;
    const from = Math.max(0, dayDiff(entry.start, firstDay));
    const to = entry.openEnded ? days.length : Math.min(days.length, dayDiff(bookingCheckout(entry)!, firstDay));
    for (let index = from; index < to; index++) busy[index] = true;
  }
  // Every stay of the room on its resolved wall times: lanes, conflicts and turnovers read the same intervals.
  const timedByEntry = new Map<PropertyBookingEntry, TimedStay>();
  all.forEach((entry, index) => timedByEntry.set(entry, entryTimedStay(entry, String(index), property)));
  const timedOf = (entry: PropertyBookingEntry) => timedByEntry.get(entry) ?? entryTimedStay(entry, `x:${entryKey(entry)}`, property);
  const visible = shown.filter(inRange).map(entry => ({ entry, timed: timedOf(entry) }));
  const laned = timedLanes(visible);
  // A room can only be overbooked when it holds more stays than beds; skip the overlap scan otherwise.
  const mayConflict = all.length > capacity;
  const timedAll = mayConflict ? [...timedByEntry.values()] : [];
  const bars: PlacedBarSpec[] = laned.map(({ entry, timed, lane }) => {
    const span = halfDayBarSpan(timed, firstDay);
    const start = Math.max(0, span.start);
    const end = entry.openEnded ? days.length : Math.min(days.length, span.end);
    const conflict = mayConflict && exceedsCapacity(timed, timedAll, capacity);
    return { entry, key: entryKey(entry), lane, start, end, conflict, times: { checkInTime: timed.checkInTime, checkOutTime: timed.checkOutTime } };
  });
  // A 1 pm late checkout beside a 3 pm check-in are not a double booking, yet their half-day bars would overlap: meet at the join.
  const lastInLane = new Map<number, PlacedBarSpec>();
  for (const bar of bars) {
    const previous = lastInLane.get(bar.lane);
    if (previous && previous.end > bar.start) previous.end = Math.max(previous.start + 0.25, bar.start);
    lastInLane.set(bar.lane, bar);
  }
  const turnovers = layoutTurnovers({ all, timedOf, bars, firstDay, lastDay, dayCount: days.length, property });
  const laneCount = bars.length ? Math.max(...bars.map(bar => bar.lane)) + 1 : 1;
  return { room, all, busy, bars, turnovers, dayEntries: [], monthPercents: [], height: roomRowHeight(laneCount) };
}

/** Lanes by real overlap: a stay shares a lane with the one before it unless their wall-time intervals intersect. */
function timedLanes(items: { entry: PropertyBookingEntry; timed: TimedStay }[]): { entry: PropertyBookingEntry; timed: TimedStay; lane: number }[] {
  const ends: number[] = [];
  return [...items].sort((a, b) => stayStartWall(a.timed) - stayStartWall(b.timed)).map(item => {
    const start = stayStartWall(item.timed);
    let lane = ends.findIndex(end => end <= start);
    if (lane < 0) lane = ends.length;
    ends[lane] = stayEndWall(item.timed);
    return { ...item, lane };
  });
}

/** True when, at some moment of `self`'s stay, more than `capacity` stays (itself included) are in the room. */
function exceedsCapacity(self: TimedStay, all: readonly TimedStay[], capacity: number): boolean {
  const overlapping = all.filter(other => other.id !== self.id && staysOverlap(other, self));
  if (overlapping.length < capacity) return false;
  const events: [number, number][] = [];
  for (const stay of [self, ...overlapping]) { events.push([stayStartWall(stay), 1], [stayEndWall(stay), -1]); }
  // At an equal instant a departure frees the bed before an arrival takes it.
  events.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let live = 0;
  for (const [, delta] of events) { live += delta; if (live > capacity) return true; }
  return false;
}

const minutesToTime = (total: number) => {
  const wrapped = ((Math.round(total) % 1440) + 1440) % 1440;
  return `${String(Math.floor(wrapped / 60)).padStart(2, "0")}:${String(wrapped % 60).padStart(2, "0")}`;
};

/** A turnover is the window between consecutive guests; past a day without a next guest it is just checkout + buffer. */
const TURNOVER_NEXT_WITHIN_MINUTES = 24 * 60;

function layoutTurnovers(args: { all: PropertyBookingEntry[]; timedOf: (entry: PropertyBookingEntry) => TimedStay; bars: PlacedBarSpec[]; firstDay: string; lastDay: string; dayCount: number; property: PropertyStayTimes }): TurnoverSpec[] {
  const { all, timedOf, bars, firstDay, lastDay, dayCount, property } = args;
  const drawn = new Map<PropertyBookingEntry, PlacedBarSpec>();
  for (const bar of bars) drawn.set(bar.entry, bar);
  if (!drawn.size) return [];
  const limit = addDaysToDateKey(lastDay, 1);
  // Guests only: a closed room or a channel's "Not available" has nobody to clean up after.
  const guests = all.filter(entry => !isAvailabilityBlockRow(entry)).map(entry => ({ entry, timed: timedOf(entry) })).sort((a, b) => stayStartWall(a.timed) - stayStartWall(b.timed));
  const out: TurnoverSpec[] = [];
  const buffer = property.cleaningBufferMinutes;
  for (let index = 0; index < guests.length; index++) {
    const { entry, timed } = guests[index]!;
    const bar = drawn.get(entry);
    if (!bar || entry.openEnded || timed.checkOut < firstDay || timed.checkOut > limit) continue;
    const endWall = stayEndWall(timed);
    let next: (typeof guests)[number] | null = null;
    for (let j = index + 1; j < guests.length; j++) { if (stayStartWall(guests[j]!.timed) >= endWall) { next = guests[j]!; break; } }
    const gap = next ? stayStartWall(next.timed) - endWall : null;
    const within = gap !== null && gap <= TURNOVER_NEXT_WITHIN_MINUTES;
    const nextSpan = within ? halfDayBarSpan(next!.timed, firstDay) : null;
    const startX = nextSpan ? Math.min(bar.end, nextSpan.start) : bar.end;
    const endX = nextSpan ? nextSpan.start : bar.end + buffer / 1440;
    if (endX < 0 || startX >= dayCount) continue;
    out.push({
      key: bar.key, entry, next: within ? next!.entry : null, lane: bar.lane, start: startX, end: Math.min(endX, dayCount),
      short: within && gap! < buffer, gapMinutes: within ? gap : null, bufferMinutes: buffer,
      outTime: timed.checkOutTime,
      endTime: within ? next!.timed.checkInTime : minutesToTime(stayTimeMinutes(timed.checkOutTime) + buffer),
    });
  }
  return out;
}

/** The tooltip / aria-label of a turnover strip: the short gap names itself, a cleaning names its window. */
export function turnoverLabel(turnover: TurnoverSpec, hasJob: boolean): string {
  if (turnover.short) return `Turnover ${formatGapDuration(turnover.gapMinutes ?? 0)} · shorter than the ${formatGapDuration(turnover.bufferMinutes)} cleaning buffer`;
  return `${hasJob ? "Cleaning" : "Turnover"} · ${formatStayTime(turnover.outTime)} – ${formatStayTime(turnover.endTime)}`;
}

/** The gap between two bars at a turnover is never thinner than this; the cleaning block fills it. */
export const TURNOVER_MIN_GAP_PX = 6;

/** The cleaning block's px box: checkout x to next check-in x, widened to the minimum and centred on the boundary. */
export function turnoverStripPx(turnover: Pick<TurnoverSpec, "start" | "end">, colPx: number): { left: number; width: number } {
  const x0 = turnover.start * colPx;
  const x1 = turnover.end * colPx;
  if (x1 - x0 < TURNOVER_MIN_GAP_PX) return { left: (x0 + x1) / 2 - TURNOVER_MIN_GAP_PX / 2, width: TURNOVER_MIN_GAP_PX };
  return { left: x0, width: x1 - x0 };
}

export type PixelBar = PlacedBarSpec & { left: number; width: number; top: number; narrow: boolean };

/** The hatch a standing channel closure is drawn with (and the legend swatch for it). */
export const CLOSURE_HATCH = "repeating-linear-gradient(135deg, rgb(148 163 184 / 0.7) 0 3px, rgb(241 245 249 / 0.95) 3px 8px)";

/** A channel's own closure ("Airbnb (Not available)") longer than this is a standing closure, not a stay: drawn hatched, never as a guest. */
export { LONG_CLOSURE_NIGHTS };

/** The channel's host block (never a reservation) that runs past {@link LONG_CLOSURE_NIGHTS}. */
export function isLongChannelClosure(entry: Pick<PropertyBookingEntry, "source" | "summary" | "start" | "end" | "openEnded">): boolean {
  if (!isChannelBookingSource(entry.source) || !isHostBlockSummary(entry.summary)) return false;
  return Boolean(entry.openEnded) || dayDiff(entry.end, entry.start) + 1 > LONG_CLOSURE_NIGHTS;
}

const shortDate = (key: string) => new Date(`${key}T12:00:00`).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });

/** "Closed on Airbnb · until Oct 27, 2027": the date is the check-out, the first day the channel is open again. */
export function closureBarLabel(entry: Pick<PropertyBookingEntry, "source" | "channelLabel" | "end" | "openEnded">): string {
  const channel = bookingSourceLabel(entry.source, entry.channelLabel);
  return entry.openEnded ? `Closed on ${channel} · no end` : `Closed on ${channel} · until ${shortDate(addDaysToDateKey(entry.end, 1))}`;
}

/** A PropLane block with no end date: it holds the room from its start for good, so the bar says so. */
export const isNoEndBlock = (entry: Pick<PropertyBookingEntry, "source" | "openEnded">) => entry.source === "block" && Boolean(entry.openEnded);

export const barDisplayName = (entry: PropertyBookingEntry) => {
  if (isLongChannelClosure(entry)) return closureBarLabel(entry);
  const base = entry.residentName || bookingEntryNamedLabel(entry) || entry.summary;
  // An unnamed open-ended block ("Blocked" from Sep 30, no end) says where it starts so it is easy to find and remove.
  return isNoEndBlock(entry) && !entry.residentName ? `${base} · from ${shortDate(entry.start).replace(/, \d{4}$/, "")}` : base;
};

/** A room with a double booking in view: more stays in it, at one moment, than it has beds. */
export const roomHasClash = (layout: Pick<RoomLayout, "bars">) => layout.bars.some(bar => bar.conflict);

/**
 * Bars in px. A bar under `NARROW_BAR_PX` is `narrow`: it draws no name (a glyph at most), and no bar ever draws
 * text outside itself.
 */
export function placeBars(bars: readonly PlacedBarSpec[], colPx: number, turnovers: readonly TurnoverSpec[] = []): PixelBar[] {
  // A whole-day edge keeps a 2px inset; a mid-cell edge (a half-day check-in / check-out) a 1px one.
  const edges = bars.map(bar => ({ left: bar.start * colPx + (Number.isInteger(bar.start) ? 2 : 1), right: bar.end * colPx - (Number.isInteger(bar.end) ? 2 : 1) }));
  // At a turnover the two bars give way to the cleaning block: it fills checkout x -> next check-in x (min 6px, centred on the boundary).
  if (turnovers.length) {
    const byEntry = new Map<PropertyBookingEntry, number>();
    bars.forEach((bar, index) => byEntry.set(bar.entry, index));
    for (const turnover of turnovers) {
      if (!turnover.next) continue;
      const from = byEntry.get(turnover.entry);
      const to = byEntry.get(turnover.next);
      if (from === undefined || to === undefined) continue;
      const strip = turnoverStripPx(turnover, colPx);
      edges[from]!.right = strip.left;
      edges[to]!.left = strip.left + strip.width;
    }
  }
  return bars.map((bar, index) => {
    const { left } = edges[index]!;
    const width = Math.max(4, edges[index]!.right - left);
    // A narrow bar draws no text; its name is never drawn outside it (see `BookingBar`).
    return { ...bar, left, width, top: 4 + bar.lane * LANE_PITCH, narrow: width < NARROW_BAR_PX };
  });
}

export type HouseInput = {
  propertyId: string;
  name: string;
  address: string;
  /** Every bookable row of the house (a whole home is one). */
  rooms: TimelineRoom[];
  entries: PropertyBookingEntry[];
};

export type NarrowedHouse = { rooms: TimelineRoom[]; entriesByRoom: Map<string, PropertyBookingEntry[]> | null; scopeEntries: PropertyBookingEntry[] };

export const entryBelongsToRoom = (entry: PropertyBookingEntry, roomId: string) => !entry.roomId || entry.roomId === roomId;

/**
 * Apply the search to one house: the house's name or address shows every room; a room's label shows that
 * room; a guest/summary hit shows the rooms holding the hit and only the matching bars in them. `null` = no
 * match, the house is dropped.
 */
export function narrowHouseBySearch(house: HouseInput, query: string): NarrowedHouse | null {
  const needle = query.trim().toLowerCase();
  if (!needle) return { rooms: house.rooms, entriesByRoom: null, scopeEntries: house.entries };
  if (`${house.name} ${house.address}`.toLowerCase().includes(needle)) return { rooms: house.rooms, entriesByRoom: null, scopeEntries: house.entries };
  const rooms: TimelineRoom[] = [];
  const entriesByRoom = new Map<string, PropertyBookingEntry[]>();
  const scope = new Set<PropertyBookingEntry>();
  for (const room of house.rooms) {
    const mine = house.entries.filter(entry => entryBelongsToRoom(entry, room.id));
    const roomMatch = room.label.toLowerCase().includes(needle);
    const hits = roomMatch ? mine : mine.filter(entry => bookingEntryMatchesSearch(entry, needle));
    if (!roomMatch && !hits.length) continue;
    rooms.push(room);
    entriesByRoom.set(room.id, hits);
    for (const entry of hits) scope.add(entry);
  }
  return rooms.length ? { rooms, entriesByRoom, scopeEntries: [...scope] } : null;
}

export type FlatRow = { top: number; height: number };

/**
 * The slice of `rows` to draw: those intersecting the viewport plus a buffer. Returns the whole list when
 * windowing does not apply (a small list, or a scroller that has not been measured).
 */
export function windowRows(rows: readonly FlatRow[], scrollTop: number, viewportHeight: number, enabled = true): { first: number; last: number } {
  if (!enabled || rows.length < WINDOW_MIN_ROWS || viewportHeight <= 0) return { first: 0, last: rows.length };
  const from = scrollTop - HEADER_HEIGHT - WINDOW_BUFFER_PX;
  const to = scrollTop - HEADER_HEIGHT + viewportHeight + WINDOW_BUFFER_PX;
  let lo = 0, hi = rows.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (rows[mid]!.top + rows[mid]!.height <= from) lo = mid + 1; else hi = mid; }
  const first = lo;
  let last = first;
  while (last < rows.length && rows[last]!.top < to) last++;
  return { first, last };
}

type CacheSlot = { stamp: object; map: Map<string, unknown> };
const CACHES = new WeakMap<object, Map<string, CacheSlot>>();
/**
 * A lazily filled Map that lives exactly as long as `owner` (the memoized house list) and is thrown away when
 * `stamp` (the capacity cache, i.e. the data generation) or `tag` (the view and range) changes. It is held in a
 * WeakMap, not in a hook's value, so filling it during render is a cache write, not a mutation of React state.
 */
export function lazyCache<T>(owner: object, tag: string, stamp: object): Map<string, T> {
  let slots = CACHES.get(owner);
  if (!slots) { slots = new Map(); CACHES.set(owner, slots); }
  let slot = slots.get(tag);
  if (!slot || slot.stamp !== stamp) { slot = { stamp, map: new Map() }; slots.set(tag, slot); }
  return slot.map as Map<string, T>;
}
