"use client";

/**
 * A room's Availability, on the Rooms step.
 *
 * A room is available by default. This block lists only the spans that close
 * it: the manager's own occupied dates (editable Start → End, End optional),
 * and — read-only, grey — whatever bookings already say: a resident's stay, a
 * Bookings block, an Airbnb import. The round + in the header adds a row
 * starting today; once a row exists a dashed "+ Add occupied dates" footer
 * under the list adds the next one, starting the day after the last End; ✕
 * removes one. Nothing here is a status switch and nothing is printed about
 * what renters see: the dates ARE the status. The calendar toggle shows the
 * same spans as a month grid, read-only.
 *
 * Every change still writes the room's `manualUnavailableRanges` together with
 * the derived `availability` label and `moveInAvailableDate`, so the public
 * card, the side panel and the SMS agent keep reading the fields they always
 * read — the label is just no longer shown here.
 */

import { useEffect, useMemo, useState } from "react";
import { CalendarDays, Plus } from "lucide-react";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { RoomAvailabilityMonthCalendar, type RoomCalendarSpan } from "@/components/room-availability-month-calendar";
import { localDateFromDateKey } from "@/lib/room-availability-calendar";
import type { ManagerRoomSubmission, ManagerRoomUnavailableRange } from "@/lib/manager-listing-submission";
import { fetchRoomDateBlocks } from "@/lib/channel-calendar/room-date-blocks";
import { lastNightBeforeCheckout, roomBlockSummary } from "@/lib/channel-calendar/property-bookings";
import { LISTING_ROOM_CHOICE_SEP, getRoomUnavailabilityWindows } from "@/lib/rental-application/data";
import {
  dateKeyFromDate,
  deriveRoomAvailability,
  formatDateKeyShort,
  isChannelImportedRangeId,
  legacyMoveInDateAsSpan,
  manualRangesToSpans,
  newOccupiedRangeId,
  roomAvailabilityPatch,
  shiftDateKey,
  spanEndsBeforeStart,
  todayDateKey,
  type OccupiedSpan,
} from "@/lib/room-availability-timeline";

const LEGACY_ID = "legacy-available-from";

/**
 * Spans other surfaces already know about for this room: residents' stays (from
 * approved applications) and Bookings blocks. Airbnb imports live on the room
 * itself and are picked out by id. Empty for a listing that has no id yet.
 */
function useBookedSpans(propertyId: string | null | undefined, roomId: string): OccupiedSpan[] {
  const [blocks, setBlocks] = useState<OccupiedSpan[]>([]);
  useEffect(() => {
    if (!propertyId) return;
    let cancelled = false;
    fetchRoomDateBlocks()
      .then((rows) => {
        if (cancelled) return;
        setBlocks(
          rows
            .filter((b) => b.propertyId === propertyId && (b.roomId === roomId || b.roomId === ""))
            .map((b) => ({
              id: `block-${b.id}`,
              start: b.checkIn,
              end: lastNightBeforeCheckout(b.checkOut),
              source: "block" as const,
              label: b.residentName?.trim() ? `Held · ${roomBlockSummary(b)}` : `Blocked${b.reason.trim() ? ` · ${b.reason.trim()}` : ""}`,
            })),
        );
      })
      .catch(() => {
        /* the manual rows never wait on this */
      });
    return () => {
      cancelled = true;
    };
  }, [propertyId, roomId]);

  const residents = useMemo<OccupiedSpan[]>(() => {
    if (!propertyId) return [];
    try {
      return getRoomUnavailabilityWindows(`${propertyId}${LISTING_ROOM_CHOICE_SEP}${roomId}`)
        .filter((w) => w.source === "resident" && w.start)
        .map((w, i) => ({
          id: `resident-${i}`,
          start: dateKeyFromDate(w.start as Date),
          end: w.end ? dateKeyFromDate(w.end) : null,
          source: "resident" as const,
          label: "Resident",
        }));
    } catch {
      return [];
    }
  }, [propertyId, roomId]);

  return useMemo(() => [...residents, ...blocks], [residents, blocks]);
}

