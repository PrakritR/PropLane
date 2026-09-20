"use client";

/**
 * One room's availability as a month grid.
 *
 * Shared by the public listing page (every span red, read-only) and the listing
 * editor's Rooms step (the manager's own occupied dates red, residents' stays,
 * Bookings blocks and Airbnb imports). Available days are green, past days fade,
 * today is ringed. The month range runs from the current month to twelve months
 * out or to the last span, whichever is later, and the prev arrow is disabled on
 * the first month.
 *
 * Interactive mode is opt-in: the editor can paint occupied days by dragging
 * open cells (press-hold then swipe on touch) and resize red spans by their
 * handles. Grey booked days never start a drag. Default stays read-only.
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import {
  addMonths,
  buildMonthDayCells,
  clipPaintRange,
  dateKey,
  dayIsUnavailable,
  monthAvailabilityTone,
  monthToneLabel,
  orderedDateKeys,
  resolveAvailabilityMonthRange,
  startOfLocalDay,
  type AvailabilityDayWindow,
  type MonthAvailabilityTone,
} from "@/lib/room-availability-calendar";
import { formatDateKeyShort } from "@/lib/room-availability-timeline";

export type RoomCalendarSpanTone = "occupied" | "booked";

export type RoomCalendarSpan = AvailabilityDayWindow & {
  /** Red for the manager's own occupied dates; grey for a stay, block or import someone else owns. */
  tone: RoomCalendarSpanTone;
  /** Occupied spans that can be resized carry the stored range id. */
  id?: string;
};

export type RoomCalendarInteraction = {
  onPaintRange: (start: string, end: string) => void;
  onResizeOccupied: (id: string, edge: "start" | "end", toDay: string) => void;
};

function monthTonePillClasses(tone: MonthAvailabilityTone): string {
  switch (tone) {
    case "available":
      return "portal-badge-success ring-1 ring-[color-mix(in_srgb,currentColor_25%,transparent)]";
    case "unavailable":
      return "portal-badge-danger ring-1 ring-[color-mix(in_srgb,currentColor_25%,transparent)]";
    case "mixed":
      return "portal-badge-pending ring-1 ring-[color-mix(in_srgb,currentColor_25%,transparent)]";
  }
}

const DAY_OPEN = "bg-emerald-100 text-emerald-950 ring-1 ring-inset ring-emerald-300 [html[data-theme=dark]_&]:portal-calendar-open-slot";
const DAY_OCCUPIED =
  "bg-rose-100 text-rose-950 ring-1 ring-inset ring-rose-300 [html[data-theme=dark]_&]:bg-rose-950/40 [html[data-theme=dark]_&]:text-rose-100 [html[data-theme=dark]_&]:ring-rose-700/60";
const DAY_SELECTED = "bg-primary/15 text-primary ring-2 ring-inset ring-primary";

const HOLD_MS = 200;
const HOLD_CANCEL_PX = 10;

/** Which colour a day takes: a booked span wins over a typed one, as in the timeline's derivation. */
export function roomCalendarDayTone(day: Date, spans: readonly RoomCalendarSpan[]): RoomCalendarSpanTone | "open" {
  const booked = spans.filter((s) => s.tone === "booked");
  if (dayIsUnavailable(day, booked)) return "booked";
  const occupied = spans.filter((s) => s.tone === "occupied");
  if (dayIsUnavailable(day, occupied)) return "occupied";
  return "open";
}

function dayClasses(tone: RoomCalendarSpanTone | "open" | "selected", isPast: boolean, isToday: boolean): string {
  const base = tone === "booked" || tone === "occupied" ? DAY_OCCUPIED : tone === "selected" ? DAY_SELECTED : DAY_OPEN;
  return `${base} ${isPast ? "opacity-45" : ""} ${isToday && tone !== "selected" ? "ring-2 ring-primary/50" : ""}`;
}

type Drag =
  | { kind: "paint"; origin: string; end: string }
  | { kind: "resize"; id: string; edge: "start" | "end"; origin: string; end: string };

