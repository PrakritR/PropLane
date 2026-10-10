"use client";

import { Fragment, useMemo, useSyncExternalStore, useState, type ReactNode } from "react";
import { ArrowUpRight, ChevronLeft, ChevronRight, Pencil } from "lucide-react";
import Link from "next/link";
import { BookingsAirbnbIcon } from "@/components/portal/bookings-airbnb-icon";
import { isChannelBookingSource, type PropertyBookingEntry } from "@/lib/channel-calendar/property-bookings";
import { addDaysToDateKey, bookingEntryKey } from "@/lib/channel-calendar/bookings-ui";
import type { OccupancyDayLookup } from "@/lib/channel-calendar/bookings-occupancy";
import { bookingOccupancyCapacities } from "@/lib/channel-calendar/bookings-room-counts";
import { BOOKING_CALENDAR_VIEWS, bookingActiveOn, bookingCheckout, bookingLanes, calendarOccupancy, calendarOccupancySummary, calendarRange, calendarStatus, calendarStatusClass, occupancyCell, type BookingCalendarView } from "@/lib/channel-calendar/bookings-calendar-view";
import { getPropertyById, getRoomOptionsForProperty, parseRoomChoiceValue } from "@/lib/rental-application/data";
import { dateKey } from "@/lib/room-availability-calendar";
import { occupancyStayKind, type OccupancyCapacities } from "@/lib/occupancy/snapshot";
import { roomHeadlinePriceLabel } from "@/lib/room-pricing";
import { bookingRecordHref } from "@/lib/portal-detail-routes";
import { bookingEntryNamedLabel } from "@/lib/channel-calendar/booking-guest-label";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { PortalIconAction, PortalPrimaryIconAction } from "@/components/portal/portal-icon-action";
import { FieldSingleSelect } from "@/components/ui/checkbox-multi-select";

