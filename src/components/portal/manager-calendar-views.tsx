"use client";

/**
 * The manager Calendar's Week / Day time grid, Month grid, Agenda list and the
 * Day side panel (studio-redesign-0929: C2-CALP2 to CALP6, CALA4 to CALA6).
 *
 * These are presentation components: `PortalCalendarPanels` still owns the
 * data (meetings, painted availability, the dialogs) and hands in plain
 * items, bands and callbacks. Geometry lives in `src/lib/calendar-grid.ts`.
 */
import { useEffect, useRef, useState, type CSSProperties, type MouseEvent, type ReactNode } from "react";
import {
  CalendarOff,
  ClipboardCheck,
  Clock,
  DoorOpen,
  ListChecks,
  MoreHorizontal,
  Wrench,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import type { DemoMeeting } from "@/components/portal/portal-calendar-panels";
import { meetingCalendarGridLabel } from "@/lib/google-calendar/meetings";
import { compactTaskPropertyLabel } from "@/lib/manager-task-display";
import { PortalPropertyRecordRow, PortalRowFact } from "@/components/portal/portal-record-row";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { RECORD_ACTION_TRIGGER_BUTTON_CLASS, RECORD_ACTION_TRIGGER_ICON_CLASS } from "@/components/ui/record-action-menu";
import {
  CALENDAR_KIND_COLOR,
  CALENDAR_KIND_LABEL,
  GRID_HOUR_PX,
  GRID_MIN_BLOCK_PX,
  bandKindsLabel,
  bandPaint,
  bandStyle,
  calendarItemKind,
  formatClock,
  formatClockRange,
  layoutDayEvents,
  legendKinds,
  minutesAtOffset,
  snapDragRange,
  type CalendarItemKind,
  type GridBand,
  type GridWindow,
} from "@/lib/calendar-grid";
import { shiftDateStr, weekdayOfDateStr } from "@/lib/calendar-availability-window";

const KIND_ICON: Record<CalendarItemKind, LucideIcon> = {
  tour: DoorOpen,
  service: Wrench,
  task: ListChecks,
  inspection: ClipboardCheck,
  busy: CalendarOff,
};

const DOW_SHORT = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const DOW_LONG = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** `Mon, Oct 5` for a `YYYY-MM-DD` — the label the empty-week jump and Agenda headers use. */
export function dayLabel(dateStr: string, withWeekday = true): string {
  const [, m, d] = dateStr.split("-");
  const weekday = DOW_SHORT[weekdayOfDateStr(dateStr)] ?? "";
  const text = `${MONTHS[Number(m) - 1] ?? ""} ${Number(d)}`;
  return withWeekday ? `${weekday}, ${text}` : text;
}

function kindStyle(kind: CalendarItemKind): CSSProperties {
  return { ["--k" as string]: CALENDAR_KIND_COLOR[kind] };
}

/* ------------------------------------------------------------------ items */

export type CalendarGridItem = {
  id: string;
  kind: CalendarItemKind;
  dateStr: string;
  startMin: number;
  durationMin: number;
  allDay: boolean;
  title: string;
  place: string;
  /** A tour request still waiting on the manager (drawn dashed, never a pill). */
  requested: boolean;
  meeting: DemoMeeting;
};

function meetingPlace(meeting: DemoMeeting): string {
  if (!meeting.propertyTitle && !meeting.propertyId) return "";
  return compactTaskPropertyLabel(meeting.propertyId, meeting.propertyTitle) ?? meeting.propertyTitle ?? "";
}

function meetingTitle(meeting: DemoMeeting): string {
  if (meeting.googleCalendarPrivate) return meetingCalendarGridLabel(meeting);
  return meeting.title.trim() || meetingCalendarGridLabel(meeting);
}

/**
 * One meeting as the grid's items: a single block, or one block per day it
 * covers (a multi-day Google event paints every day, capped at two weeks).
 */
export function meetingToGridItems(meeting: DemoMeeting): CalendarGridItem[] {
  const base = {
    kind: calendarItemKind(meeting),
    title: meetingTitle(meeting),
    place: meetingPlace(meeting),
    requested: meeting.source === "inquiry",
    meeting,
  };
  if (meeting.allDay) {
    return [{ ...base, id: meeting.id, dateStr: meeting.dateStr, startMin: 0, durationMin: 0, allDay: true }];
  }
  const start = new Date(meeting.startIso);
  const startMin = Number.isNaN(start.getTime()) ? meeting.startSlot * 30 : start.getHours() * 60 + start.getMinutes();
  let remaining = Math.max(30, meeting.durationMinutes || 30);
  let dateStr = meeting.dateStr;
  let offset = startMin;
  const out: CalendarGridItem[] = [];
  for (let index = 0; remaining > 0 && index < 14; index += 1) {
    const take = Math.min(remaining, 24 * 60 - offset);
    out.push({
      ...base,
      id: index === 0 ? meeting.id : `${meeting.id}#${index}`,
      dateStr,
      startMin: offset,
      durationMin: take,
      allDay: false,
    });
    remaining -= take;
    dateStr = shiftDateStr(dateStr, 1);
    offset = 0;
  }
  return out;
}

/* ------------------------------------------------------------------ empty strip */

export function CalendarEmptyStrip({
  label,
  jump,
  onJump,
  addMenu,
}: {
  label: string;
  jump?: { text: string; dateStr: string } | null;
  onJump?: (dateStr: string) => void;
  /** The round + (the same Add menu as the header) so the empty state is never a dead end. */
  addMenu?: ReactNode;
}) {
  return (
    <div
      className="flex flex-wrap items-center gap-3 border-b border-border bg-card px-4 py-2 text-[13.5px]"
      data-attr="calendar-empty-strip"
    >
      <span className="font-semibold text-foreground">{label}</span>
      {jump && onJump ? (
        <button
          type="button"
          className="max-w-full truncate text-left text-[13px] font-semibold text-primary hover:underline"
          data-attr="calendar-empty-jump"
          onClick={() => onJump(jump.dateStr)}
        >
          {jump.text}
        </button>
      ) : null}
      <span className="flex-1" />
      {addMenu}
    </div>
  );
}

/* ------------------------------------------------------------------ legend */

export function CalendarBandLegend({ bands, tab }: { bands: readonly GridBand[]; tab: string }) {
  const seen = new Map<string, GridBand>();
  for (const band of bands) {
    const label = bandKindsLabel(band.kinds, false);
    if (!seen.has(label)) seen.set(label, band);
  }
  const names = legendKinds(bands);
  if (names.length === 0) {
    return (
      <div className="flex items-center gap-2 border-t border-border px-3.5 py-2 text-[11.5px] text-muted" data-attr="calendar-legend">
        <i className="inline-block h-2.5 w-3.5 rounded-[3px]" style={bandStyle(bandPaint([]), "key")} />
        {tab === "all" ? "Open hours" : `Open for ${tab}`}
      </div>
    );
  }
  return (
    <div
      className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-border px-3.5 py-2 text-[11.5px] text-muted"
      data-attr="calendar-legend"
    >
      <span>Open for</span>
      {names.map((name) => {
        const band = seen.get(name)!;
        return (
          <span key={name} className="inline-flex items-center gap-1.5">
            <i
              className="inline-block h-2.5 w-3.5 rounded-[3px]"
              style={bandStyle(bandPaint(band.kinds), "key")}
              aria-hidden
            />
            {name}
          </span>
        );
      })}
    </div>
  );
}

/* ------------------------------------------------------------------ time grid */

type DragState = {
  col: HTMLElement;
  day: string;
  from: number;
  to: number;
  anchor: number;
  y0: number;
  x0: number;
  active: boolean;
  touch: boolean;
  pointerId: number | null;
  timer: number | null;
};

export type CalendarTimeGridProps = {
  dates: string[];
  items: CalendarGridItem[];
  bandsByDate: Map<string, GridBand[]>;
  window: GridWindow;
  expandEarly: boolean;
  expandLate: boolean;
  onToggleEarly: () => void;
  onToggleLate: () => void;
  todayDs: string;
  nowMin: number;
  isDay: boolean;
  canEditAvailability: boolean;
  onOpenItem: (item: CalendarGridItem, target: HTMLElement) => void;
  onOpenDay?: (dateStr: string) => void;
  onBandClick: (dateStr: string, band: GridBand) => void;
  onDragAdd: (dateStr: string, fromMin: number, toMin: number) => void;
  /** Quiet strip above the grid (empty week, C2-CALP6). */
  emptyStrip?: ReactNode;
  legend?: ReactNode;
  minColumnPx?: number;
};

export function CalendarTimeGrid({
  dates,
  items,
  bandsByDate,
  window: win,
  expandEarly,
  expandLate,
  onToggleEarly,
  onToggleLate,
  todayDs,
  nowMin,
  isDay,
  canEditAvailability,
  onOpenItem,
  onOpenDay,
  onBandClick,
  onDragAdd,
  emptyStrip,
  legend,
  minColumnPx = 128,
}: CalendarTimeGridProps) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const suppressRef = useRef(0);
  const [ghost, setGhost] = useState<{ day: string; from: number; to: number } | null>(null);
  const onDragAddRef = useRef(onDragAdd);
  useEffect(() => {
    onDragAddRef.current = onDragAdd;
  }, [onDragAdd]);

  const { from, to } = win;
  const total = ((to - from) / 60) * GRID_HOUR_PX;
  const timed = items.filter((item) => !item.allDay);
  const allDay = items.filter((item) => item.allDay);
  const hours: number[] = [];
  for (let hr = from; hr < to; hr += 60) hours.push(hr);
  const cols = dates.length;

  // Drag on an empty part of a day to add availability. Mouse: press and drag.
  // Touch: press and hold, then drag — a normal swipe still scrolls.
  useEffect(() => {
    const root = rootRef.current;
    if (!root || !canEditAvailability) return;

    const colOf = (target: EventTarget | null): HTMLElement | null => {
      if (!(target instanceof Element)) return null;
      const col = target.closest<HTMLElement>("[data-cal-col]");
      return col && root.contains(col) ? col : null;
    };
    const rangeFor = (state: DragState, clientY: number) => {
      const rect = state.col.getBoundingClientRect();
      const current = minutesAtOffset(clientY - rect.top, state.from, state.to);
      return snapDragRange(state.anchor, current, state.to);
    };
    const begin = (state: DragState) => {
      state.active = true;
      document.body.classList.add("cal-dragging");
      const range = rangeFor(state, state.y0);
      setGhost({ day: state.day, ...range });
    };
    const end = (open: boolean, clientY?: number) => {
      const state = dragRef.current;
      if (!state) return;
      dragRef.current = null;
      if (state.timer !== null) window.clearTimeout(state.timer);
      document.body.classList.remove("cal-dragging");
      setGhost(null);
      if (open && state.active) {
        const range = rangeFor(state, clientY ?? state.y0);
        suppressRef.current = Date.now();
        onDragAddRef.current(state.day, range.from, range.to);
      }
    };
    const start = (col: HTMLElement, clientX: number, clientY: number, touch: boolean, pointerId: number | null) => {
      const from0 = Number(col.dataset.from);
      const to0 = Number(col.dataset.to);
      const rect = col.getBoundingClientRect();
      const state: DragState = {
        col,
        day: col.dataset.day ?? "",
        from: from0,
        to: to0,
        anchor: minutesAtOffset(clientY - rect.top, from0, to0),
        y0: clientY,
        x0: clientX,
        active: false,
        touch,
        pointerId,
        timer: null,
      };
      dragRef.current = state;
      if (touch) {
        state.timer = window.setTimeout(() => {
          if (dragRef.current === state) {
            begin(state);
            try {
              navigator.vibrate?.(12);
            } catch {
              /* no haptics */
            }
          }
        }, 420);
      }
    };

    const onPointerDown = (event: PointerEvent) => {
      if (event.pointerType === "touch" || event.button !== 0) return;
      const col = colOf(event.target);
      if (!col || (event.target as Element).closest("[data-cal-event]")) return;
      start(col, event.clientX, event.clientY, false, event.pointerId);
    };
    const onPointerMove = (event: PointerEvent) => {
      const state = dragRef.current;
      if (!state || state.touch || event.pointerId !== state.pointerId) return;
      if (!state.active) {
        if (Math.abs(event.clientY - state.y0) < 6) return;
        begin(state);
      }
      const range = rangeFor(state, event.clientY);
      setGhost({ day: state.day, ...range });
      event.preventDefault();
    };
    const onPointerUp = (event: PointerEvent) => {
      const state = dragRef.current;
      if (state && !state.touch) end(true, event.clientY);
    };
    const onPointerCancel = () => {
      const state = dragRef.current;
      if (state && !state.touch) end(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && dragRef.current) end(false);
    };
    const onTouchStart = (event: TouchEvent) => {
      if (dragRef.current) end(false);
      if (event.touches.length !== 1) return;
      const col = colOf(event.target);
      if (!col || (event.target as Element).closest("[data-cal-event]")) return;
      const touch = event.touches[0]!;
      start(col, touch.clientX, touch.clientY, true, null);
    };
    const onTouchMove = (event: TouchEvent) => {
      const state = dragRef.current;
      if (!state || !state.touch) return;
      const touch = event.touches[0]!;
      if (!state.active) {
        if (Math.abs(touch.clientY - state.y0) > 8 || Math.abs(touch.clientX - state.x0) > 8) {
          if (state.timer !== null) window.clearTimeout(state.timer);
          dragRef.current = null;
        }
        return;
      }
      if (event.cancelable) event.preventDefault();
      const range = rangeFor(state, touch.clientY);
      setGhost({ day: state.day, ...range });
    };
    const onTouchEnd = (event: TouchEvent) => {
      const state = dragRef.current;
      if (!state || !state.touch) return;
      const lastY = event.changedTouches[0]?.clientY;
      if (state.active && event.cancelable) event.preventDefault();
      end(true, lastY);
    };
    const onTouchCancel = () => {
      if (dragRef.current?.touch) end(false);
    };
    const onContextMenu = (event: Event) => {
      if (dragRef.current?.touch) event.preventDefault();
    };

    root.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("pointermove", onPointerMove, { passive: false });
    window.addEventListener("pointerup", onPointerUp);
    window.addEventListener("pointercancel", onPointerCancel);
    window.addEventListener("keydown", onKey);
    root.addEventListener("touchstart", onTouchStart, { passive: true });
    root.addEventListener("touchmove", onTouchMove, { passive: false });
    root.addEventListener("touchend", onTouchEnd, { passive: false });
    root.addEventListener("touchcancel", onTouchCancel);
    root.addEventListener("contextmenu", onContextMenu);
    return () => {
      end(false);
      root.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("pointercancel", onPointerCancel);
      window.removeEventListener("keydown", onKey);
      root.removeEventListener("touchstart", onTouchStart);
      root.removeEventListener("touchmove", onTouchMove);
      root.removeEventListener("touchend", onTouchEnd);
      root.removeEventListener("touchcancel", onTouchCancel);
      root.removeEventListener("contextmenu", onContextMenu);
    };
  }, [canEditAvailability]);

  const gutter = "var(--cal-gutter, 56px)";
  const gridTemplate = `${gutter} repeat(${cols}, minmax(0, 1fr))`;

  return (
    <div
      className="cal-card overflow-hidden rounded-[14px] border border-border bg-card"
      data-attr="calendar-time-grid"
      data-view={isDay ? "day" : "week"}
      style={{ ["--cal-gutter" as string]: "56px" }}
    >
      {emptyStrip}
      <div className="overflow-x-auto" style={{ WebkitOverflowScrolling: "touch" }}>
        <div ref={rootRef} style={{ minWidth: isDay ? 0 : `calc(${gutter} + ${cols} * ${minColumnPx}px)` }}>
          {/* day headers */}
          <div className="grid border-b border-border bg-card" style={{ gridTemplateColumns: gridTemplate }}>
            <div />
            {dates.map((dateStr) => {
              const weekday = weekdayOfDateStr(dateStr);
              const isToday = dateStr === todayDs;
              const weekend = weekday >= 5;
              const Tag = isDay || !onOpenDay ? "div" : "button";
              return (
                <Tag
                  key={dateStr}
                  {...(Tag === "button"
                    ? { type: "button" as const, onClick: () => onOpenDay?.(dateStr) }
                    : {})}
                  data-attr="calendar-day-header"
                  data-date={dateStr}
                  aria-label={`${DOW_LONG[weekday]}, ${dayLabel(dateStr, false)}`}
                  className={cn(
                    "flex min-w-0 flex-col items-center gap-[3px] border-l border-foreground/[0.06] px-0 pb-2 pt-[9px] text-foreground",
                    Tag === "button" && "cursor-pointer hover:bg-foreground/[0.03]",
                    weekend && "bg-foreground/[0.03]",
                    isToday && "bg-primary/[0.07]",
                  )}
                >
                  <span
                    className={cn(
                      "text-[10.5px] font-semibold uppercase leading-none tracking-[0.04em] text-muted",
                      isToday && "font-bold text-primary",
                    )}
                  >
                    {DOW_SHORT[weekday]}
                  </span>
                  <span
                    className={cn(
                      "inline-flex h-[26px] min-w-[26px] items-center justify-center rounded-full px-1 text-sm font-bold leading-none",
                      isToday && "bg-primary text-primary-foreground",
                    )}
                  >
                    {Number(dateStr.slice(8))}
                  </span>
                </Tag>
              );
            })}
          </div>

          {/* all-day row */}
          {allDay.length > 0 ? (
            <div
              className="grid border-b border-border"
              style={{ gridTemplateColumns: gridTemplate }}
              data-attr="calendar-all-day-row"
            >
              <div className="flex items-start justify-end pr-2 pt-2 text-[10.5px] font-semibold text-muted">All day</div>
              {dates.map((dateStr) => (
                <div
                  key={dateStr}
                  className={cn(
                    "flex min-w-0 flex-col gap-[3px] border-l border-foreground/[0.06] p-1",
                    dateStr === todayDs && "bg-primary/[0.05]",
                  )}
                >
                  {allDay
                    .filter((item) => item.dateStr === dateStr)
                    .map((item) => {
                      const Icon = KIND_ICON[item.kind];
                      return (
                        <button
                          key={item.id}
                          type="button"
                          title={`${item.title}${item.place ? ` · ${item.place}` : ""}`}
                          data-attr="calendar-all-day-chip"
                          data-cal-kind={item.kind}
                          style={kindStyle(item.kind)}
                          onClick={(event: MouseEvent<HTMLButtonElement>) => onOpenItem(item, event.currentTarget)}
                          className="flex w-full items-center gap-1.5 overflow-hidden whitespace-nowrap rounded-[7px] border-0 border-l-[3px] border-[color:var(--k)] bg-[color-mix(in_srgb,var(--k)_14%,var(--card))] px-[7px] py-1 text-left text-[11.5px] font-semibold text-foreground"
                        >
                          <Icon className="size-3 shrink-0 text-[color:var(--k)]" aria-hidden />
                          <span className="truncate">{item.title}</span>
                        </button>
                      );
                    })}
                </div>
              ))}
            </div>
          ) : null}

          {win.early > 0 ? (
            <button
              type="button"
              onClick={onToggleEarly}
              data-attr="calendar-earlier-row"
              className="block w-full border-0 border-b border-border bg-foreground/[0.025] py-[5px] text-[11.5px] font-semibold text-muted hover:bg-primary/[0.06] hover:text-primary"
            >
              {expandEarly ? "Hide earlier hours" : `${win.early} ${win.early === 1 ? "item" : "items"} earlier`}
            </button>
          ) : null}

          {/* hours + columns */}
          <div className="grid" style={{ gridTemplateColumns: `${gutter} minmax(0, 1fr)` }}>
            <div className="relative" style={{ height: total }}>
              {hours.map((hr, index) => (
                <div key={hr} className="relative box-border" style={{ height: GRID_HOUR_PX }}>
                  <span
                    className="absolute right-2 whitespace-nowrap text-[10.5px] font-medium text-muted"
                    style={{ top: index === 0 ? 3 : -7 }}
                  >
                    {formatClock(hr)}
                  </span>
                </div>
              ))}
            </div>
            <div className="grid" style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}>
              {dates.map((dateStr) => {
                const weekday = weekdayOfDateStr(dateStr);
                const isToday = dateStr === todayDs;
                const dayBands = bandsByDate.get(dateStr) ?? [];
                const placed = layoutDayEvents(
                  timed.filter((item) => item.dateStr === dateStr).map((item) => ({
                    id: item.id,
                    startMin: item.startMin,
                    durationMin: item.durationMin,
                  })),
                  from,
                  to,
                );
                const byId = new Map(timed.map((item) => [item.id, item]));
                return (
                  <div
                    key={dateStr}
                    data-cal-col=""
                    data-day={dateStr}
                    data-from={from}
                    data-to={to}
                    data-attr="calendar-day-column"
                    className={cn(
                      "relative select-none border-l border-foreground/[0.06]",
                      weekday >= 5 && "bg-foreground/[0.022]",
                      isToday && "bg-primary/[0.05]",
                    )}
                    style={{
                      height: total,
                      backgroundImage:
                        "linear-gradient(to bottom, color-mix(in srgb, var(--foreground) 7%, transparent) 1px, transparent 1px), linear-gradient(to bottom, color-mix(in srgb, var(--foreground) 3%, transparent) 1px, transparent 1px)",
                      backgroundSize: `100% ${GRID_HOUR_PX}px, 100% ${GRID_HOUR_PX / 2}px`,
                      WebkitTouchCallout: "none",
                    }}
                  >
                    {dayBands.map((band, index) => {
                      const s = Math.max(band.startMin, from);
                      const e = Math.min(band.endMin, to);
                      if (e <= s) return null;
                      const px = ((e - s) / 60) * GRID_HOUR_PX;
                      const typed = band.source === "typed";
                      const paint = bandPaint(band.kinds);
                      const label = typed
                        ? px >= 22
                          ? bandKindsLabel(band.kinds, false)
                          : ""
                        : isDay && e - s >= 90
                          ? "Open for tours"
                          : "";
                      const title = `${bandKindsLabel(band.kinds, true)} · ${formatClockRange(band.startMin, band.endMin)}${typed ? " · click to edit" : ""}`;
                      return (
                        <div
                          key={`${band.startMin}-${band.endMin}-${index}`}
                          data-attr="calendar-open-band"
                          data-band-source={band.source}
                          data-date={dateStr}
                          data-from={band.startMin}
                          data-to={band.endMin}
                          title={title}
                          role={typed && canEditAvailability ? "button" : undefined}
                          tabIndex={typed && canEditAvailability ? 0 : undefined}
                          onClick={() => {
                            if (!typed || !canEditAvailability || Date.now() - suppressRef.current < 500) return;
                            onBandClick(dateStr, band);
                          }}
                          onKeyDown={(event) => {
                            if (!typed || !canEditAvailability) return;
                            if (event.key === "Enter" || event.key === " ") {
                              event.preventDefault();
                              onBandClick(dateStr, band);
                            }
                          }}
                          className={cn(
                            "absolute left-0 right-0",
                            typed && canEditAvailability ? "cursor-pointer hover:saturate-150" : "cursor-crosshair",
                          )}
                          style={{
                            top: ((s - from) / 60) * GRID_HOUR_PX,
                            height: px,
                            ...bandStyle(paint, "grid"),
                          }}
                        >
                          {label ? (
                            <span className="pointer-events-none absolute left-2 right-1 top-[5px] truncate text-[10.5px] font-semibold tracking-[0.01em] text-muted">
                              {label}
                            </span>
                          ) : null}
                        </div>
                      );
                    })}

                    {placed.map((slot) => {
                      const item = byId.get(slot.id);
                      if (!item) return null;
                      const Icon = KIND_ICON[item.kind];
                      const top = ((item.startMin - from) / 60) * GRID_HOUR_PX;
                      const height = Math.max((item.durationMin / 60) * GRID_HOUR_PX - 3, GRID_MIN_BLOCK_PX);
                      const when = formatClockRange(item.startMin, item.startMin + (item.durationMin || 30));
                      return (
                        <button
                          key={item.id}
                          type="button"
                          data-cal-event=""
                          data-attr="calendar-event-block"
                          data-cal-kind={item.kind}
                          title={`${item.title}${item.place ? ` · ${item.place}` : ""} · ${when}`}
                          onClick={(event: MouseEvent<HTMLButtonElement>) => onOpenItem(item, event.currentTarget)}
                          className={cn(
                            "absolute z-[2] box-border flex flex-col gap-px overflow-hidden rounded-lg border-0 border-l-[3px] border-[color:var(--k)] bg-[color-mix(in_srgb,var(--k)_16%,var(--card))] px-[7px] py-1 text-left text-foreground shadow-[0_1px_2px_rgba(15,23,42,0.08)] transition hover:-translate-y-px hover:shadow-[0_4px_12px_rgba(15,23,42,0.18)]",
                            item.requested && "border-dashed ring-1 ring-inset ring-[color:var(--k)]/40",
                          )}
                          style={{
                            ...kindStyle(item.kind),
                            top,
                            height,
                            left: `calc(${(slot.lane / slot.lanes) * 100}% + 2px)`,
                            width: `calc(${100 / slot.lanes}% - 4px)`,
                            maxWidth: isDay ? 460 : undefined,
                          }}
                        >
                          <span className="flex items-center gap-1 text-[10.5px] font-bold leading-[13px] text-[color-mix(in_srgb,var(--k)_55%,var(--foreground))]">
                            <Icon className="size-[11px] shrink-0 text-[color:var(--k)]" aria-hidden />
                            <span>{formatClock(item.startMin)}</span>
                            {item.requested ? <span className="font-semibold opacity-80">· Requested</span> : null}
                          </span>
                          <span className="truncate text-xs font-semibold leading-[15px]">{item.title}</span>
                          {item.place ? (
                            <span className="truncate text-[11px] leading-[14px] text-muted">{item.place}</span>
                          ) : null}
                        </button>
                      );
                    })}

                    {ghost && ghost.day === dateStr ? (
                      <div
                        data-attr="calendar-drag-ghost"
                        className="pointer-events-none absolute left-0.5 right-0.5 z-[4] box-border overflow-hidden rounded-lg border-[1.5px] border-dashed border-primary bg-primary/[0.14]"
                        style={{
                          top: ((ghost.from - from) / 60) * GRID_HOUR_PX,
                          height: ((ghost.to - ghost.from) / 60) * GRID_HOUR_PX,
                        }}
                      >
                        <span className="block whitespace-nowrap px-1.5 py-[3px] text-[10.5px] font-bold text-primary">
                          {formatClockRange(ghost.from, ghost.to)}
                        </span>
                      </div>
                    ) : null}

                    {isToday && nowMin >= from && nowMin <= to ? (
                      <div
                        data-attr="calendar-now-line"
                        aria-hidden
                        className="pointer-events-none absolute left-0 right-0 z-[3] h-0.5 bg-[#e34948] before:absolute before:-left-1 before:-top-[3px] before:size-2 before:rounded-full before:bg-[#e34948]"
                        style={{ top: ((nowMin - from) / 60) * GRID_HOUR_PX }}
                      />
                    ) : null}
                  </div>
                );
              })}
            </div>
          </div>

          {win.late > 0 ? (
            <button
              type="button"
              onClick={onToggleLate}
              data-attr="calendar-later-row"
              className="block w-full border-0 border-t border-border bg-foreground/[0.025] py-[5px] text-[11.5px] font-semibold text-muted hover:bg-primary/[0.06] hover:text-primary"
            >
              {expandLate ? "Hide later hours" : `${win.late} ${win.late === 1 ? "item" : "items"} later`}
            </button>
          ) : null}
        </div>
      </div>
      {legend}
    </div>
  );
}

