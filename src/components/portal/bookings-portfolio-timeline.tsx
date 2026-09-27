"use client";

import { Fragment, useMemo, useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import Link from "next/link";
import {
  bookingVisualSource,
  type PropertyBookingEntry,
} from "@/lib/channel-calendar/property-bookings";
import { bookingSourceDotClass, formatBookingStayRange } from "@/lib/channel-calendar/bookings-ui";
import {
  dayOccupancy,
  dayOccupancyFromLookup,
  type OccupancyDayLookup,
} from "@/lib/channel-calendar/bookings-occupancy";
import { bookingOccupancyCapacities } from "@/lib/channel-calendar/bookings-room-counts";
import { getPropertyById, getRoomOptionsForProperty, parseRoomChoiceValue } from "@/lib/rental-application/data";
import { usePortalSurface } from "@/components/ui/portal-surface";
import { addDays, dateKey, startOfLocalDay } from "@/lib/room-availability-calendar";

/**
 * All-properties Timeline — replaces the old Day/Week/Month/Year grid for the
 * portfolio Calendar tab (BUILD-WAVE2 C257). Every property is a sticky group
 * header with its rooms beneath, sharing one scrollable date axis and a today
 * line, so scrolling through many rooms never loses which house they belong
 * to — the regression the captain flagged in the old grid.
 */

/** A fixed three-week window keeps the axis a stable, scrollable width. */
const TIMELINE_WINDOW_DAYS = 21;
/** Today sits a few columns in from the left edge, never flush against it. */
const TIMELINE_TODAY_OFFSET_DAYS = 4;

type TimelineRoomRow = { id: string; label: string };

type TimelineProperty = {
  propertyId: string;
  label: string;
  entries: PropertyBookingEntry[];
  rooms: TimelineRoomRow[];
};

export type BookingsPortfolioTimelineProps = {
  /** Every property in scope, including ones with zero bookings. */
  propertyIds: string[];
  entries: PropertyBookingEntry[];
  today: Date;
  onOpenDay: (dayKey: string) => void;
  occupancyDays?: OccupancyDayLookup;
  emptyMessage?: string;
};

function propertyLabelFallback(propertyId: string): string {
  const property = getPropertyById(propertyId);
  if (!property) return propertyId;
  const buildingUnit = property.buildingName && property.unitLabel
    ? `${property.buildingName} · ${property.unitLabel}`
    : "";
  const candidates = [buildingUnit, property.title, property.address];
  const found = candidates.find((candidate) => candidate.trim());
  return found?.trim() || propertyId;
}

/** Prefer a label an entry already resolved; only fall back for a house with no bookings. */
function propertyLabelFor(propertyId: string, propertyEntries: readonly PropertyBookingEntry[]): string {
  return propertyEntries[0]?.propertyLabel?.trim() || propertyLabelFallback(propertyId);
}

/**
 * A property's room rows: the declared listing rooms when there are any (so
 * an empty house still shows its rooms), else the distinct rooms its own
 * bookings name, else one "Whole home" placeholder row.
 */
function roomRowsForProperty(
  propertyId: string,
  propertyEntries: readonly PropertyBookingEntry[],
): TimelineRoomRow[] {
  const declared = getRoomOptionsForProperty(propertyId);
  if (declared.length > 0) {
    return declared.map((option) => ({
      id: parseRoomChoiceValue(option.value).listingRoomId ?? "",
      label: option.label,
    }));
  }
  const seen = new Map<string, string>();
  for (const entry of propertyEntries) {
    if (!entry.roomId || seen.has(entry.roomId)) continue;
    seen.set(entry.roomId, entry.roomLabel || entry.roomId);
  }
  if (seen.size > 0) {
    return [...seen.entries()].map(([id, label]) => ({ id, label }));
  }
  return [{ id: "", label: "Whole home" }];
}

function formatWeekdayLabel(d: Date): string {
  return d.toLocaleDateString("en-US", { weekday: "short" }).slice(0, 2);
}

function formatWeekdayMonthDay(d: Date): string {
  return d.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" });
}

function formatMonthDay(d: Date): string {
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function formatMonthDayYear(d: Date): string {
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

/** Occupied/total for one day, across `propertyIds` — the snapshot lookup when there is one, else computed. */
function dayStatsFor(
  entries: readonly PropertyBookingEntry[],
  occupancyDays: OccupancyDayLookup | undefined,
  dayKey: string,
  propertyIds: readonly string[],
) {
  return dayOccupancyFromLookup(occupancyDays, dayKey, propertyIds, () =>
    dayOccupancy(entries, dayKey, propertyIds, bookingOccupancyCapacities),
  );
}

/** Clip an inclusive start/end range to the visible window; null when it never intersects. */
function clipToWindow(
  entry: Pick<PropertyBookingEntry, "start" | "end">,
  windowKeys: readonly string[],
): { startIndex: number; endIndex: number } | null {
  const first = windowKeys[0];
  const last = windowKeys[windowKeys.length - 1];
  if (first === undefined || last === undefined || entry.end < first || entry.start > last) return null;
  let startIndex = 0;
  while (startIndex < windowKeys.length && windowKeys[startIndex]! < entry.start) startIndex += 1;
  let endIndex = windowKeys.length - 1;
  while (endIndex >= 0 && windowKeys[endIndex]! > entry.end) endIndex -= 1;
  if (startIndex > endIndex) return null;
  return { startIndex, endIndex };
}

const TIMELINE_NAV_BUTTON =
  "flex h-8 shrink-0 items-center justify-center rounded-full border border-border bg-card px-3 text-xs font-semibold text-muted shadow-[var(--shadow-sm)] transition hover:border-primary/45 hover:text-foreground";

export function BookingsPortfolioTimeline({
  propertyIds,
  entries,
  today,
  onOpenDay,
  occupancyDays,
  emptyMessage,
}: BookingsPortfolioTimelineProps) {
  // Same pointer/room decision every popup in the portal uses (portal-surface.ts)
  // — a "sheet" answer is the narrow-viewport shape, reused here as the phone
  // stacked layout instead of the desktop shared axis.
  const isPhone = usePortalSurface("toolbar") === "sheet";
  const normalizedToday = useMemo(() => startOfLocalDay(today), [today]);

  const [windowStart, setWindowStart] = useState(() => addDays(normalizedToday, -TIMELINE_TODAY_OFFSET_DAYS));

  const windowDays = useMemo(
    () => Array.from({ length: TIMELINE_WINDOW_DAYS }, (_, index) => addDays(windowStart, index)),
    [windowStart],
  );
  const windowKeys = useMemo(() => windowDays.map(dateKey), [windowDays]);
  const todayKey = dateKey(normalizedToday);
  const todayIndex = windowKeys.indexOf(todayKey);

  const entriesByProperty = useMemo(() => {
    const map = new Map<string, PropertyBookingEntry[]>();
    for (const entry of entries) {
      const list = map.get(entry.propertyId);
      if (list) list.push(entry);
      else map.set(entry.propertyId, [entry]);
    }
    return map;
  }, [entries]);

  const properties = useMemo<TimelineProperty[]>(
    () =>
      propertyIds.map((propertyId) => {
        const propertyEntries = entriesByProperty.get(propertyId) ?? [];
        return {
          propertyId,
          label: propertyLabelFor(propertyId, propertyEntries),
          entries: propertyEntries,
          rooms: roomRowsForProperty(propertyId, propertyEntries),
        };
      }),
    [propertyIds, entriesByProperty],
  );

  const emptyPortfolio = propertyIds.length === 0;
  const first = windowDays[0];
  const last = windowDays[windowDays.length - 1];
  const windowLabel = first && last ? `${formatMonthDay(first)} – ${formatMonthDayYear(last)}` : "";

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3" data-attr="bookings-portfolio-timeline">
      <div className="flex shrink-0 items-center justify-between gap-2">
        <button
          type="button"
          aria-label="Previous week"
          data-attr="bookings-timeline-prev"
          className={TIMELINE_NAV_BUTTON}
          onClick={() => setWindowStart((current) => addDays(current, -7))}
        >
          <ChevronLeft className="h-4 w-4" aria-hidden />
        </button>
        <div className="min-w-0 flex-1 text-center">
          <p className="truncate text-sm font-semibold text-foreground">{windowLabel}</p>
        </div>
        <button
          type="button"
          data-attr="bookings-timeline-today"
          className={TIMELINE_NAV_BUTTON}
          onClick={() => setWindowStart(addDays(normalizedToday, -TIMELINE_TODAY_OFFSET_DAYS))}
        >
          Today
        </button>
        <button
          type="button"
          aria-label="Next week"
          data-attr="bookings-timeline-next"
          className={TIMELINE_NAV_BUTTON}
          onClick={() => setWindowStart((current) => addDays(current, 7))}
        >
          <ChevronRight className="h-4 w-4" aria-hidden />
        </button>
      </div>

      {emptyPortfolio ? (
        <div
          className="flex items-center justify-between gap-3 rounded-xl border border-border bg-card px-3 py-2.5"
          data-attr="bookings-empty-houses-banner"
        >
          <p className="text-sm font-semibold text-foreground">{emptyMessage ?? "No houses yet"}</p>
          <Link
            href="/portal/properties"
            className="inline-flex h-9 shrink-0 items-center rounded-full border border-border bg-card px-3 text-sm font-semibold"
            data-attr="bookings-empty-add-property"
          >
            Add property
          </Link>
        </div>
      ) : null}

      {isPhone ? (
        <PhonePropertyStack
          properties={properties}
          entries={entries}
          windowDays={windowDays}
          windowKeys={windowKeys}
          todayKey={todayKey}
          occupancyDays={occupancyDays}
          onOpenDay={onOpenDay}
        />
      ) : (
        <DesktopTimelineGrid
          properties={properties}
          propertyIds={propertyIds}
          entries={entries}
          windowDays={windowDays}
          windowKeys={windowKeys}
          todayIndex={todayIndex}
          occupancyDays={occupancyDays}
          onOpenDay={onOpenDay}
        />
      )}
    </div>
  );
}

function DesktopTimelineGrid({
  properties,
  propertyIds,
  entries,
  windowDays,
  windowKeys,
  todayIndex,
  occupancyDays,
  onOpenDay,
}: {
  properties: TimelineProperty[];
  propertyIds: readonly string[];
  entries: readonly PropertyBookingEntry[];
  windowDays: Date[];
  windowKeys: string[];
  todayIndex: number;
  occupancyDays?: OccupancyDayLookup;
  onOpenDay: (dayKey: string) => void;
}) {
  const gridTemplateColumns = `10rem repeat(${TIMELINE_WINDOW_DAYS}, minmax(2.5rem, 1fr))`;

  return (
    <div
      className="relative min-h-0 flex-1 overflow-auto rounded-xl border border-border"
      data-attr="bookings-timeline-desktop-grid"
    >
      <div className="grid" style={{ gridTemplateColumns }}>
        <div className="sticky left-0 top-0 z-30 border-b border-r border-border bg-card" aria-hidden />
        {windowDays.map((day, index) => {
          const key = windowKeys[index]!;
          const stats = dayStatsFor(entries, occupancyDays, key, propertyIds);
          const isToday = index === todayIndex;
          return (
            <button
              key={key}
              type="button"
              data-attr={`portfolio-booking-day-${key}`}
              aria-label={`Open ${formatWeekdayMonthDay(day)}`}
              className={`sticky top-0 z-20 flex flex-col items-center justify-center gap-0.5 border-b border-border bg-card py-1.5 text-[10px] font-semibold transition hover:bg-accent/25 ${
                isToday ? "text-primary" : "text-muted"
              }`}
              onClick={() => onOpenDay(key)}
            >
              <span className="uppercase tracking-wide">{formatWeekdayLabel(day)}</span>
              <span className="text-xs tabular-nums text-foreground">{day.getDate()}</span>
              {stats.rooms > 0 ? <span className="tabular-nums">{stats.occupied}/{stats.rooms}</span> : null}
            </button>
          );
        })}

        {properties.map((property) => (
          <PropertyRows key={property.propertyId} property={property} windowKeys={windowKeys} todayIndex={todayIndex} />
        ))}
      </div>
    </div>
  );
}

function PropertyRows({
  property,
  windowKeys,
  todayIndex,
}: {
  property: TimelineProperty;
  windowKeys: string[];
  todayIndex: number;
}) {
  return (
    <Fragment>
      {/* Sticky group header — the fix for losing property grouping while scrolling (BUILD-WAVE2 C257). */}
      <div
        className="sticky top-9 z-10 border-b border-border bg-muted/60"
        style={{ gridColumn: "1 / -1" }}
        data-attr={`bookings-timeline-property-${property.propertyId}`}
      >
        <span className="sticky left-0 inline-block max-w-full truncate bg-inherit px-3 py-1.5 text-sm font-semibold text-foreground">
          {property.label}
        </span>
      </div>
      {property.rooms.map((room) => (
        <RoomRow
          key={room.id || "whole-home"}
          property={property}
          room={room}
          windowKeys={windowKeys}
          todayIndex={todayIndex}
        />
      ))}
    </Fragment>
  );
}

function RoomRow({
  property,
  room,
  windowKeys,
  todayIndex,
}: {
  property: TimelineProperty;
  room: TimelineRoomRow;
  windowKeys: string[];
  todayIndex: number;
}) {
  const bars = property.entries
    .filter((entry) => entry.roomId === room.id || entry.roomId === "")
    .map((entry) => {
      const clipped = clipToWindow(entry, windowKeys);
      if (!clipped) return null;
      const left = (clipped.startIndex / TIMELINE_WINDOW_DAYS) * 100;
      const width = ((clipped.endIndex - clipped.startIndex + 1) / TIMELINE_WINDOW_DAYS) * 100;
      return { entry, left, width };
    })
    .filter((bar): bar is { entry: PropertyBookingEntry; left: number; width: number } => bar !== null);

  return (
    <Fragment>
      {/* Sticky left label — stays put while the date axis scrolls horizontally. */}
      <div className="sticky left-0 z-10 truncate border-b border-r border-border bg-card px-3 py-2 text-xs font-medium text-muted">
        {room.label}
      </div>
      <div
        className="relative border-b border-border"
        style={{ gridColumn: "2 / -1" }}
        data-attr={`bookings-timeline-room-${property.propertyId}-${room.id || "whole"}`}
      >
        {todayIndex >= 0 ? (
          <div
            aria-hidden
            className="pointer-events-none absolute inset-y-0 w-px bg-primary/60"
            style={{ left: `${(todayIndex / TIMELINE_WINDOW_DAYS) * 100}%` }}
          />
        ) : null}
        <div className="relative h-9">
          {bars.map(({ entry, left, width }, index) => (
            <div
              key={`${entry.source}-${entry.roomId}-${entry.start}-${entry.end}-${index}`}
              title={`${formatBookingStayRange(entry.start, entry.end, entry.openEnded)} — ${entry.summary}`}
              className={`absolute inset-y-1 overflow-hidden rounded-md px-1.5 text-[10px] font-medium leading-9 text-white ${bookingSourceDotClass(
                bookingVisualSource(entry),
              )}`}
              style={{ left: `${left}%`, width: `${width}%` }}
            >
              <span className="truncate">{entry.summary}</span>
            </div>
          ))}
        </div>
      </div>
    </Fragment>
  );
}

function PhonePropertyStack({
  properties,
  entries,
  windowDays,
  windowKeys,
  todayKey,
  occupancyDays,
  onOpenDay,
}: {
  properties: TimelineProperty[];
  entries: readonly PropertyBookingEntry[];
  windowDays: Date[];
  windowKeys: string[];
  todayKey: string;
  occupancyDays?: OccupancyDayLookup;
  onOpenDay: (dayKey: string) => void;
}) {
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto" data-attr="bookings-timeline-phone-stack">
      {properties.map((property) => (
        <section
          key={property.propertyId}
          className="rounded-xl border border-border bg-card/90 p-3"
          data-attr={`bookings-timeline-property-${property.propertyId}`}
        >
          <p className="truncate text-sm font-semibold text-foreground">{property.label}</p>
          <div className="mt-2 flex gap-1 overflow-x-auto pb-1">
            {windowDays.map((day, index) => {
              const key = windowKeys[index]!;
              const stats = dayStatsFor(entries, occupancyDays, key, [property.propertyId]);
              const isToday = key === todayKey;
              return (
                <button
                  key={key}
                  type="button"
                  data-attr={`portfolio-booking-day-${key}`}
                  aria-label={`Open ${formatWeekdayMonthDay(day)} for ${property.label}`}
                  className={`flex h-12 w-9 shrink-0 flex-col items-center justify-center gap-0.5 rounded-lg border text-[10px] font-semibold transition ${
                    isToday ? "border-primary text-primary" : "border-border/80 text-muted"
                  }`}
                  onClick={() => onOpenDay(key)}
                >
                  <span className="tabular-nums text-foreground">{day.getDate()}</span>
                  {stats.rooms > 0 ? <span className="tabular-nums">{stats.occupied}/{stats.rooms}</span> : null}
                </button>
              );
            })}
          </div>
          {property.rooms.length > 0 ? (
            <ul className="mt-2 flex flex-wrap gap-1">
              {property.rooms.map((room) => (
                <li
                  key={room.id || "whole-home"}
                  className="rounded-full border border-border/70 px-2 py-0.5 text-[11px] text-muted"
                >
                  {room.label}
                </li>
              ))}
            </ul>
          ) : null}
        </section>
      ))}
    </div>
  );
}
