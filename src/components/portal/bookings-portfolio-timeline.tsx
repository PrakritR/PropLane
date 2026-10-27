"use client";

import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { ChevronDown, ChevronLeft, ChevronRight, ChevronsDownUp, ChevronsUpDown } from "lucide-react";
import { BookingBar, BookingBarSheet, useIsPhoneWidth, type BookingBarHandlers } from "@/components/portal/bookings-timeline-bar";
import {
  columnPx,
  dayDiff,
  entryBelongsToRoom,
  HOUSE_ROW_HEIGHT,
  labelWidthPx,
  layoutRoom,
  lazyCache,
  narrowHouseBySearch,
  placeBars,
  CLOSURE_HATCH,
  roomHasClash,
  BAR_VISUAL_HEIGHT,
  LANE_PITCH,
  ROOM_ROW_MIN_HEIGHT,
  turnoverLabel,
  turnoverStripPx,
  windowRows,
  type RoomLayout,
  type TimelineRoom,
  type TurnoverSpec,
} from "@/components/portal/bookings-timeline-layout";
import { entryStayTimes, turnoverCleaningKey } from "@/components/portal/bookings-stay-times";
import { propertyStayTimesFor } from "@/components/portal/bookings-stay-times-store";
import type { PropertyStayTimes } from "@/lib/bookings/stay-times";
import { PortalIconAction, PortalPrimaryIconAction } from "@/components/portal/portal-icon-action";
import { PortalSegmentedControl } from "@/components/portal/portal-metrics";
import { isResidentStay, BOOKING_CALENDAR_VIEWS, bookingCheckout, calendarOccupancy, calendarOccupancyDays, calendarOccupancyOnDay, calendarOccupancySummary, calendarRange, calendarStatusClass, type BookingCalendarView } from "@/lib/channel-calendar/bookings-calendar-view";
import { addDaysToDateKey, bookingEntryKey } from "@/lib/channel-calendar/bookings-ui";
import type { OccupancyDayLookup } from "@/lib/channel-calendar/bookings-occupancy";
import { bookingOccupancyCapacities } from "@/lib/channel-calendar/bookings-room-counts";
import type { PropertyBookingEntry } from "@/lib/channel-calendar/property-bookings";
import { getPropertyById, getRoomOptionsForProperty, parseRoomChoiceValue } from "@/lib/rental-application/data";
import { dateKey } from "@/lib/room-availability-calendar";
import { occupancyStayKind, type OccupancyCapacities, type OccupancyRoomOption } from "@/lib/occupancy/snapshot";
import { roomHeadlinePriceLabel } from "@/lib/room-pricing";

export type TimelineHouseInfo = { name: string; address?: string };

export type BookingsPortfolioTimelineProps = {
  propertyIds: string[];
  /** Room-filtered entries; the timeline applies `searchQuery` itself so it can match houses and rooms too. */
  entries: PropertyBookingEntry[];
  today: Date;
  onOpenDay?: (dayKey: string) => void;
  occupancyDays?: OccupancyDayLookup;
  emptyMessage?: string;
  onAddBooking?: () => void;
  onEditBooking?: (entry: PropertyBookingEntry) => void;
  /** Unblock a live PropLane block (the cancel dialog, with Undo). */
  onUnblockBooking?: (entry: PropertyBookingEntry) => void;
  /** Hard-delete a PropLane block (a danger confirm first). Never offered for an imported or resident bar. */
  onDeleteBlock?: (entry: PropertyBookingEntry) => void;
  /** "Unblock in PropLane" on an imported Airbnb / Booking.com bar: tombstone it, restorable. */
  onUnblockChannelStay?: (entry: PropertyBookingEntry) => void;
  /** False for a bar the viewer may not unblock or delete (Calendar permission below edit). Absent = allowed. */
  canRemoveBooking?: (entry: PropertyBookingEntry) => boolean;
  /** Click on an empty room-day (today or later) - opens Mark reserved for that room and night. */
  onReserveRoomDay?: (target: { propertyId: string; roomId: string; dayKey: string }) => void;
  /** Explicit page scope, so filtering the workspace never changes its preference. */
  preferenceKey?: string;
  roomFilterId?: string;
  /** Houses, rooms and guests the calendar narrows to. */
  searchQuery?: string;
  /** Injection points; each defaults to the listing store. */
  resolveRooms?: (propertyId: string, entries: PropertyBookingEntry[]) => TimelineRoom[];
  resolveHouse?: (propertyId: string, entries: PropertyBookingEntry[]) => TimelineHouseInfo;
  capacities?: OccupancyCapacities;
  /** The property's stay-time defaults; defaults to the listing store's `listingSubmission.stayTimes`. */
  resolveTimes?: (propertyId: string) => PropertyStayTimes;
  /**
   * Turnover cleaning jobs that exist (`turnoverCleaningKey` of the checking-out stay). A turnover with a job draws a
   * hatched cleaning strip; one shorter than the property's cleaning buffer draws red whether or not a job exists.
   */
  cleaningKeys?: ReadonlySet<string>;
};