function occupiedCovering(spans: readonly RoomCalendarSpan[], dayKey: string): RoomCalendarSpan | null {
  return (
    spans.find((s) => {
      if (s.tone !== "occupied" || !s.id || !s.start) return false;
      const start = dateKey(s.start);
      const end = s.end ? dateKey(s.end) : null;
      return start <= dayKey && (end === null || dayKey <= end);
    }) ?? null
  );
}

function MonthGrid({
  monthStart,
  spans,
  today,
  loading,
  interactive,
  drag,
  onDayPointerDown,
  onHandlePointerDown,
}: {
  monthStart: Date;
  spans: readonly RoomCalendarSpan[];
  today: Date;
  loading: boolean;
  interactive: boolean;
  drag: Drag | null;
  onDayPointerDown: (dayKey: string, tone: RoomCalendarSpanTone | "open", event: ReactPointerEvent) => void;
  onHandlePointerDown: (id: string, edge: "start" | "end", dayKey: string, event: ReactPointerEvent) => void;
}) {
  const cells = buildMonthDayCells(monthStart);
  const [selStart, selEnd] = drag ? orderedDateKeys(drag.origin, drag.end) : [null, null];
  const chipAnchor = drag ? (drag.origin <= drag.end ? drag.end : drag.origin) : null;
  const chipLabel = drag ? `Booked · ${formatDateKeyShort(selStart!)}–${formatDateKeyShort(selEnd!)}` : null;

  return (
    <>
      <div className="grid grid-cols-7 gap-0.5 text-center text-[9px] font-semibold uppercase tracking-wide text-muted sm:text-[10px]">
        {["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"].map((label) => (
          <span key={label}>{label}</span>
        ))}
      </div>
      <div className="mt-1 grid grid-cols-7 gap-0.5">
        {cells.map((cell, idx) => {
          if (!cell) return <span key={`empty-${idx}`} className="h-7 sm:h-8" />;
          if (loading) {
            return <span key={`sk-${idx}`} className="h-7 animate-pulse rounded-md bg-muted sm:h-8" />;
          }
          const tone = roomCalendarDayTone(cell, spans);
          const key = dateKey(cell);
          const isToday = key === dateKey(today);
          const isPast = cell.getTime() < today.getTime();
          const selected = Boolean(selStart && selEnd && key >= selStart && key <= selEnd);
          const displayTone = selected ? "selected" : tone;
          const covering = tone === "occupied" ? occupiedCovering(spans, key) : null;
          const startKey = covering?.start ? dateKey(covering.start) : null;
          const endKey = covering?.end ? dateKey(covering.end) : null;
          const showStartHandle = Boolean(interactive && covering?.id && startKey === key);
          const showEndHandle = Boolean(interactive && covering?.id && endKey === key);
          const className = `relative flex h-7 items-center justify-center rounded-md text-[11px] font-medium sm:h-8 sm:text-xs ${dayClasses(displayTone, isPast, isToday)} ${
            interactive && tone !== "booked" ? "cursor-pointer" : ""
          } ${interactive && tone === "booked" ? "cursor-not-allowed" : ""}`;

          if (!interactive) {
            return (
              <span key={key} data-day={key} data-tone={tone} className={className}>
                {cell.getDate()}
              </span>
            );
          }

          return (
            <span
              key={key}
              data-day={key}
              data-tone={tone}
              className={className}
              onPointerDown={(event) => onDayPointerDown(key, tone, event)}
            >
              {showStartHandle && covering?.id ? (
                <button
                  type="button"
                  aria-label="Move occupied start"
                  data-attr="listing-v2-room-calendar-handle-start"
                  className="absolute left-0 top-1/2 z-[1] h-3.5 w-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white bg-primary shadow-sm"
                  onPointerDown={(event) => onHandlePointerDown(covering.id!, "start", key, event)}
                />
              ) : null}
              {showEndHandle && covering?.id ? (
                <button
                  type="button"
                  aria-label="Move occupied end"
                  data-attr="listing-v2-room-calendar-handle-end"
                  className="absolute right-0 top-1/2 z-[1] h-3.5 w-3.5 translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white bg-primary shadow-sm"
                  onPointerDown={(event) => onHandlePointerDown(covering.id!, "end", key, event)}
                />
              ) : null}
              {chipAnchor === key && chipLabel ? (
                <span className="pointer-events-none absolute bottom-[calc(100%+4px)] left-1/2 z-[2] -translate-x-1/2 whitespace-nowrap rounded-full bg-foreground px-2 py-0.5 text-[10px] font-bold text-background">
                  {chipLabel}
                </span>
              ) : null}
              {cell.getDate()}
            </span>
          );
        })}
      </div>
    </>
  );
}