/* ------------------------------------------------------------------ month */

export function CalendarMonthView({
  monthStart,
  items,
  todayDs,
  phone,
  openHalfHoursFor,
  openLabel,
  onOpenItem,
  onOpenDay,
  emptyStrip,
}: {
  /** First day of the month, `YYYY-MM-01`. */
  monthStart: string;
  items: CalendarGridItem[];
  todayDs: string;
  phone: boolean;
  openHalfHoursFor: (dateStr: string) => number;
  /** "Open hours" / "Open for tours" / … — what the hatched strip means for the active tab. */
  openLabel: string;
  onOpenItem: (item: CalendarGridItem, target: HTMLElement) => void;
  onOpenDay: (dateStr: string) => void;
  emptyStrip?: ReactNode;
}) {
  const gridStart = shiftDateStr(monthStart, -weekdayOfDateStr(monthStart));
  const [y, m] = monthStart.split("-").map(Number);
  const daysInMonth = new Date(y!, m!, 0).getDate();
  const lastDay = shiftDateStr(monthStart, daysInMonth - 1);
  const weeks = Math.ceil((daysBetween(gridStart, lastDay) + 1) / 7);
  const cells = Array.from({ length: weeks * 7 }, (_, index) => shiftDateStr(gridStart, index));
  return (
    <div className="overflow-hidden rounded-[14px] border border-border bg-card" data-attr="calendar-month-view">
      {emptyStrip}
      <div className="grid grid-cols-7 border-b border-border bg-background">
        {DOW_SHORT.map((label) => (
          <div
            key={label}
            className={cn(
              "px-2.5 py-[9px] text-[10.5px] font-semibold uppercase tracking-[0.04em] text-muted",
              phone && "px-0.5 text-center",
            )}
          >
            {phone ? label.charAt(0) : label}
          </div>
        ))}
      </div>
      <div
        className="grid grid-cols-7"
        data-slot="calendar-month-grid"
        style={{ gridAutoRows: phone ? "minmax(64px, auto)" : "minmax(116px, auto)" }}
      >
        {cells.map((dateStr, index) => {
          const inMonth = dateStr.slice(0, 7) === monthStart.slice(0, 7);
          const weekday = weekdayOfDateStr(dateStr);
          const dayItems = items
            .filter((item) => item.dateStr === dateStr && item.kind !== "busy")
            .sort((a, b) => (a.allDay === b.allDay ? a.startMin - b.startMin : a.allDay ? -1 : 1));
          const shown = dayItems.slice(0, 3);
          const open = inMonth ? openHalfHoursFor(dateStr) : 0;
          return (
            <div
              key={dateStr}
              data-attr="calendar-month-day"
              data-date={dateStr}
              className={cn(
                "flex min-w-0 flex-col gap-1 border-l border-t border-foreground/[0.06] p-1.5 max-sm:p-1",
                index % 7 === 0 && "border-l-0",
                index < 7 && "border-t-0",
                weekday >= 5 && "bg-foreground/[0.022]",
                !inMonth && "opacity-50",
                dateStr === todayDs && "bg-primary/[0.05]",
              )}
            >
              <button
                type="button"
                onClick={() => onOpenDay(dateStr)}
                aria-label={`${DOW_LONG[weekday]}, ${dayLabel(dateStr, false)}`}
                data-attr="calendar-month-day-number"
                className={cn(
                  "h-[26px] min-w-[26px] self-start rounded-full px-1 text-[12.5px] font-bold text-foreground hover:bg-foreground/[0.06]",
                  dateStr === todayDs && "bg-primary text-primary-foreground hover:bg-primary",
                )}
              >
                {Number(dateStr.slice(8))}
              </button>
              {phone ? (
                <div className="flex flex-wrap gap-1 px-0.5">
                  {shown.map((item) => (
                    <button
                      key={item.id}
                      type="button"
                      aria-label={item.title}
                      data-attr="calendar-month-pip"
                      onClick={(event) => onOpenItem(item, event.currentTarget)}
                      className="size-2 min-h-0 min-w-0 rounded-full border-0 p-0"
                      style={{ background: CALENDAR_KIND_COLOR[item.kind] }}
                    />
                  ))}
                </div>
              ) : (
                <div className="flex min-w-0 flex-col gap-[3px]">
                  {shown.map((item) => (
                    <button
                      key={item.id}
                      type="button"
                      data-attr="calendar-month-chip"
                      data-cal-kind={item.kind}
                      title={`${item.title}${item.place ? ` · ${item.place}` : ""}`}
                      style={kindStyle(item.kind)}
                      onClick={(event) => onOpenItem(item, event.currentTarget)}
                      className="flex w-full items-center gap-[5px] overflow-hidden whitespace-nowrap rounded-md border-0 border-l-[3px] border-[color:var(--k)] bg-[color-mix(in_srgb,var(--k)_14%,var(--card))] px-1.5 py-0.5 text-left text-[11px] font-medium text-foreground"
                    >
                      {item.allDay ? null : (
                        <b className="shrink-0 font-bold text-[color-mix(in_srgb,var(--k)_55%,var(--foreground))]">
                          {formatClock(item.startMin).replace(":00", "").replace(" ", "")}
                        </b>
                      )}
                      <span className="truncate">{item.title}</span>
                    </button>
                  ))}
                </div>
              )}
              {dayItems.length > 3 ? (
                <button
                  type="button"
                  onClick={() => onOpenDay(dateStr)}
                  data-attr="calendar-month-more"
                  className="self-start px-0.5 text-[11.5px] font-semibold text-primary hover:underline"
                >
                  +{dayItems.length - 3} more
                </button>
              ) : null}
              {open > 0 ? (
                <span
                  data-attr="calendar-month-open"
                  className="mt-auto h-[5px] shrink-0 rounded-[3px]"
                  title={`${open / 2} h open`}
                  aria-label={`${open / 2} h open`}
                  style={bandStyle(bandPaint([]), "key")}
                />
              ) : null}
            </div>
          );
        })}
      </div>
      <div className="flex items-center gap-2 border-t border-border px-3.5 py-2 text-[11.5px] text-muted">
        <i className="inline-block h-2.5 w-3.5 rounded-[3px]" style={bandStyle(bandPaint([]), "key")} aria-hidden />
        {openLabel}
      </div>
    </div>
  );
}