export function OccupiedDates({
  room,
  propertyId,
  onRoom,
}: {
  room: ManagerRoomSubmission;
  /** The listing's record id when it has one; booked rows need it to find the room. */
  propertyId: string | null | undefined;
  onRoom: (patch: Partial<ManagerRoomSubmission>) => void;
}) {
  const today = todayDateKey();
  const stored = room.manualUnavailableRanges ?? [];
  const manual = stored.filter((r) => !isChannelImportedRangeId(r.id));
  const channel = manualRangesToSpans(stored.filter((r) => isChannelImportedRangeId(r.id)));
  const booked = useBookedSpans(propertyId, room.id);

  // A room saved with only a future "Available from" shows that as one occupied row until it is touched.
  const legacy = manual.length === 0 ? legacyMoveInDateAsSpan(room.moveInAvailableDate, today) : null;
  const rows: ManagerRoomUnavailableRange[] = legacy ? [{ id: LEGACY_ID, start: legacy.start, end: legacy.end }] : manual;

  const readout = deriveRoomAvailability([...manualRangesToSpans(rows), ...channel, ...booked], today);

  const write = (nextManual: ManagerRoomUnavailableRange[]) => {
    const materialized = nextManual.map((r) => (r.id === LEGACY_ID ? { ...r, id: newOccupiedRangeId() } : r));
    const channelRows = stored.filter((r) => isChannelImportedRangeId(r.id));
    onRoom(roomAvailabilityPatch([...materialized, ...channelRows], booked, today));
  };

  const add = () => {
    if (rows.some((r) => !r.end)) return; // a row with no End already closes the room; set an End first
    const covering = readout.current;
    // Next range starts the day after the room is free again, or after the
    // latest typed End when every row is in the future; today when nothing closes it.
    const latestEnd = rows.reduce<string | null>((acc, r) => (r.end && (!acc || r.end > acc) ? r.end : acc), null);
    const start = covering?.end ? (readout.availableFrom || today) : latestEnd ? shiftDateKey(latestEnd, 1) : today;
    write([...rows, { id: newOccupiedRangeId(), start, end: null }]);
  };
  const edit = (id: string, patch: Partial<Pick<ManagerRoomUnavailableRange, "start" | "end">>) =>
    write(rows.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  const remove = (id: string) => write(rows.filter((r) => r.id !== id));

  const readOnly: OccupiedSpan[] = [...booked, ...channel].sort((a, b) => a.start.localeCompare(b.start));
  const sortedRows = [...rows].sort((a, b) => a.start.localeCompare(b.start));
  const anyRows = sortedRows.length + readOnly.length > 0;
  const blockedAdd = rows.some((r) => !r.end);
  const addTitle = blockedAdd ? "Set an End date on the open row first" : "Set occupied dates";

  const [view, setView] = useState<"list" | "calendar">("list");
  // Cheap enough to derive every render; the rows are a handful at most.
  const calendarSpans: RoomCalendarSpan[] = [...manualRangesToSpans(sortedRows), ...readOnly]
    .filter((s) => !spanEndsBeforeStart(s))
    .map((s) => ({ start: localDateFromDateKey(s.start), end: localDateFromDateKey(s.end), tone: s.source === "manual" ? "occupied" : "booked" }));

  return (
    <div className="px-3.5 pb-3 pt-2" data-attr="listing-v2-room-availability">
      <div className="mb-2 flex items-center justify-between gap-2">
        <span className="text-[12.5px] font-bold text-foreground">Availability</span>
        <span className="inline-flex items-center gap-1.5">
          <button
            type="button"
            onClick={() => setView((v) => (v === "calendar" ? "list" : "calendar"))}
            aria-pressed={view === "calendar"}
            aria-label={view === "calendar" ? "Back to the list" : "View on calendar"}
            title={view === "calendar" ? "Back to the list" : "View on calendar"}
            data-attr="listing-v2-room-availability-view"
            className={cn(
              "inline-flex h-9 w-9 items-center justify-center rounded-full border border-border bg-card text-muted transition hover:border-primary/45 hover:text-foreground",
              view === "calendar" && "border-primary/45 bg-accent/40 text-primary",
            )}
          >
            <CalendarDays className="h-[17px] w-[17px]" aria-hidden />
          </button>
          <button
            type="button"
            onClick={add}
            disabled={blockedAdd}
            aria-label="Set occupied dates"
            title={addTitle}
            data-attr="listing-v2-room-set-occupied"
            className="inline-flex h-9 w-9 items-center justify-center rounded-full border border-border bg-card text-primary transition hover:border-primary/45 hover:bg-accent/40 disabled:cursor-not-allowed disabled:opacity-45"
          >
            <Plus className="h-5 w-5" aria-hidden />
          </button>
        </span>
      </div>

      {view === "calendar" ? (
        <RoomAvailabilityMonthCalendar spans={calendarSpans} legend dataAttr="listing-v2-room-availability-calendar" />
      ) : anyRows ? (
        <ul className="divide-y divide-border overflow-hidden rounded-xl border border-border" data-attr="listing-v2-room-occupied-list">
          {readOnly.map((span) => (
            <li key={span.id} className="grid grid-cols-[1fr_auto] items-center gap-2 bg-foreground/[0.03] px-3 py-2 text-[13px] sm:grid-cols-[minmax(0,1.2fr)_1fr_auto_1fr_auto]">
              <span className="truncate font-semibold text-foreground/80">{span.label ?? "Occupied"}</span>
              <span className="text-muted sm:justify-self-start">{formatDateKeyShort(span.start)}</span>
              <span aria-hidden className="hidden text-muted sm:inline">→</span>
              <span className="hidden text-muted sm:inline">{span.end ? formatDateKeyShort(span.end) : "No end date"}</span>
              <span className="col-span-2 text-[12px] text-muted sm:col-span-1 sm:justify-self-end">{span.source === "channel" ? "From the calendar sync" : "Change it in Bookings"}</span>
            </li>
          ))}
          {sortedRows.map((r) => {
            const bad = spanEndsBeforeStart(r);
            return (
              <li key={r.id} className="grid grid-cols-[1fr_1fr_auto] items-center gap-2 px-3 py-2 sm:grid-cols-[minmax(0,1.2fr)_1fr_auto_1fr_auto]" data-attr="listing-v2-room-occupied-row">
                <span className="col-span-3 inline-flex w-fit items-center rounded-full bg-foreground/[0.08] px-2.5 py-0.5 text-[11.5px] font-bold text-foreground sm:col-span-1">Occupied</span>
                <Input
                  type="date"
                  aria-label="Occupied from"
                  value={r.start}
                  onChange={(e) => edit(r.id, { start: e.target.value })}
                  className="min-h-[38px] rounded-xl px-3 py-1.5 sm:text-[13.5px]"
                />
                <span aria-hidden className="hidden text-muted sm:inline">→</span>
                <Input
                  type="date"
                  aria-label="Occupied until"
                  value={r.end ?? ""}
                  aria-invalid={bad || undefined}
                  onChange={(e) => edit(r.id, { end: e.target.value ? e.target.value : null })}
                  className={`min-h-[38px] rounded-xl px-3 py-1.5 sm:text-[13.5px] ${bad ? "border-red-500 text-red-600" : ""}`}
                />
                <button
                  type="button"
                  onClick={() => remove(r.id)}
                  aria-label="Remove these occupied dates"
                  data-attr="listing-v2-room-occupied-remove"
                  className="justify-self-end text-[16px] leading-none text-muted hover:text-red-600"
                >
                  ✕
                </button>
                {bad ? <p className="col-span-full text-[12px] font-semibold text-red-600">End is before Start</p> : null}
              </li>
            );
          })}
          {sortedRows.length > 0 ? (
            <li className="border-dashed">
              <button
                type="button"
                onClick={add}
                disabled={blockedAdd}
                aria-label="Add occupied dates"
                title={addTitle}
                data-attr="listing-v2-room-occupied-add"
                className="flex w-full items-center justify-center gap-2 px-3 py-2.5 text-[13px] font-semibold text-primary transition hover:bg-accent/40 disabled:cursor-not-allowed disabled:opacity-45"
              >
                <Plus className="h-4 w-4" aria-hidden />
                Add occupied dates
              </button>
            </li>
          ) : null}
        </ul>
      ) : null}
    </div>
  );
}