const NAV_BUTTON =
  "flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-border bg-card text-muted transition hover:border-primary/45 hover:bg-accent/35 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-45";

export function RoomAvailabilityMonthCalendar({
  spans,
  legend = false,
  dataAttr,
  interactive,
  loading = false,
}: {
  spans: readonly RoomCalendarSpan[];
  /** Print the three-colour key under the grid (the editor); the public page explains it in its own words. */
  legend?: boolean;
  dataAttr?: string;
  /** Editor-only. Public listing omits this and stays read-only. */
  interactive?: RoomCalendarInteraction;
  loading?: boolean;
}) {
  const today = startOfLocalDay(new Date());
  const { startMonth, monthCount } = resolveAvailabilityMonthRange(spans);
  const spansKey = spans.map((s) => `${s.id ?? ""}|${s.start?.toISOString() ?? ""}|${s.end?.toISOString() ?? ""}|${s.tone}`).join(",");
  const [monthOffset, setMonthOffset] = useState(0);
  const [prevSpansKey, setPrevSpansKey] = useState(spansKey);
  if (spansKey !== prevSpansKey) {
    setPrevSpansKey(spansKey);
    setMonthOffset(0);
  }

  const clampedOffset = Math.min(Math.max(monthOffset, 0), Math.max(monthCount - 1, 0));
  const monthStart = addMonths(startMonth, clampedOffset);
  const tone = monthAvailabilityTone(monthStart, spans, today);

  const [drag, setDrag] = useState<Drag | null>(null);
  const dragRef = useRef<Drag | null>(null);
  const holdTimerRef = useRef<number | null>(null);
  const holdOriginRef = useRef<{ x: number; y: number; dayKey: string } | null>(null);
  const interactiveRef = useRef(interactive);
  const spansRef = useRef(spans);
  useLayoutEffect(() => {
    interactiveRef.current = interactive;
    spansRef.current = spans;
  }, [interactive, spans]);

  const clearHold = () => {
    if (holdTimerRef.current != null) {
      window.clearTimeout(holdTimerRef.current);
      holdTimerRef.current = null;
    }
    holdOriginRef.current = null;
  };

  const isBookedKey = useCallback((dayKey: string) => {
    const [y, m, d] = dayKey.split("-").map(Number);
    if (!y || !m || !d) return true;
    return roomCalendarDayTone(new Date(y, m - 1, d), spansRef.current) === "booked";
  }, []);

  const dayKeyFromPoint = (clientX: number, clientY: number): string | null => {
    const node = document.elementFromPoint(clientX, clientY);
    const el = node instanceof Element ? node.closest("[data-day]") : null;
    return el?.getAttribute("data-day") ?? null;
  };

  const commitDrag = useCallback(() => {
    const pending = dragRef.current;
    dragRef.current = null;
    setDrag(null);
    const api = interactiveRef.current;
    if (!pending || !api) return;
    if (pending.kind === "paint") {
      const clipped = clipPaintRange(pending.origin, pending.end, isBookedKey);
      if (clipped) api.onPaintRange(clipped.start, clipped.end);
      return;
    }
    api.onResizeOccupied(pending.id, pending.edge, pending.end);
  }, [isBookedKey]);

  const updateDragEnd = useCallback(
    (dayKey: string) => {
      const pending = dragRef.current;
      if (!pending || pending.end === dayKey) return;
      if (pending.kind === "paint" && isBookedKey(dayKey)) return;
      const next = { ...pending, end: dayKey };
      dragRef.current = next;
      setDrag(next);
    },
    [isBookedKey],
  );

  useEffect(() => {
    if (!drag) return;
    const onMove = (event: PointerEvent) => {
      const key = dayKeyFromPoint(event.clientX, event.clientY);
      if (key) updateDragEnd(key);
    };
    const onUp = () => commitDrag();
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };
  }, [drag, commitDrag, updateDragEnd]);

  const beginPaint = (dayKey: string) => {
    const next: Drag = { kind: "paint", origin: dayKey, end: dayKey };
    dragRef.current = next;
    setDrag(next);
  };

  const onDayPointerDown = (dayKey: string, tone: RoomCalendarSpanTone | "open", event: ReactPointerEvent) => {
    if (!interactive || loading) return;
    if (tone === "booked") return;
    if (tone === "occupied") return;
    if (event.button !== 0 && event.pointerType !== "touch") return;
    if (event.pointerType === "touch") {
      holdOriginRef.current = { x: event.clientX, y: event.clientY, dayKey };
      holdTimerRef.current = window.setTimeout(() => {
        holdTimerRef.current = null;
        const origin = holdOriginRef.current;
        holdOriginRef.current = null;
        if (origin) beginPaint(origin.dayKey);
      }, HOLD_MS);
      return;
    }
    event.preventDefault();
    beginPaint(dayKey);
  };

  const onHandlePointerDown = (id: string, edge: "start" | "end", dayKey: string, event: ReactPointerEvent) => {
    if (!interactive || loading) return;
    event.preventDefault();
    event.stopPropagation();
    const next: Drag = { kind: "resize", id, edge, origin: dayKey, end: dayKey };
    dragRef.current = next;
    setDrag(next);
  };

  useEffect(() => {
    if (!interactive) return;
    const onMove = (event: PointerEvent) => {
      const hold = holdOriginRef.current;
      if (!hold || holdTimerRef.current == null) return;
      const dx = event.clientX - hold.x;
      const dy = event.clientY - hold.y;
      if (dx * dx + dy * dy > HOLD_CANCEL_PX * HOLD_CANCEL_PX) clearHold();
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", clearHold);
    window.addEventListener("pointercancel", clearHold);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", clearHold);
      window.removeEventListener("pointercancel", clearHold);
    };
  }, [interactive]);

  useEffect(() => () => clearHold(), []);

  return (
    <div
      className={`rounded-xl border border-border bg-card p-3 sm:p-4 ${drag ? "select-none" : ""} ${interactive ? "touch-pan-y" : ""}`}
      data-attr={dataAttr}
      style={drag ? { touchAction: "none" } : undefined}
    >
      <div className="mb-3 flex items-center justify-between gap-2">
        <button
          type="button"
          aria-label="Previous month"
          className={NAV_BUTTON}
          disabled={clampedOffset <= 0}
          onClick={() => setMonthOffset((value) => Math.max(value - 1, 0))}
        >
          <ChevronLeft className="h-4 w-4" aria-hidden />
        </button>
        <div className="min-w-0 flex flex-1 flex-col items-center gap-1 text-center">
          <p className="text-sm font-semibold text-foreground">
            {monthStart.toLocaleDateString("en-US", { month: "long", year: "numeric" })}
          </p>
          <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${monthTonePillClasses(tone)}`}>{monthToneLabel(tone)}</span>
        </div>
        <button
          type="button"
          aria-label="Next month"
          className={NAV_BUTTON}
          disabled={clampedOffset >= monthCount - 1}
          onClick={() => setMonthOffset((value) => Math.min(value + 1, monthCount - 1))}
        >
          <ChevronRight className="h-4 w-4" aria-hidden />
        </button>
      </div>
      <MonthGrid
        monthStart={monthStart}
        spans={spans}
        today={today}
        loading={loading}
        interactive={Boolean(interactive) && !loading}
        drag={drag}
        onDayPointerDown={onDayPointerDown}
        onHandlePointerDown={onHandlePointerDown}
      />
      {legend ? (
        <ul className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-[11.5px] font-medium text-muted" aria-label="Calendar key">
          <li className="inline-flex items-center gap-1.5"><span aria-hidden className={`inline-block h-2.5 w-2.5 rounded-sm ${DAY_OPEN}`} />Available</li>
          <li className="inline-flex items-center gap-1.5"><span aria-hidden className={`inline-block h-2.5 w-2.5 rounded-sm ${DAY_OCCUPIED}`} />Booked</li>
        </ul>
      ) : null}
    </div>
  );
}