function daysBetween(a: string, b: string): number {
  const [ya, ma, da] = a.split("-").map(Number);
  const [yb, mb, db] = b.split("-").map(Number);
  return Math.round((Date.UTC(yb!, mb! - 1, db!) - Date.UTC(ya!, ma! - 1, da!)) / 86400000);
}

/* ------------------------------------------------------------------ agenda */

export function CalendarAgendaView({
  dates,
  items,
  todayDs,
  emptyStrip,
  onOpenItem,
  onRescheduleTour,
}: {
  dates: string[];
  items: CalendarGridItem[];
  todayDs: string;
  emptyStrip?: ReactNode;
  onOpenItem: (item: CalendarGridItem, target: HTMLElement | null) => void;
  onRescheduleTour?: (item: CalendarGridItem) => void;
}) {
  const inRange = new Set(dates);
  const list = items
    .filter((item) => inRange.has(item.dateStr) && item.kind !== "busy")
    .sort((a, b) =>
      a.dateStr === b.dateStr
        ? a.allDay === b.allDay
          ? a.startMin - b.startMin
          : a.allDay
            ? -1
            : 1
        : a.dateStr.localeCompare(b.dateStr),
    );
  if (list.length === 0) {
    return (
      <div className="overflow-hidden rounded-[14px] border border-border bg-card" data-attr="calendar-agenda-view">
        {emptyStrip}
      </div>
    );
  }
  const groups: Array<{ dateStr: string; rows: CalendarGridItem[] }> = [];
  for (const item of list) {
    const last = groups[groups.length - 1];
    if (last && last.dateStr === item.dateStr) last.rows.push(item);
    else groups.push({ dateStr: item.dateStr, rows: [item] });
  }
  return (
    <div className="flex flex-col gap-3.5" data-attr="calendar-agenda-view">
      {groups.map((group) => {
        const weekday = weekdayOfDateStr(group.dateStr);
        return (
          <section key={group.dateStr} data-attr="calendar-agenda-group">
            <div
              data-attr="calendar-agenda-day-header"
              className="sticky top-[var(--portal-calendar-header-top,0px)] z-[4] flex items-baseline gap-2 bg-background px-1 py-2 text-[13px] text-muted"
            >
              <b className="text-[13.5px] text-foreground">{DOW_LONG[weekday]}</b>
              <span>{dayLabel(group.dateStr, false)}</span>
              {group.dateStr === todayDs ? (
                <em className="rounded-full bg-primary/10 px-2 text-[11px] font-bold not-italic text-primary">Today</em>
              ) : null}
              <span className="flex-1" />
              <i className="text-[11.5px] not-italic text-muted/80">{group.rows.length}</i>
            </div>
            <div className="mt-1">
              {group.rows.map((item) => {
                const Icon = KIND_ICON[item.kind];
                const canReschedule =
                  item.kind === "tour" &&
                  Boolean(onRescheduleTour) &&
                  (item.meeting.source === "inquiry" || item.meeting.source === "planned") &&
                  !item.meeting.isPeerTour;
                return (
                  <PortalPropertyRecordRow
                    key={item.id}
                    title={item.title}
                    address={item.place || undefined}
                    leadingShape="square"
                    leading={
                      <span
                        className="flex size-14 items-center justify-center rounded-xl bg-[color-mix(in_srgb,var(--k)_15%,var(--card))] text-[color:var(--k)]"
                        style={kindStyle(item.kind)}
                        aria-hidden
                      >
                        <Icon className="size-5" />
                      </span>
                    }
                    facts={
                      <>
                        <PortalRowFact icon={Clock} srLabel="Time">
                          {item.allDay
                            ? "All day"
                            : formatClockRange(item.startMin, item.startMin + (item.durationMin || 30))}
                        </PortalRowFact>
                        <PortalRowFact icon={Icon} srLabel="Type">
                          {CALENDAR_KIND_LABEL[item.kind]}
                        </PortalRowFact>
                      </>
                    }
                    onOpen={() => onOpenItem(item, null)}
                    dataAttr="calendar-agenda-row"
                    actions={
                      <DropdownMenu>
                        <DropdownMenuTrigger
                          type="button"
                          className={RECORD_ACTION_TRIGGER_BUTTON_CLASS}
                          aria-label={`Actions for ${item.title}`}
                          data-attr="calendar-agenda-row-menu"
                          onClick={(event) => event.stopPropagation()}
                        >
                          <MoreHorizontal className={RECORD_ACTION_TRIGGER_ICON_CLASS} aria-hidden />
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem data-attr="calendar-agenda-row-open" onSelect={() => onOpenItem(item, null)}>
                            Open
                          </DropdownMenuItem>
                          {canReschedule ? (
                            <DropdownMenuItem
                              data-attr="calendar-agenda-row-reschedule"
                              onSelect={() => onRescheduleTour?.(item)}
                            >
                              Reschedule
                            </DropdownMenuItem>
                          ) : null}
                        </DropdownMenuContent>
                      </DropdownMenu>
                    }
                  />
                );
              })}
            </div>
          </section>
        );
      })}
    </div>
  );
}