const subscribe = (notify: () => void) => { window.addEventListener("resize", notify); window.addEventListener("storage", notify); return () => { window.removeEventListener("resize", notify); window.removeEventListener("storage", notify); }; };
const dateLabel = (key: string, options: Intl.DateTimeFormatOptions = { month: "short", day: "numeric" }) => new Date(`${key}T12:00:00`).toLocaleDateString("en-US", options);

/**
 * The bookable rows of one property: a row per saved room (the room picker's
 * list, so a blank name reads "Room n"), else the server's saved room list (the viewer's listing store lacks
 * the house: service-mode staff, a fresh device), else booked rooms, else the whole home.
 */
export function propertyRooms(propertyId: string, entries: PropertyBookingEntry[], serverRooms?: readonly OccupancyRoomOption[]) {
  const property = getPropertyById(propertyId);
  const seen = new Map<string, { id: string; label: string; rent: string }>();
  const configured = property?.listingSubmission?.rooms ?? [];
  const options = getRoomOptionsForProperty(propertyId, { includeUnavailable: true, includeUnnamed: true });
  for (const option of options) {
    const id = parseRoomChoiceValue(option.value).listingRoomId ?? "";
    const room = configured.find(row => row.id === id);
    const label = option.label.split(" · ").filter(part => !part.includes("$") && !part.includes("sq ft") && !part.includes("Rent TBD")).slice(0, 2).join(" · ");
    seen.set(id, { id, label, rent: room ? roomHeadlinePriceLabel(room, "") : "" });
  }
  if (!seen.size) for (const room of serverRooms ?? []) seen.set(room.id, { id: room.id, label: room.label, rent: "" });
  if (!seen.size) for (const entry of entries) seen.set(entry.roomId, { id: entry.roomId, label: entry.roomLabel, rent: "" });
  if (!seen.size) seen.set("", { id: "", label: "Whole home", rent: "" });
  return [...seen.values()];
}
/** The calendar's colour key: one row that never wraps (it scrolls sideways on a phone), colour dot + name. */
export function BookingsCalendarLegend() {
  return <ul className="flex shrink-0 flex-nowrap items-center gap-x-4 overflow-x-auto whitespace-nowrap px-1 pt-1 text-xs text-muted" data-attr="bookings-calendar-legend" aria-label="Calendar colours">{["Hold", "Confirmed", "In-house", "Checked out", "Airbnb", "Booking.com", "PadSplit"].map(status => <li key={status} className="flex shrink-0 items-center gap-1.5"><span aria-hidden className={`h-2.5 w-2.5 rounded-full ${calendarStatusClass(status)}`} />{status}</li>)}<li className="flex shrink-0 items-center gap-1.5"><span aria-hidden className="h-2.5 w-2.5 rounded-full border border-slate-400" style={{ backgroundImage: CLOSURE_HATCH }} />Closed on a channel</li></ul>;
}

/**
 * `bedsTotal` / `roomCapacity` both re-enter `getPropertyById`, which reads the
 * listing store. One cache per computation turns a lookup per property-day — a
 * year view is ~365 days — into one lookup per property.
 */
function cachedOccupancyCapacities(base: OccupancyCapacities): OccupancyCapacities {
  const beds = new Map<string, number>();
  const rooms = new Map<string, number>();
  return {
    bedsTotal: propertyId => {
      let value = beds.get(propertyId);
      if (value === undefined) { value = base.bedsTotal(propertyId); beds.set(propertyId, value); }
      return value;
    },
    roomCapacity: (propertyId, roomId) => {
      const key = `${propertyId}\u0000${roomId}`;
      let value = rooms.get(key);
      if (value === undefined) { value = base.roomCapacity(propertyId, roomId); rooms.set(key, value); }
      return value;
    },
  };
}

const isGuestStay = (entry: PropertyBookingEntry) => isResidentStay(entry) || entry.bookingStatus === "confirmed" || ["lease", "guest"].includes(occupancyStayKind(entry));
const STRIP_COLOR = (percent: number) => `rgba(40,99,240,${percent ? .1 + .8 * percent / 100 : .05})`;

type HouseModel = {
  propertyId: string;
  name: string;
  address: string;
  single: boolean;
  times: PropertyStayTimes;
  rooms: TimelineRoom[];
  /** Every stay of the house: occupancy figures read these, never the search-narrowed set. */
  entries: PropertyBookingEntry[];
  entriesByRoom: Map<string, PropertyBookingEntry[]> | null;
  scopeEntries: PropertyBookingEntry[];
};
type HouseStats = { strip: number[]; avg: number; occupied: number; beds: number };
type DayMeta = { day: string; weekend: boolean; today: boolean; top: string; bottom: string; openLabel: string; longLabel: string };
type TimelineRowModel =
  | { key: string; kind: "house"; top: number; height: number; house: HouseModel }
  | { key: string; kind: "room"; top: number; height: number; house: HouseModel; layout: RoomLayout };
type RowContext = {
  meta: DayMeta[];
  view: BookingCalendarView;
  colPx: number;
  trackW: number;
  labelPx: number;
  /** How far the track is scrolled left: a bar's start under the label column pushes its name right by that much. */
  scrollLeft: number;
  todayKey: string;
  anchor: string;
  focusLabel: string;
  handlers: BookingBarHandlers;
  cleaningKeys?: ReadonlySet<string>;
  onOpenSheet?: (entry: PropertyBookingEntry) => void;
  onToggle: (propertyId: string) => void;
  onDrill: (day: string) => void;
  onReserveRoomDay?: BookingsPortfolioTimelineProps["onReserveRoomDay"];
};

