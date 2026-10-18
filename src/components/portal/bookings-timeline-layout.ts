import { bookingActiveOn, bookingCheckout, bookingLanes, calendarOccupancy, calendarRange, occupancyCell, type BookingCalendarView } from "@/lib/channel-calendar/bookings-calendar-view";
import { bookingEntryMatchesSearch } from "@/lib/channel-calendar/bookings-ui";
import { bookingEntryNamedLabel } from "@/lib/channel-calendar/booking-guest-label";
import type { PropertyBookingEntry } from "@/lib/channel-calendar/property-bookings";
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
/** Below this many px a bar draws no text inside; its name sits to its right instead. */
export const NARROW_BAR_PX = 56;
/** Free room needed beside a narrow bar before its name is drawn at all. */
export const MIN_OUTSIDE_LABEL_PX = 28;
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

export type PlacedBarSpec = { entry: PropertyBookingEntry; key: string; lane: number; start: number; end: number; conflict: boolean };

export type RoomLayout = {
  room: TimelineRoom;
  all: PropertyBookingEntry[];
  /** Per day index: any stay at all holds the room (a search never frees a night a hidden stay holds). */
  busy: boolean[];
  bars: PlacedBarSpec[];
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
}): RoomLayout {
  const { room, all, view, days, anchor, propertyId, capacities, entryKey } = args;
  const shown = args.shown ?? all;
  const capacity = capacities.roomCapacity(propertyId, room.id);
  if (view === "year") {
    const monthPercents = days.map(month => calendarOccupancy(all, calendarRange("month", month), propertyId, { bedsTotal: () => capacity, roomCapacity: () => capacity }));
    return { room, all, busy: [], bars: [], dayEntries: [], monthPercents, height: ROOM_ROW_MIN_HEIGHT };
  }
  if (view === "day") {
    const dayEntries = shown.filter(entry => bookingActiveOn(entry, anchor) || bookingCheckout(entry) === anchor);
    return { room, all, busy: [], bars: [], dayEntries, monthPercents: [], height: 64 };
  }
  const firstDay = days[0]!, lastDay = days.at(-1)!;
  const inRange = (entry: PropertyBookingEntry) => entry.start <= lastDay && (entry.openEnded || entry.end >= firstDay);
  const busy = new Array<boolean>(days.length).fill(false);
  for (const entry of all) {
    if (!inRange(entry)) continue;
    const from = Math.max(0, dayDiff(entry.start, firstDay));
    const to = entry.openEnded ? days.length : Math.min(days.length, dayDiff(bookingCheckout(entry)!, firstDay));
    for (let index = from; index < to; index++) busy[index] = true;
  }
  const lanes = bookingLanes(shown.filter(inRange));
  // A room can only be overbooked when it holds more stays than beds; skip the per-day scan otherwise.
  const mayConflict = all.length > capacity;
  const bars = lanes.map(({ entry, lane }) => {
    const start = Math.max(0, dayDiff(entry.start, firstDay));
    const end = entry.openEnded ? days.length : Math.min(days.length, dayDiff(bookingCheckout(entry)!, firstDay));
    const conflict = mayConflict && days.some(day => bookingActiveOn(entry, day) && occupancyCell(all, day, capacity).conflicts);
    return { entry, key: entryKey(entry), lane, start, end, conflict };
  });
  const laneCount = bars.length ? Math.max(...bars.map(bar => bar.lane)) + 1 : 1;
  return { room, all, busy, bars, dayEntries: [], monthPercents: [], height: roomRowHeight(laneCount) };
}

export type PixelBar = PlacedBarSpec & { left: number; width: number; top: number; narrow: boolean; labelWidth: number };

/** Rough width of a 12px label, used only to size the click target beside a narrow bar. */
const estimateLabelPx = (text: string) => Math.ceil(text.length * 6.5) + 8;

export const barDisplayName = (entry: PropertyBookingEntry) => entry.residentName || bookingEntryNamedLabel(entry) || entry.summary;

/**
 * Bars in px. A bar under `NARROW_BAR_PX` draws no text; its name goes right of it in the same lane, up to the
 * next bar's start (or the track's end), and is dropped when under `MIN_OUTSIDE_LABEL_PX` is free.
 */
export function placeBars(bars: readonly PlacedBarSpec[], colPx: number, trackWidth: number): PixelBar[] {
  const laneStarts = new Map<number, number[]>();
  for (const bar of bars) {
    const starts = laneStarts.get(bar.lane) ?? [];
    starts.push(bar.start * colPx);
    laneStarts.set(bar.lane, starts);
  }
  for (const starts of laneStarts.values()) starts.sort((a, b) => a - b);
  return bars.map(bar => {
    const left = bar.start * colPx + 2;
    const width = Math.max(4, (bar.end - bar.start) * colPx - 4);
    const narrow = width < NARROW_BAR_PX;
    let labelWidth = 0;
    if (narrow) {
      const right = left + width;
      const nextStart = (laneStarts.get(bar.lane) ?? []).find(start => start >= right - 2) ?? trackWidth;
      const free = nextStart - right - 8;
      if (free >= MIN_OUTSIDE_LABEL_PX) labelWidth = Math.min(free, estimateLabelPx(barDisplayName(bar.entry)));
    }
    return { ...bar, left, width, top: 4 + bar.lane * LANE_PITCH, narrow, labelWidth };
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