export type BookingsPortfolioTimelineProps = {
  propertyIds: string[];
  entries: PropertyBookingEntry[];
  today: Date;
  onOpenDay?: (dayKey: string) => void;
  occupancyDays?: OccupancyDayLookup;
  emptyMessage?: string;
  onAddBooking?: () => void;
  onEditBooking?: (entry: PropertyBookingEntry) => void;
  /** Click on an empty room-day (today or later) - opens Mark reserved for that room and night. */
  onReserveRoomDay?: (target: { propertyId: string; roomId: string; dayKey: string }) => void;
  /** Explicit page scope, so filtering the workspace never changes its preference. */
  preferenceKey?: string;
  roomFilterId?: string;
};
const subscribe = (notify: () => void) => { window.addEventListener("resize", notify); window.addEventListener("storage", notify); return () => { window.removeEventListener("resize", notify); window.removeEventListener("storage", notify); }; };
const dateLabel = (key: string, options: Intl.DateTimeFormatOptions = { month: "short", day: "numeric" }) => new Date(`${key}T12:00:00`).toLocaleDateString("en-US", options);
const dayDiff = (a: string, b: string) => Math.round((Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86400000);

/**
 * The bookable rows of one property: a row per saved room (the room picker's
 * list, so a blank name reads "Room n"), else booked rooms, else the whole home.
 */
export function propertyRooms(propertyId: string, entries: PropertyBookingEntry[]) {
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
  if (!seen.size) for (const entry of entries) seen.set(entry.roomId, { id: entry.roomId, label: entry.roomLabel, rent: "" });
  if (!seen.size) seen.set("", { id: "", label: "Whole home", rent: "" });
  return [...seen.values()];
}
/** The calendar's colour key: one quiet row, colour dot + name, drawn under the calendar itself. */
export function BookingsCalendarLegend() {
  return <ul className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-1 px-1 pt-2 text-xs text-muted" data-attr="bookings-calendar-legend" aria-label="Calendar colours">{["Hold", "Confirmed", "In-house", "Checked out", "Airbnb"].map(status => <li key={status} className="flex items-center gap-1.5"><span aria-hidden className={`h-2.5 w-2.5 rounded-full ${calendarStatusClass(status)}`} />{status === "Airbnb" ? "Airbnb / Booking.com" : status}</li>)}</ul>;
}
function BookingBar({ entry, today, children, className, style, onEdit }: { entry: PropertyBookingEntry; today: string; children?: ReactNode; className?: string; style?: React.CSSProperties; onEdit?: (entry: PropertyBookingEntry) => void }) {
  const status = calendarStatus(entry, today);
  const checkout = bookingCheckout(entry);
  const barLabel = entry.residentName || bookingEntryNamedLabel(entry) || entry.summary;
  return <DropdownMenu><DropdownMenuTrigger asChild><button type="button" style={style} className={`rounded-lg px-2 py-1 text-left text-xs ${calendarStatusClass(status)} ${className ?? ""}`} data-attr="bookings-calendar-bar" aria-label={`${barLabel}, ${status}`}>
    <span className="block truncate font-semibold">{entry.source === "airbnb" ? <BookingsAirbnbIcon aria-label="Airbnb" role="img" className="mr-1 inline h-3 w-3" strokeWidth={1.7} /> : entry.source === "booking_com" ? "B · " : entry.source === "vrbo" ? "V · " : ""}{barLabel}</span>{children}
  </button></DropdownMenuTrigger><DropdownMenuContent align="start" className="max-w-[calc(100vw-2rem)]">
    <div className="grid gap-2 p-3 text-sm"><strong>{barLabel}</strong><span>{dateLabel(entry.start)} – {checkout ? dateLabel(checkout) : "Open-ended"}</span><span>{entry.roomLabel || "Whole home"}</span><span>{status}</span></div>
    {onEdit && !isChannelBookingSource(entry.source) ? <DropdownMenuItem onSelect={() => onEdit(entry)}><Pencil />Edit</DropdownMenuItem> : null}
    <DropdownMenuItem asChild><Link href={bookingRecordHref("/portal", bookingEntryKey(entry))}><ArrowUpRight />Open booking</Link></DropdownMenuItem>
  </DropdownMenuContent></DropdownMenu>;
}

/**
 * `bedsTotal` / `roomCapacity` both re-enter `getPropertyById`, which reads the
 * listing store. One cache per computation turns a lookup per property-day — a
 * year view is ~365 days — into one lookup per property.
 */
function cachedOccupancyCapacities(): OccupancyCapacities {
  const beds = new Map<string, number>();
  const rooms = new Map<string, number>();
  return {
    bedsTotal: propertyId => {
      let value = beds.get(propertyId);
      if (value === undefined) { value = bookingOccupancyCapacities.bedsTotal(propertyId); beds.set(propertyId, value); }
      return value;
    },
    roomCapacity: (propertyId, roomId) => {
      const key = `${propertyId}\u0000${roomId}`;
      let value = rooms.get(key);
      if (value === undefined) { value = bookingOccupancyCapacities.roomCapacity(propertyId, roomId); rooms.set(key, value); }
      return value;
    },
  };
}

export function BookingsPortfolioTimeline(props: BookingsPortfolioTimelineProps) {
  const { propertyIds, today, onEditBooking, onAddBooking, onReserveRoomDay, roomFilterId } = props;
  const entries = useMemo(() => props.entries.filter(entry => entry.bookingStatus !== "cancelled" && entry.statusLabel?.toLowerCase() !== "cancelled"), [props.entries]);
  const scope = `proplane:bookings-calendar:${props.preferenceKey ?? "workspace"}`;
  const savedView = useSyncExternalStore(subscribe, () => { try { const saved = localStorage.getItem(scope); if (BOOKING_CALENDAR_VIEWS.includes(saved as BookingCalendarView)) return saved as BookingCalendarView; } catch {} return window.innerWidth < 640 ? "week" : "month"; }, () => "month" as BookingCalendarView);
  const guests = useMemo(() => entries.filter(entry => entry.bookingStatus === "confirmed" || ["lease", "guest"].includes(occupancyStayKind(entry))), [entries]);
  const [chosenView, setChosenView] = useState<{ scope: string; view: BookingCalendarView } | null>(null);
  const view = chosenView?.scope === scope ? chosenView.view : savedView;
  const [anchor, setAnchor] = useState(() => dateKey(today));
  const changeView = (value: BookingCalendarView) => { setChosenView({ scope, view: value }); try { localStorage.setItem(scope, value); } catch {} };
  const days = useMemo(() => calendarRange(view, anchor), [view, anchor]);
  const todayKey = dateKey(today);
  const next = (direction: number) => { if (view === "week" || view === "day") setAnchor(addDaysToDateKey(anchor, direction * (view === "week" ? 7 : 1))); else { const d = new Date(`${anchor}T12:00:00`); setAnchor(dateKey(new Date(d.getFullYear() + (view === "year" ? direction : 0), d.getMonth() + (view === "month" ? direction : 0), 1))); } };
  const drill = (day: string) => { setAnchor(day); changeView("month"); };
  const rangeTitle = view === "year" ? anchor.slice(0,4) : view === "month" ? dateLabel(anchor, { month: "long", year: "numeric" }) : view === "day" ? dateLabel(anchor, { weekday: "short", month: "short", day: "numeric" }) : `${dateLabel(days[0]!)} – ${dateLabel(days.at(-1)!)}`;
  const empty = !entries.some(entry => propertyIds.includes(entry.propertyId) && entry.start <= (view === "year" ? `${anchor.slice(0,4)}-12-31` : days.at(-1)!) && (entry.openEnded || entry.end >= days[0]!));
  const colWidth = view === "week" ? 90 : view === "month" ? 32 : view === "year" ? 70 : 320;
  const labelClass = "sticky left-0 z-10 flex w-36 shrink-0 flex-col justify-center border-b border-r border-border bg-card px-3 py-2 text-xs sm:w-48";
  const gridStyle = { display: "grid", gridTemplateColumns: `repeat(${days.length}, minmax(0, 1fr))` };
  // Year expands to every day of every month, so the figures below are memoized on
  // the data and the range: a resize or a view-preference read never recomputes them.
  const rangeDays = useMemo(() => view === "year" ? days.flatMap(month => calendarRange("month", month)) : days, [view, days]);
  // The range's figures, read through occupancyForDay (never a rooms.length count): who is staying,
  // arriving and leaving across the visible days, and how full the scoped houses are.
  const summaryParts = useMemo(() => {
    const rangeFirst = rangeDays[0]!, rangeLast = rangeDays.at(-1)!;
    const scoped = guests.filter(entry => propertyIds.includes(entry.propertyId));
    const staying = scoped.filter(entry => rangeDays.some(day => bookingActiveOn(entry, day))).length;
    const checkIns = scoped.filter(entry => entry.start >= rangeFirst && entry.start <= rangeLast).length;
    const checkOuts = scoped.filter(entry => { const out = bookingCheckout(entry); return out !== null && out >= rangeFirst && out <= rangeLast; }).length;
    const portfolio = calendarOccupancySummary(entries, rangeDays, propertyIds, cachedOccupancyCapacities());
    return [`${staying} staying · ${checkIns} check-ins · ${checkOuts} check-outs`, `${portfolio.peak} of ${portfolio.beds} occupied · ${portfolio.percent}%`];
  }, [entries, guests, propertyIds, rangeDays]);
  const bands = useMemo(() => {
    const capacities = cachedOccupancyCapacities();
    return new Map(propertyIds.map(propertyId => [propertyId, calendarOccupancySummary(entries.filter(entry => entry.propertyId === propertyId), rangeDays, [propertyId], capacities)] as const));
  }, [entries, propertyIds, rangeDays]);
  const capacities = cachedOccupancyCapacities();
  const roomEntries = (mine: PropertyBookingEntry[], roomId: string) => mine.filter(entry => !entry.roomId || entry.roomId === roomId);
  return <div className="flex min-w-0 flex-col gap-3" data-attr="bookings-portfolio-timeline" data-view={view}>
    <div className="flex flex-wrap items-center gap-2"><PortalIconAction icon={ChevronLeft} label={`Previous ${view}`} onClick={() => next(-1)} /><PortalIconAction icon={ChevronRight} label={`Next ${view}`} onClick={() => next(1)} /><strong className="text-sm">{rangeTitle}</strong><button type="button" className="rounded-full border border-border px-3 py-1 text-sm" onClick={() => setAnchor(todayKey)}>Today</button><FieldSingleSelect label="Calendar view" value={view} onChange={(next) => changeView(next as BookingCalendarView)} options={BOOKING_CALENDAR_VIEWS.map((option) => ({ value: option, label: option[0]!.toUpperCase() + option.slice(1) }))} /></div>
    <div className="min-w-0 overflow-hidden rounded-xl border border-border bg-card">
      {empty ? <div data-attr="bookings-empty-houses-banner" className="flex items-center justify-between border-b border-border px-4 py-3 text-sm"><span>{propertyIds.length ? "No bookings in this range" : props.emptyMessage || "No houses yet"}</span>{onAddBooking ? <PortalPrimaryIconAction label="Add booking" onClick={onAddBooking} /> : null}</div> : null}
      <div className="max-w-full overflow-x-auto" data-attr="bookings-calendar-scroll"><div style={{ minWidth: `calc(9rem + ${days.length * colWidth}px)` }}>
        <div className="flex"><div className={labelClass}>Room</div><div className="flex-1 border-b border-border" style={gridStyle}>{days.map(day => <button type="button" key={day} data-attr={`portfolio-booking-day-${day}`} aria-label={`Open ${dateLabel(day, { weekday: "long", month: "long", day: "numeric" })}`} onClick={() => view === "year" ? drill(day) : props.onOpenDay?.(day)} className={`flex min-h-14 flex-col items-center justify-center gap-1 text-xs ${day === todayKey ? "bg-primary/10" : [0,6].includes(new Date(`${day}T12:00:00`).getDay()) ? "bg-muted/5" : ""}`}><span className="text-[10px] uppercase text-muted">{dateLabel(day, view === "year" ? { year: "numeric" } : { weekday: "short" })}</span><strong className={`flex h-6 min-w-6 items-center justify-center rounded-full ${day === todayKey ? "bg-primary text-white" : ""}`}>{dateLabel(day, view === "year" ? { month: "short" } : { day: "numeric" })}</strong></button>)}</div></div>
        <div className="sticky left-0 flex max-w-[calc(100vw-4rem)] flex-wrap gap-x-3 gap-y-1 border-b border-border p-3 text-sm" data-attr="bookings-calendar-summary">{summaryParts.map(part => <span key={part}>{part}</span>)}</div>
        {propertyIds.map(propertyId => {
          const mine = entries.filter(entry => entry.propertyId === propertyId);
          const property = getPropertyById(propertyId);
          const allRooms = propertyRooms(propertyId, mine);
          const rooms = allRooms.filter(room => !roomFilterId || room.id === roomFilterId);
          const propertyName = mine[0]?.propertyLabel || property?.title || "Untitled listing";
          // A whole home (one bookable row) is a single row under its own name: no separate
          // property strip above a "Whole home" row that repeats it. Read from the house's own
          // rooms, never the filtered list: narrowing to one room of a multi-room house does not
          // turn that house into a whole home.
          const single = allRooms.length === 1;
          const band = bands.get(propertyId)!;
          return <Fragment key={propertyId}>{single ? null : <><div className="flex" data-attr={`bookings-timeline-property-${propertyId}`}><div className={`${labelClass} bg-accent/30 font-semibold`} title={property?.address}><span>{propertyName}</span><span className="font-normal text-muted" data-attr="bookings-property-occupied">{band.peak} of {band.beds} occupied · {band.percent}%</span></div><div className="flex-1 border-b border-border" style={gridStyle}>{days.map(day => { const percent = calendarOccupancy(mine, view === "year" ? calendarRange("month", day) : [day], propertyId, capacities); return <div key={day} title={`${percent}% occupied`} className="flex min-h-9 items-center px-px"><div className="h-1.5 w-full rounded" style={{ backgroundColor: `rgba(40,99,240,${percent ? .1 + .8 * percent / 100 : .03})` }} /></div>; })}</div></div></>}
          {rooms.map(room => { const all = roomEntries(mine, room.id); const visible = all.filter(entry => entry.start <= days.at(-1)! && (entry.openEnded || entry.end >= days[0]!)); const lanes = bookingLanes(visible); const capacity = capacities.roomCapacity(propertyId, room.id); return <div className="flex" key={room.id} data-attr={single ? `bookings-timeline-property-${propertyId}` : undefined}><div className={labelClass} title={property?.address}><span className="font-semibold">{single ? propertyName : room.label}</span>{single && room.label && room.label !== "Whole home" && room.label !== propertyName ? <span className="text-muted">{room.label}</span> : null}{room.rent ? <span className="text-muted">{room.rent}</span> : null}</div><div className="relative flex-1 border-b border-border" style={{ minHeight: Math.max(62, 18 + (Math.max(0,...lanes.map(row => row.lane)) + 1) * 34) }}>
          {view === "year" ? <div style={gridStyle}>{days.map(month => { const percent = calendarOccupancy(all, calendarRange("month", month), propertyId, { bedsTotal: () => capacity, roomCapacity: () => capacity }); return <button type="button" key={month} onClick={() => drill(month)} title={`${room.label} · ${dateLabel(month, { month: "long" })}: ${percent}% occupied`} className="min-h-16 border-r border-border text-xs font-semibold" style={{ backgroundColor: `rgba(40,99,240,${percent ? .1 + .75 * percent / 100 : 0})` }}>{percent ? `${percent}%` : ""}</button>; })}</div> : view === "day" ? <div className="flex min-h-16 gap-2 p-2">{all.filter(entry => bookingActiveOn(entry, anchor) || bookingCheckout(entry) === anchor).map(entry => <BookingBar key={bookingEntryKey(entry)} entry={entry} today={todayKey} onEdit={onEditBooking} className="min-w-0 flex-1"><span className="block text-[11px]">{bookingCheckout(entry) === anchor ? "Checks out today" : entry.start === anchor ? "Checks in today" : `Night ${dayDiff(anchor, entry.start) + 1}${entry.openEnded ? " · open-ended" : ` of ${dayDiff(bookingCheckout(entry)!, entry.start)}`}`}</span></BookingBar>)}{!all.some(entry => bookingActiveOn(entry, anchor) || bookingCheckout(entry) === anchor) ? <span className="p-2 text-xs text-muted">Vacant</span> : null}</div> : <><div className="absolute inset-0" style={gridStyle}>{days.map(day => { const cellClass = `border-r border-border/40 ${day === todayKey ? "bg-primary/10" : [0,6].includes(new Date(`${day}T12:00:00`).getDay()) ? "bg-muted/5" : ""}`; const free = !!onReserveRoomDay && day >= todayKey && !all.some(entry => bookingActiveOn(entry, day)); return free ? <button type="button" key={day} className={`${cellClass} hover:bg-primary/10 focus-visible:bg-primary/10`} data-attr="bookings-calendar-empty-cell" data-day={day} data-room={room.id} aria-label={`Mark ${single ? propertyName : room.label} reserved on ${dateLabel(day, { weekday: "long", month: "long", day: "numeric" })}`} onClick={() => onReserveRoomDay({ propertyId, roomId: room.id, dayKey: day })} /> : <div key={day} className={cellClass} />; })}</div>{lanes.map(({entry,lane}) => { const start = Math.max(0, dayDiff(entry.start, days[0]!)); const end = entry.openEnded ? days.length : Math.min(days.length, dayDiff(bookingCheckout(entry)!, days[0]!)); const conflict = days.some(day => bookingActiveOn(entry, day) && occupancyCell(all, day, capacity).conflicts); return <BookingBar key={bookingEntryKey(entry)} entry={entry} today={todayKey} onEdit={onEditBooking} className={`absolute h-8 overflow-hidden ${conflict ? "ring-2 ring-red-500" : ""}`} style={{ top: 9 + lane * 34, left: `calc(${start / days.length * 100}% + 2px)`, width: `calc(${(end-start) / days.length * 100}% - 4px)` }} />; })}</>}
          </div></div>; })}</Fragment>;
        })}
      </div></div>
    </div>
  </div>;
}