/** Surfaces that stick (the label column, the day header) must be opaque: `--card` is translucent on the portal's light surface. */
const OPAQUE = "bg-[var(--pl-surface-raised)]";
const HOUSE_TINT = "bg-gradient-to-b from-accent/30 to-accent/30";

const HATCH = "repeating-linear-gradient(135deg, rgb(100 116 139 / 0.8) 0 2px, rgb(100 116 139 / 0.16) 2px 6px)";
const HATCH_SHORT = "repeating-linear-gradient(135deg, rgb(220 38 38) 0 2px, rgb(254 202 202) 2px 6px)";

/** The cleaning block between two bars: full bar height, slate hatch with a job, red hatch when the gap is under the buffer. */
function TurnoverStrip({ turnover, colPx, hasJob }: { turnover: TurnoverSpec; colPx: number; hasJob: boolean }) {
  const { left, width } = turnoverStripPx(turnover, colPx);
  const label = turnoverLabel(turnover, hasJob);
  return <div role="img" aria-label={label} title={label} data-attr="bookings-turnover" data-turnover={turnover.short ? "short" : "cleaning"} className="absolute z-10 rounded-[3px]" style={{ left, width, top: 4 + turnover.lane * LANE_PITCH + (LANE_PITCH - BAR_VISUAL_HEIGHT) / 2, height: BAR_VISUAL_HEIGHT, backgroundImage: turnover.short ? HATCH_SHORT : HATCH }} />;
}