/* ------------------------------------------------------------------ day side panel */

export function CalendarDayPanel({
  dateStr,
  isToday,
  items,
  openStarts,
  chipStarts,
  openSummary,
  canEditAvailability,
  onOpenItem,
  onBookSlot,
  onAddAvailability,
}: {
  dateStr: string;
  isToday: boolean;
  items: CalendarGridItem[];
  /** Every 30-minute start the manager is open for tours (published or default) on this day. */
  openStarts: number[];
  /** The starts a guest could still book (not past, not already held). */
  chipStarts: number[];
  openSummary: string;
  canEditAvailability: boolean;
  onOpenItem: (item: CalendarGridItem, target: HTMLElement | null) => void;
  onBookSlot: (dateStr: string, startMin: number) => void;
  onAddAvailability: (dateStr: string) => void;
}) {
  const weekday = weekdayOfDateStr(dateStr);
  const list = items
    .filter((item) => item.dateStr === dateStr && item.kind !== "busy")
    .sort((a, b) => (a.allDay === b.allDay ? a.startMin - b.startMin : a.allDay ? -1 : 1));
  const addLink = canEditAvailability ? (
    <button
      type="button"
      onClick={() => onAddAvailability(dateStr)}
      data-attr="calendar-day-add-availability"
      className="self-start text-[13px] font-semibold text-primary hover:underline"
    >
      Add availability
    </button>
  ) : null;
  return (
    <aside
      className="flex flex-col gap-3 overflow-hidden rounded-[14px] border border-border bg-card p-4"
      data-attr="calendar-day-agenda"
    >
      <div className="flex flex-wrap items-baseline gap-2">
        <b className="text-[15px] text-foreground">{DOW_LONG[weekday]}</b>
        <span className="text-[13px] text-muted">{dayLabel(dateStr, false)}</span>
        {isToday ? <em className="rounded-full bg-primary/10 px-2 text-[11px] font-bold not-italic text-primary">Today</em> : null}
      </div>
      {list.length > 0 ? (
        <div className="flex flex-col">
          {list.map((item, index) => {
            const Icon = KIND_ICON[item.kind];
            return (
              <button
                key={item.id}
                type="button"
                data-attr="calendar-day-agenda-item"
                data-cal-kind={item.kind}
                style={kindStyle(item.kind)}
                onClick={(event) => onOpenItem(item, event.currentTarget)}
                className={cn(
                  "flex w-full gap-2.5 border-0 bg-transparent py-[9px] text-left text-foreground",
                  index > 0 && "border-t border-border",
                )}
              >
                <span className="w-[3px] shrink-0 rounded-[3px] bg-[color:var(--k)]" />
                <span className="flex min-w-0 flex-col gap-0.5">
                  <span className="truncate text-[13.5px] font-semibold">{item.title}</span>
                  <span className="flex items-center gap-[5px] text-xs text-muted">
                    <Icon className="size-[13px] shrink-0 text-[color:var(--k)]" aria-hidden />
                    <span className="truncate">
                      {item.allDay ? "All day" : formatClock(item.startMin)}
                      {item.place ? ` · ${item.place}` : ""}
                    </span>
                  </span>
                </span>
              </button>
            );
          })}
        </div>
      ) : null}
      <div className="flex items-center gap-2 border-t border-border pt-1 text-[11.5px] font-bold uppercase tracking-[0.06em] text-muted">
        <i className="inline-block h-3 w-4 rounded-[3px]" style={bandStyle(bandPaint([]), "key")} aria-hidden />
        Open for tours
      </div>
      {openStarts.length === 0 ? (
        <>
          <p className="text-[13px] text-muted" data-attr="calendar-day-no-tour-times">
            No tour times on {DOW_LONG[weekday]}s
          </p>
          {addLink}
        </>
      ) : (
        <>
          <p className="text-[13px] font-semibold text-foreground" data-attr="calendar-day-open-summary">
            {openSummary}
          </p>
          {chipStarts.length > 0 ? (
            <div className="grid grid-cols-3 gap-1.5" data-attr="calendar-day-slots">
              {chipStarts.map((start) => (
                <button
                  key={start}
                  type="button"
                  data-attr="calendar-day-slot"
                  aria-label={`Book a tour at ${formatClock(start)}`}
                  onClick={() => onBookSlot(dateStr, start)}
                  className="h-[34px] whitespace-nowrap rounded-full border border-[#2a78d6]/40 bg-[#2a78d6]/[0.08] text-[12.5px] font-semibold text-foreground transition hover:border-[#2a78d6] hover:bg-[#2a78d6]/[0.18]"
                >
                  {formatClock(start)}
                </button>
              ))}
            </div>
          ) : (
            <>
              <p className="text-[13px] text-muted">No open times left{isToday ? " today" : ""}</p>
              {addLink}
            </>
          )}
        </>
      )}
    </aside>
  );
}