const TimelineRow = memo(function TimelineRow({ row, ctx, stats, expanded }: { row: TimelineRowModel; ctx: RowContext; stats?: HouseStats; expanded: boolean }) {
  const { meta, view, colPx, trackW, labelPx, todayKey, anchor } = ctx;
  const labelStyle = { width: labelPx, height: row.height };
  const labelBase = `sticky left-0 z-20 flex shrink-0 flex-col justify-center border-r border-border ${OPAQUE}`;
  const house = row.house;
  const title = [house.name, house.address].filter(Boolean).join(" · ");
  const pixelBars = useMemo(() => (row.kind === "room" ? placeBars(row.layout.bars, colPx, row.layout.turnovers) : []), [row, colPx]);
  if (row.kind === "house") {
    const s = stats!;
    return <div className="flex border-b border-border" style={{ height: row.height, width: labelPx + trackW }} data-attr={`bookings-timeline-property-${house.propertyId}`}>
      <div className={`${labelBase} ${HOUSE_TINT}`} style={labelStyle} title={title}>
        <button type="button" aria-expanded={expanded} onClick={() => ctx.onToggle(house.propertyId)} className="flex min-h-11 w-full min-w-0 flex-col justify-center px-2 text-left outline-none hover:bg-accent/40 focus-visible:bg-accent/40 sm:px-3">
          <span className="flex min-w-0 items-center gap-1 text-[13px] font-semibold leading-4 text-foreground sm:text-sm"><span className="truncate">{house.name}</span><ChevronDown aria-hidden className={`size-4 shrink-0 text-muted transition-transform ${expanded ? "" : "-rotate-90"}`} /></span>
          <span className="truncate text-[11px] leading-[13px] text-muted tabular-nums sm:text-xs" data-attr="bookings-property-occupied">{s.occupied}/{s.beds} {ctx.focusLabel}<span className="max-sm:hidden"> · {s.avg}% avg</span></span>
        </button>
      </div>
      <div className={`relative flex items-center ${HOUSE_TINT}`} style={{ width: trackW, height: row.height }}>
        {meta.map((m, index) => <div key={m.day} title={`${s.strip[index]}% occupied`} className="flex flex-none items-center px-px" style={{ width: colPx }}><div className="h-2 w-full rounded" style={{ backgroundColor: STRIP_COLOR(s.strip[index]!) }} /></div>)}
      </div>
    </div>;
  }
  const { layout } = row;
  const room = layout.room;
  // A double booking in view puts a red dot by the room's name, so it is found without scanning every bar.
  const clash = roomHasClash(layout);
  const label = <div className={`${labelBase} px-2 sm:px-3`} style={labelStyle} title={title}>
    <span className="flex min-w-0 items-center gap-1.5"><span className="truncate text-[13px] font-semibold leading-4 text-foreground sm:text-sm">{house.single ? house.name : room.label}</span>{clash ? <span role="img" aria-label="Double booked" title="Double booked" data-attr="bookings-room-clash" className="size-2 shrink-0 rounded-full bg-red-500" /> : null}</span>
    {house.single && room.label && room.label !== "Whole home" && room.label !== house.name ? <span className="truncate text-xs text-muted">{room.label}</span> : null}
    {room.rent ? <span className="truncate text-xs text-muted">{room.rent}</span> : null}
  </div>;
  let track;
  if (view === "year") {
    track = <div className="flex" style={{ width: trackW, height: row.height }}>{meta.map((m, index) => { const percent = layout.monthPercents[index]!; return <button type="button" key={m.day} onClick={() => ctx.onDrill(m.day)} title={`${room.label} · ${dateLabel(m.day, { month: "long" })}: ${percent}% occupied`} className="flex-none border-r border-border text-xs font-semibold tabular-nums" style={{ width: colPx, backgroundColor: percent ? `rgba(40,99,240,${.1 + .75 * percent / 100})` : undefined }}>{percent ? `${percent}%` : ""}</button>; })}</div>;
  } else if (view === "day") {
    track = <div className="flex items-center gap-2 p-1.5" style={{ width: trackW, height: row.height }}>{layout.dayEntries.map(entry => <BookingBar key={bookingEntryKey(entry)} entry={entry} today={todayKey} onOpenSheet={ctx.onOpenSheet} {...ctx.handlers} times={entryStayTimes(entry, house.times)} className="h-auto min-h-11 min-w-0 flex-1" detail={<span className="block truncate px-2 text-xs">{bookingCheckout(entry) === anchor ? "Checks out today" : entry.start === anchor ? "Checks in today" : `Night ${dayDiff(anchor, entry.start) + 1}${entry.openEnded ? " · open-ended" : ` of ${dayDiff(bookingCheckout(entry)!, entry.start)}`}`}</span>} />)}{!layout.dayEntries.length ? <span className="p-2 text-xs text-muted">Vacant</span> : null}</div>;
  } else {
    const reserve = ctx.onReserveRoomDay;
    const name = house.single ? house.name : room.label;
    track = <div className="relative" style={{ width: trackW, height: row.height }}>
      <div className="absolute inset-0 flex">{meta.map((m, index) => {
        const cellClass = `flex-none border-r border-border/40 ${m.today ? "bg-primary/10" : m.weekend ? "bg-muted/5" : ""}`;
        const free = !!reserve && m.day >= todayKey && !layout.busy[index];
        return free ? <button type="button" key={m.day} style={{ width: colPx }} className={`${cellClass} hover:bg-primary/10 focus-visible:bg-primary/10`} data-attr="bookings-calendar-empty-cell" data-day={m.day} data-room={room.id} aria-label={`Mark ${name} reserved on ${m.longLabel}`} onClick={() => reserve({ propertyId: house.propertyId, roomId: room.id, dayKey: m.day })} /> : <div key={m.day} style={{ width: colPx }} className={cellClass} />;
      })}</div>
      {pixelBars.map(bar => <BookingBar key={bar.key} entry={bar.entry} today={todayKey} conflict={bar.conflict} times={bar.times} onOpenSheet={ctx.onOpenSheet} {...ctx.handlers} placement={{ left: bar.left, top: bar.top, width: bar.width, nameInset: Math.max(0, Math.min(bar.width - 24, ctx.scrollLeft - bar.left)), narrow: bar.narrow }} />)}
      {layout.turnovers.map(turnover => { const jobKey = turnoverCleaningKey(turnover.entry); const hasJob = !!jobKey && !!ctx.cleaningKeys?.has(jobKey); return turnover.short || hasJob ? <TurnoverStrip key={`t:${turnover.key}`} turnover={turnover} colPx={colPx} hasJob={hasJob} /> : null; })}
    </div>;
  }
  return <div className="flex border-b border-border" style={{ height: row.height, width: labelPx + trackW }} data-attr={house.single ? `bookings-timeline-property-${house.propertyId}` : undefined} data-room-row="">{label}{track}</div>;
});

export function BookingsPortfolioTimeline(props: BookingsPortfolioTimelineProps) {
  const serverRooms = props.occupancyDays?.rooms;
  const { propertyIds, today, cleaningKeys, resolveTimes, onEditBooking, onUnblockBooking, onDeleteBlock, onUnblockChannelStay, onAddBooking, onReserveRoomDay, roomFilterId, canRemoveBooking, onOpenDay, resolveRooms, resolveHouse } = props;
  const phone = useIsPhoneWidth();
  const labelPx = labelWidthPx(phone);
  const entries = useMemo(() => props.entries.filter(entry => entry.bookingStatus !== "cancelled" && entry.statusLabel?.toLowerCase() !== "cancelled"), [props.entries]);
  const scope = `proplane:bookings-calendar:${props.preferenceKey ?? "workspace"}`;
  const expandedKey = `${scope}:expanded`;
  const savedView = useSyncExternalStore(subscribe, () => { try { const saved = localStorage.getItem(scope); if (BOOKING_CALENDAR_VIEWS.includes(saved as BookingCalendarView)) return saved as BookingCalendarView; } catch {} return window.innerWidth < 640 ? "week" : "month"; }, () => "month" as BookingCalendarView);
  const savedExpanded = useSyncExternalStore(subscribe, () => { try { return localStorage.getItem(expandedKey); } catch { return null; } }, () => null);
  const [chosenView, setChosenView] = useState<{ scope: string; view: BookingCalendarView } | null>(null);
  const view = chosenView?.scope === scope ? chosenView.view : savedView;
  const [anchor, setAnchor] = useState(() => dateKey(today));
  const changeView = (value: BookingCalendarView) => { setChosenView({ scope, view: value }); try { localStorage.setItem(scope, value); } catch {} };
  const days = useMemo(() => calendarRange(view, anchor), [view, anchor]);
  const todayKey = dateKey(today);
  const next = (direction: number) => { if (view === "week" || view === "day") setAnchor(addDaysToDateKey(anchor, direction * (view === "week" ? 7 : 1))); else { const d = new Date(`${anchor}T12:00:00`); setAnchor(dateKey(new Date(d.getFullYear() + (view === "year" ? direction : 0), d.getMonth() + (view === "month" ? direction : 0), 1))); } };
  const drill = useCallback((day: string) => { setAnchor(day); setChosenView({ scope, view: "month" }); try { localStorage.setItem(scope, "month"); } catch {} }, [scope]);
  const rangeTitle = view === "year" ? anchor.slice(0, 4) : view === "month" ? dateLabel(anchor, { month: "long", year: "numeric" }) : view === "day" ? dateLabel(anchor, { weekday: "short", month: "short", day: "numeric" }) : `${dateLabel(days[0]!)} – ${dateLabel(days.at(-1)!)}`;
  // Year expands to every day of every month; the figures below are memoized on the data and the range.
  const rangeDays = useMemo(() => view === "year" ? days.flatMap(month => calendarRange("month", month)) : days, [view, days]);
  const focusDay = rangeDays.includes(todayKey) ? todayKey : rangeDays[0]!;
  const focusLabel = focusDay === todayKey ? "tonight" : `on ${dateLabel(focusDay)}`;

  // ---- Measured size: one scroller, so the column width comes from its width, never from percentages.
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const measure = () => setSize(prev => (prev.w === el.clientWidth && prev.h === el.clientHeight ? prev : { w: el.clientWidth, h: el.clientHeight }));
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  const measuredTrack = size.w > 0 ? size.w - labelPx : 0;
  const colPx = columnPx(view, days.length, measuredTrack, phone);
  const trackW = view === "day" ? colPx : days.length * colPx;

  const baseCapacities = props.capacities ?? bookingOccupancyCapacities;
  const needle = (props.searchQuery ?? "").trim();

  // ---- Entries grouped once by house; per-house models (name, rooms, search narrowing).
  const byProperty = useMemo(() => {
    const scoped = new Set(propertyIds);
    const grouped = new Map<string, PropertyBookingEntry[]>();
    for (const entry of entries) { if (!scoped.has(entry.propertyId)) continue; const list = grouped.get(entry.propertyId); if (list) list.push(entry); else grouped.set(entry.propertyId, [entry]); }
    return grouped;
  }, [entries, propertyIds]);
  const capacities = useMemo(() => cachedOccupancyCapacities(baseCapacities), [baseCapacities, byProperty]); // eslint-disable-line react-hooks/exhaustive-deps -- a fresh cache whenever the data changes
  const houses = useMemo<HouseModel[]>(() => {
    const out: HouseModel[] = [];
    for (const propertyId of propertyIds) {
      const mine = byProperty.get(propertyId) ?? [];
      const allRooms = resolveRooms ? resolveRooms(propertyId, mine) : propertyRooms(propertyId, mine, serverRooms?.[propertyId]);
      const info = resolveHouse ? resolveHouse(propertyId, mine) : (() => { const property = getPropertyById(propertyId); return { name: mine[0]?.propertyLabel || property?.title || "Untitled listing", address: property?.address }; })();
      // A whole home (one bookable row) is a single row under its own name. Read from the house's own
      // rooms, never the filtered list: narrowing to one room of a multi-room house does not make a whole home.
      const single = allRooms.length === 1;
      const rooms = roomFilterId ? allRooms.filter(room => room.id === roomFilterId) : allRooms;
      if (roomFilterId && !rooms.length) continue;
      const narrowed = narrowHouseBySearch({ propertyId, name: info.name, address: info.address ?? "", rooms, entries: mine }, needle);
      if (!narrowed) continue;
      out.push({ propertyId, name: info.name, address: info.address ?? "", single, times: (resolveTimes ?? propertyStayTimesFor)(propertyId), rooms: narrowed.rooms, entries: mine, entriesByRoom: narrowed.entriesByRoom, scopeEntries: narrowed.scopeEntries });
    }
    return out;
  }, [propertyIds, byProperty, resolveRooms, serverRooms, resolveHouse, resolveTimes, roomFilterId, needle]);
  const multiIds = useMemo(() => houses.filter(house => !house.single).map(house => house.propertyId), [houses]);

  // ---- Which houses are open. Collapsed by default past three houses; remembered per page; a filter or search opens its matches.
  const autoExpand = !!needle || !!roomFilterId;
  const [chosenExpanded, setChosenExpanded] = useState<{ scope: string; ids: string[] } | null>(null);
  const [autoCollapsed, setAutoCollapsed] = useState<{ key: string; ids: string[] }>({ key: "", ids: [] });
  const autoKey = `${needle}\u0000${roomFilterId ?? ""}`;
  const baseExpanded = useMemo(() => {
    if (chosenExpanded?.scope === expandedKey) return new Set(chosenExpanded.ids);
    if (savedExpanded) { try { const parsed = JSON.parse(savedExpanded); if (Array.isArray(parsed)) return new Set(parsed.filter((id): id is string => typeof id === "string")); } catch {} }
    return new Set(multiIds.length > 3 ? [] : multiIds);
  }, [chosenExpanded, expandedKey, savedExpanded, multiIds]);
  const collapsedHere = useMemo(() => new Set(autoCollapsed.key === autoKey ? autoCollapsed.ids : []), [autoCollapsed, autoKey]);
  const expandedNow = useMemo(() => new Set(multiIds.filter(id => (autoExpand ? !collapsedHere.has(id) : baseExpanded.has(id)))), [multiIds, autoExpand, collapsedHere, baseExpanded]);
  const persistExpanded = useCallback((ids: string[]) => { setChosenExpanded({ scope: expandedKey, ids }); try { localStorage.setItem(expandedKey, JSON.stringify(ids)); } catch {} }, [expandedKey]);
  const toggleHouse = useCallback((propertyId: string) => {
    if (autoExpand) { const set = new Set(collapsedHere); if (set.has(propertyId)) set.delete(propertyId); else set.add(propertyId); setAutoCollapsed({ key: autoKey, ids: [...set] }); return; }
    const set = new Set(baseExpanded); if (set.has(propertyId)) set.delete(propertyId); else set.add(propertyId);
    persistExpanded([...set]);
  }, [autoExpand, autoKey, collapsedHere, baseExpanded, persistExpanded]);
  const anyCollapsed = multiIds.some(id => !expandedNow.has(id));
  const toggleAll = () => {
    if (anyCollapsed) { setAutoCollapsed({ key: autoKey, ids: [] }); persistExpanded(multiIds); }
    else { setAutoCollapsed({ key: autoKey, ids: multiIds }); persistExpanded([]); }
  };

  // ---- Lazy layout: a room's lanes and bars exist only once its house is expanded.
  const rows = useMemo<TimelineRowModel[]>(() => {
    const layoutCache = lazyCache<RoomLayout>(houses, `${view}|${anchor}`, capacities);
    const out: TimelineRowModel[] = [];
    let top = 0;
    const push = (row: TimelineRowModel) => { out.push(row); top += row.height; };
    for (const house of houses) {
      if (!house.single) push({ key: `h:${house.propertyId}`, kind: "house", top, height: HOUSE_ROW_HEIGHT, house });
      if (!house.single && !expandedNow.has(house.propertyId)) continue;
      for (const room of house.rooms) {
        const cacheKey = `${house.propertyId}\u0000${room.id}`;
        let layout = layoutCache.get(cacheKey);
        if (!layout) {
          const all = house.entries.filter(entry => entryBelongsToRoom(entry, room.id));
          layout = layoutRoom({ room, all, shown: house.entriesByRoom?.get(room.id), view, days, anchor, propertyId: house.propertyId, capacities, entryKey: bookingEntryKey, times: house.times });
          layoutCache.set(cacheKey, layout);
        }
        push({ key: `r:${house.propertyId}:${room.id}`, kind: "room", top, height: Math.max(ROOM_ROW_MIN_HEIGHT, layout.height), house, layout });
      }
    }
    return out;
  }, [houses, expandedNow, view, days, anchor, capacities]);
  const totalHeight = rows.length ? rows.at(-1)!.top + rows.at(-1)!.height : 0;

  // ---- Windowing: only the rows near the viewport are drawn (and only when there are many).
  const [scrollTop, setScrollTop] = useState(0);
  const [scrollLeft, setScrollLeft] = useState(0);
  const rowsRef = useRef(rows);
  const sizeRef = useRef(size);
  const appliedWindow = useRef({ first: 0, last: 0 });
  useEffect(() => { rowsRef.current = rows; sizeRef.current = size; });
  const frame = useRef(0);
  const onScroll = useCallback(() => {
    if (frame.current) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = 0;
      const el = scrollRef.current;
      if (!el) return;
      const left = Math.round(el.scrollLeft / 4) * 4;
      setScrollLeft(current => (current === left ? current : left));
      const win = windowRows(rowsRef.current, el.scrollTop, sizeRef.current.h);
      if (win.first === appliedWindow.current.first && win.last === appliedWindow.current.last) return;
      appliedWindow.current = win;
      setScrollTop(el.scrollTop);
    });
  }, []);
  useEffect(() => () => { if (frame.current) cancelAnimationFrame(frame.current); }, []);
  const win = windowRows(rows, scrollTop, size.h);
  useEffect(() => { appliedWindow.current = win; }, [win.first, win.last]); // eslint-disable-line react-hooks/exhaustive-deps
  const windowed = win.first > 0 || win.last < rows.length;
  const visibleRows = windowed ? rows.slice(win.first, win.last) : rows;
  const topSpacer = windowed && rows[win.first] ? rows[win.first]!.top : 0;
  const bottomSpacer = windowed ? Math.max(0, totalHeight - (visibleRows.length ? visibleRows.at(-1)!.top + visibleRows.at(-1)!.height : 0) - topSpacer) : 0;

  // Opening a page puts today (or the first day) in view; a resize never re-scrolls.
  const measured = size.w > 0;
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !measured) return;
    if (view === "day" || view === "year") { el.scrollLeft = 0; return; }
    const index = days.indexOf(focusDay);
    el.scrollLeft = index > 0 ? Math.max(0, index * colPx - (el.clientWidth - labelPx) / 3) : 0;
  }, [view, anchor, measured]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---- Per-day header facts, computed once per range (a date format per cell is the slow part).
  const meta = useMemo<DayMeta[]>(() => days.map(day => {
    const weekend = [0, 6].includes(new Date(`${day}T12:00:00`).getDay());
    return { day, weekend, today: day === todayKey, top: dateLabel(day, view === "year" ? { year: "numeric" } : { weekday: "short" }), bottom: dateLabel(day, view === "year" ? { month: "short" } : { day: "numeric" }), openLabel: `Open ${dateLabel(day, { weekday: "long", month: "long", day: "numeric" })}`, longLabel: dateLabel(day, { weekday: "long", month: "long", day: "numeric" }) };
  }), [days, todayKey, view]);

  // ---- Figures, read through occupancyForDay (never a rooms.length count).
  const kpis = useMemo(() => {
    const first = rangeDays[0]!, last = rangeDays.at(-1)!;
    const guests = houses.flatMap(house => house.scopeEntries).filter(isGuestStay);
    const staying = guests.filter(entry => entry.start <= last && (entry.openEnded || entry.end >= first)).length;
    const checkIns = guests.filter(entry => entry.start >= first && entry.start <= last).length;
    const checkOuts = guests.filter(entry => { const out = bookingCheckout(entry); return out !== null && out >= first && out <= last; }).length;
    const occupied = calendarOccupancyOnDay(houses.flatMap(house => house.entries), focusDay, houses.map(house => house.propertyId), capacities);
    return { staying, checkIns, checkOuts, occupied };
  }, [houses, rangeDays, focusDay, capacities]);
  const statsCache = lazyCache<HouseStats>(houses, `${view}|${anchor}|${focusDay}`, capacities);
  const statsFor = (house: HouseModel): HouseStats => {
    let stats = statsCache.get(house.propertyId);
    if (stats) return stats;
    const now = calendarOccupancyOnDay(house.entries, focusDay, [house.propertyId], capacities);
    if (view === "year") {
      stats = { strip: days.map(month => calendarOccupancy(house.entries, calendarRange("month", month), house.propertyId, capacities)), avg: calendarOccupancySummary(house.entries, rangeDays, [house.propertyId], capacities).percent, occupied: now.occupied, beds: now.beds };
    } else {
      const result = calendarOccupancyDays(house.entries, days, house.propertyId, capacities);
      stats = { strip: result.perDay.map(cell => (cell.beds ? Math.round(cell.occupied / cell.beds * 100) : 0)), avg: result.percent, occupied: now.occupied, beds: now.beds };
    }
    statsCache.set(house.propertyId, stats);
    return stats;
  };

  const empty = !entries.some(entry => propertyIds.includes(entry.propertyId) && entry.start <= (view === "year" ? `${anchor.slice(0, 4)}-12-31` : days.at(-1)!) && (entry.openEnded || entry.end >= days[0]!));
  const noMatches = !!needle && propertyIds.length > 0 && houses.length === 0;

  // ---- Phone: tapping a bar opens a sheet (one for the whole grid) instead of the popover.
  const [sheet, setSheet] = useState<{ entry: PropertyBookingEntry | null; open: boolean }>({ entry: null, open: false });
  const openSheet = useCallback((entry: PropertyBookingEntry) => setSheet({ entry, open: true }), []);
  const closeSheet = useCallback(() => setSheet(current => ({ ...current, open: false })), []);
  const handlers = useMemo<BookingBarHandlers>(() => ({ onEdit: onEditBooking, onUnblock: onUnblockBooking, onDeleteBlock, onUnblockChannelStay, canRemove: canRemoveBooking }), [onEditBooking, onUnblockBooking, onDeleteBlock, onUnblockChannelStay, canRemoveBooking]);
  const openDay = useCallback((day: string) => onOpenDay?.(day), [onOpenDay]);

  const ctx = useMemo<RowContext>(() => ({ meta, view, colPx, trackW, labelPx, todayKey, anchor, focusLabel, scrollLeft, handlers, cleaningKeys, onOpenSheet: phone ? openSheet : undefined, onToggle: toggleHouse, onDrill: drill, onReserveRoomDay }), [meta, view, colPx, trackW, labelPx, scrollLeft, todayKey, anchor, focusLabel, handlers, cleaningKeys, phone, openSheet, toggleHouse, drill, onReserveRoomDay]);
  const houseCount = houses.length;
  const tileValue = "text-[17px] font-semibold leading-6 tabular-nums text-foreground";
  const tileLabel = "truncate text-xs text-muted";

  return <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-3" data-attr="bookings-portfolio-timeline" data-view={view}>
    <div className="flex shrink-0 flex-col gap-2 sm:flex-row sm:items-center">
      <div className="flex min-w-0 items-center gap-1 sm:flex-1">
        <PortalIconAction icon={ChevronLeft} label={`Previous ${view}`} onClick={() => next(-1)} />
        <strong className="min-w-0 truncate px-1 text-[17px] font-semibold leading-6 text-foreground" data-attr="bookings-calendar-title">{rangeTitle}</strong>
        <PortalIconAction icon={ChevronRight} label={`Next ${view}`} onClick={() => next(1)} />
        <span aria-hidden className="min-w-0 flex-1" />
        <button type="button" data-attr="bookings-calendar-today" className="h-11 shrink-0 rounded-full border border-border px-4 text-sm font-semibold text-foreground hover:bg-accent/40 md:h-9" onClick={() => setAnchor(todayKey)}>Today</button>
      </div>
      <div className="flex min-w-0 items-center gap-1 sm:shrink-0">
        <div className="min-w-0 flex-1 sm:w-72 sm:flex-none"><PortalSegmentedControl size="sm" ariaLabel="Calendar period" value={view} onChange={changeView} options={BOOKING_CALENDAR_VIEWS.map(option => ({ id: option, label: option[0]!.toUpperCase() + option.slice(1) }))} /></div>
        {multiIds.length >= 2 ? <PortalIconAction icon={anyCollapsed ? ChevronsUpDown : ChevronsDownUp} label={anyCollapsed ? "Expand all" : "Collapse all"} data-attr="bookings-timeline-expand-all" onClick={toggleAll} /> : null}
      </div>
    </div>
    <div className={`flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-xl border border-border ${OPAQUE}`}>
      {empty || noMatches ? <div data-attr="bookings-empty-houses-banner" className="flex shrink-0 items-center justify-between border-b border-border px-4 py-3 text-sm"><span>{noMatches ? "No matches" : propertyIds.length ? "No bookings in this range" : props.emptyMessage || "No houses yet"}</span>{onAddBooking && !noMatches ? <PortalPrimaryIconAction label="Add booking" onClick={onAddBooking} /> : null}</div> : null}
      <div className="grid shrink-0 grid-cols-4 divide-x divide-border border-b border-border" data-attr="bookings-calendar-summary">
        <div className="flex min-w-0 flex-col items-center py-2"><span className={tileValue}>{kpis.staying}</span><span className={tileLabel}>Staying</span></div>
        <div className="flex min-w-0 flex-col items-center py-2"><span className={tileValue}>{kpis.checkIns}</span><span className={tileLabel}>Check-ins</span></div>
        <div className="flex min-w-0 flex-col items-center py-2"><span className={tileValue}>{kpis.checkOuts}</span><span className={tileLabel}>Check-outs</span></div>
        <div className="flex min-w-0 flex-col items-center py-2"><span className={tileValue}>{kpis.occupied.occupied}/{kpis.occupied.beds}</span><span className={tileLabel}>{focusDay === todayKey ? "Tonight" : dateLabel(focusDay)}</span></div>
      </div>
      <div ref={scrollRef} onScroll={onScroll} className="relative min-h-0 min-w-0 flex-1 overflow-auto overscroll-contain" data-attr="bookings-calendar-scroll">
        <div className="relative pb-2" style={{ width: labelPx + trackW, minWidth: "100%" }}>
          <div className={`sticky top-0 z-30 flex border-b border-border ${OPAQUE}`} style={{ height: 56, width: labelPx + trackW }}>
            <div className={`sticky left-0 z-40 flex shrink-0 items-center border-r border-border px-2 text-xs font-medium text-muted sm:px-3 ${OPAQUE}`} style={{ width: labelPx }}>{houseCount} {houseCount === 1 ? "house" : "houses"}</div>
            <div className="flex" style={{ width: trackW }}>{meta.map(m => <button type="button" key={m.day} data-attr={`portfolio-booking-day-${m.day}`} aria-label={m.openLabel} onClick={() => view === "year" ? drill(m.day) : openDay(m.day)} style={{ width: colPx }} className={`flex flex-none flex-col items-center justify-center gap-1 border-r border-border/50 ${m.today ? "bg-primary/10" : m.weekend ? "bg-muted/5" : ""}`}><span className="text-[11px] uppercase leading-none text-muted">{m.top}</span><strong className={`flex h-6 min-w-6 items-center justify-center rounded-full px-1 text-[15px] font-semibold leading-none ${m.today ? "bg-primary text-white" : "text-foreground"}`}>{m.bottom}</strong></button>)}</div>
          </div>
          {topSpacer ? <div style={{ height: topSpacer }} aria-hidden /> : null}
          {visibleRows.map(row => <TimelineRow key={row.key} row={row} ctx={ctx} stats={row.kind === "house" ? statsFor(row.house) : undefined} expanded={row.kind === "house" ? expandedNow.has(row.house.propertyId) : true} />)}
          {bottomSpacer ? <div style={{ height: bottomSpacer }} aria-hidden /> : null}
        </div>
      </div>
    </div>
    <BookingBarSheet entry={sheet.entry} open={sheet.open} today={todayKey} times={sheet.entry ? entryStayTimes(sheet.entry, houses.find(house => house.propertyId === sheet.entry!.propertyId)?.times) : undefined} onClose={closeSheet} {...handlers} />
  </div>;
}
