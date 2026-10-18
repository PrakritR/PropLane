"use client";

import { memo, useState, useSyncExternalStore, type CSSProperties, type KeyboardEvent, type PointerEvent, type ReactNode } from "react";
import { ArrowUpRight, Ban, Pencil, Trash2 } from "lucide-react";
import Link from "next/link";
import { BookingsAirbnbIcon } from "@/components/portal/bookings-airbnb-icon";
import { barDisplayName, BAR_VISUAL_HEIGHT, LANE_PITCH, dayDiff } from "@/components/portal/bookings-timeline-layout";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { VaulBottomSheet } from "@/components/ui/vaul-bottom-sheet";
import { NO_ROOM_FOR_POPOVER_QUERY } from "@/components/ui/portal-surface";
import { isChannelBookingSource, type PropertyBookingEntry } from "@/lib/channel-calendar/property-bookings";
import { bookingEntryKey } from "@/lib/channel-calendar/bookings-ui";
import { bookingCheckout, calendarStatus, calendarStatusClass } from "@/lib/channel-calendar/bookings-calendar-view";
import { bookingRemovalActions } from "@/lib/channel-calendar/booking-presentation";
import { bookingRecordHref } from "@/lib/portal-detail-routes";

export type BookingBarHandlers = {
  onEdit?: (entry: PropertyBookingEntry) => void;
  onUnblock?: (entry: PropertyBookingEntry) => void;
  onDeleteBlock?: (entry: PropertyBookingEntry) => void;
  onUnblockChannelStay?: (entry: PropertyBookingEntry) => void;
  canRemove?: (entry: PropertyBookingEntry) => boolean;
};

const dateLabel = (key: string) => new Date(`${key}T12:00:00`).toLocaleDateString("en-US", { month: "short", day: "numeric" });

function subscribeNarrow(notify: () => void) {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return () => {};
  const mql = window.matchMedia(NO_ROOM_FOR_POPOVER_QUERY);
  mql.addEventListener("change", notify);
  return () => mql.removeEventListener("change", notify);
}
/** True on a phone-width viewport (the repo's `(max-width: 639px)` decision). Server and first paint say false. */
export function useIsPhoneWidth(): boolean {
  return useSyncExternalStore(
    subscribeNarrow,
    () => (typeof window !== "undefined" && typeof window.matchMedia === "function" ? window.matchMedia(NO_ROOM_FOR_POPOVER_QUERY).matches : false),
    () => false,
  );
}

function channelGlyph(entry: PropertyBookingEntry) {
  return entry.source === "airbnb" ? <BookingsAirbnbIcon aria-label="Airbnb" role="img" className="mr-1 inline h-3 w-3 align-[-1px]" strokeWidth={1.7} /> : null;
}

/** The popover (desktop) and sheet (phone) share one set of facts. */
function barFacts(entry: PropertyBookingEntry, today: string) {
  const checkout = bookingCheckout(entry);
  return { status: calendarStatus(entry, today), dates: `${dateLabel(entry.start)} – ${checkout ? dateLabel(checkout) : "Open-ended"}`, room: entry.roomLabel || "Whole home" };
}

export type BookingBarProps = {
  entry: PropertyBookingEntry;
  today: string;
  /** Position inside the track, in px. Omit for an in-flow bar (Day view). */
  placement?: { left: number; top: number; width: number; /** Px of the bar hidden under the label column; the name starts after it so it is never cut. */ nameInset: number; narrow: boolean; labelWidth: number };
  conflict?: boolean;
  /** Day view: a taller bar with a second line. */
  detail?: ReactNode;
  className?: string;
  /** Present on a phone: tapping opens the sheet instead of the popover. */
  onOpenSheet?: (entry: PropertyBookingEntry) => void;
} & BookingBarHandlers;

/**
 * One bar and its info popover (desktop). The popover is NON-modal with no scrim: it is a light card, so opening
 * it never locks the page (no `pointer-events: none` on <body>) and a dialog opened from an item cannot inherit one.
 * The button is the 44px touch target; the 32px coloured bar sits inside it. When the bar's start scrolls under the
 * label column the name is inset by the hidden width (`nameInset`), so it slides along and truncates, never cut at the front.
 */
export const BookingBar = memo(function BookingBar({ entry, today, placement, conflict, detail, className, onOpenSheet, onEdit, onUnblock, onDeleteBlock, onUnblockChannelStay, canRemove }: BookingBarProps) {
  const [armed, setArmed] = useState(false);
  const removal = bookingRemovalActions(entry, today, canRemove ? canRemove(entry) : true);
  const { status, dates, room } = barFacts(entry, today);
  const name = barDisplayName(entry);
  const style: CSSProperties | undefined = placement ? { position: "absolute", left: placement.left, top: placement.top, width: placement.width + (placement.narrow ? placement.labelWidth + 4 : 0), height: LANE_PITCH } : undefined;
  const visual = `${calendarStatusClass(status)} ${conflict ? "ring-2 ring-red-500" : ""}`;
  const face = placement?.narrow ? (
    <>
      <span data-bar-visual="" className={`block shrink-0 rounded-lg ${visual}`} style={{ width: placement.width, height: BAR_VISUAL_HEIGHT }} />
      {placement.labelWidth ? <span className="ml-1 block truncate text-xs font-medium text-foreground" style={{ width: placement.labelWidth }}>{channelGlyph(entry)}{name}</span> : <span className="sr-only">{name}</span>}
    </>
  ) : (
    <span data-bar-visual="" className={`flex min-w-0 flex-1 flex-col justify-center overflow-clip rounded-lg text-left text-[13px] ${placement ? "" : "min-h-8 py-1"} ${visual}`} style={placement ? { height: BAR_VISUAL_HEIGHT } : undefined}>
      <span className={placement ? "block truncate px-2 font-semibold leading-8" : "block truncate px-2 font-semibold"} style={placement ? { marginLeft: placement.nameInset, maxWidth: placement.width - placement.nameInset } : undefined}>{channelGlyph(entry)}{name}</span>
      {detail}
    </span>
  );
  const buttonClass = `group flex items-center text-left outline-none focus-visible:[&_[data-bar-visual]]:ring-2 focus-visible:[&_[data-bar-visual]]:ring-primary ${className ?? ""}`;
  const trigger = (extra: { onPointerDown?: (event: PointerEvent<HTMLButtonElement>) => void; onKeyDown?: (event: KeyboardEvent<HTMLButtonElement>) => void; onClick?: () => void } = {}) => <button type="button" style={style} className={buttonClass} data-attr="bookings-calendar-bar" aria-label={`${name}, ${status}`} {...extra}>{face}</button>;
  if (onOpenSheet) return trigger({ onClick: () => onOpenSheet(entry) });
  // A Radix menu per bar costs ~6ms each to mount (dev), which is what made a screenful of rows slow. The bar is a
  // plain button until it is first used; that first pointerdown / key press mounts the menu already open.
  if (!armed) {
    return trigger({
      onPointerDown: event => { if (event.button === 0 && !event.ctrlKey) setArmed(true); },
      onKeyDown: event => { if (["Enter", " ", "ArrowDown"].includes(event.key)) { event.preventDefault(); setArmed(true); } },
    });
  }
  return <DropdownMenu modal={false} defaultOpen><DropdownMenuTrigger asChild>{trigger()}</DropdownMenuTrigger><DropdownMenuContent align="start" backdrop={false} className="max-w-[calc(100vw-2rem)]">
    <div className="grid gap-2 p-3 text-sm"><strong>{name}</strong><span>{dates}</span><span>{room}</span><span>{status}</span></div>
    {onEdit && !isChannelBookingSource(entry.source) ? <DropdownMenuItem onSelect={() => onEdit(entry)}><Pencil />Edit</DropdownMenuItem> : null}
    {removal.unblock && onUnblock ? <DropdownMenuItem onSelect={() => onUnblock(entry)} data-attr="bookings-bar-unblock"><Ban />Unblock</DropdownMenuItem> : null}
    {removal.unblockChannel && onUnblockChannelStay ? <DropdownMenuItem onSelect={() => onUnblockChannelStay(entry)} data-attr="bookings-bar-unblock-channel"><Ban />Unblock in PropLane</DropdownMenuItem> : null}
    {removal.deleteBlock && onDeleteBlock ? <DropdownMenuItem onSelect={() => onDeleteBlock(entry)} data-attr="bookings-bar-delete"><Trash2 />Delete</DropdownMenuItem> : null}
    <DropdownMenuItem asChild><Link href={bookingRecordHref("/portal", bookingEntryKey(entry))}><ArrowUpRight />Open booking</Link></DropdownMenuItem>
  </DropdownMenuContent></DropdownMenu>;
});

const SHEET_ROW = "flex min-h-11 w-full items-center gap-3 rounded-lg px-3 text-left text-[15px] font-semibold text-foreground hover:bg-accent/40 focus-visible:bg-accent/40 focus-visible:outline-none [&_svg]:size-[18px] [&_svg]:shrink-0 [&_svg]:text-muted";

/** The phone's bar sheet: title = guest, facts as label/value rows, the popover's actions as 44px rows. */
export function BookingBarSheet({ entry, open, today, onClose, onEdit, onUnblock, onDeleteBlock, onUnblockChannelStay, canRemove }: { entry: PropertyBookingEntry | null; open: boolean; today: string; onClose: () => void } & BookingBarHandlers) {
  if (!entry) return null;
  const removal = bookingRemovalActions(entry, today, canRemove ? canRemove(entry) : true);
  const { status, dates, room } = barFacts(entry, today);
  const nights = entry.openEnded ? null : dayDiff(bookingCheckout(entry)!, entry.start);
  // Close first so the dialog an action opens is not stacked under the sheet; let the close animation start.
  const run = (action: (entry: PropertyBookingEntry) => void) => () => { onClose(); window.setTimeout(() => action(entry), 120); };
  return <VaulBottomSheet open={open} onOpenChange={next => { if (!next) onClose(); }} title={barDisplayName(entry)} flushBody assistantStrip={false}>
    <div data-attr="bookings-bar-sheet" className="pb-[max(0.5rem,env(safe-area-inset-bottom,0px))]">
      <dl className="grid grid-cols-[5rem_1fr] gap-x-3 gap-y-2 px-4 pb-3 text-[15px]">
        <dt className="text-muted">Dates</dt><dd className="font-semibold text-foreground">{dates}{nights ? ` · ${nights} night${nights === 1 ? "" : "s"}` : ""}</dd>
        <dt className="text-muted">Room</dt><dd className="font-semibold text-foreground">{room}</dd>
        <dt className="text-muted">Status</dt><dd className="font-semibold text-foreground">{status}</dd>
      </dl>
      <div className="grid gap-0.5 border-t border-border px-2 pt-2">
        {onEdit && !isChannelBookingSource(entry.source) ? <button type="button" className={SHEET_ROW} onClick={run(onEdit)}><Pencil aria-hidden />Edit</button> : null}
        {removal.unblock && onUnblock ? <button type="button" className={SHEET_ROW} data-attr="bookings-bar-unblock" onClick={run(onUnblock)}><Ban aria-hidden />Unblock</button> : null}
        {removal.unblockChannel && onUnblockChannelStay ? <button type="button" className={SHEET_ROW} data-attr="bookings-bar-unblock-channel" onClick={run(onUnblockChannelStay)}><Ban aria-hidden />Unblock in PropLane</button> : null}
        {removal.deleteBlock && onDeleteBlock ? <button type="button" className={`${SHEET_ROW} !text-[var(--status-overdue-fg)] [&_svg]:!text-[var(--status-overdue-fg)]`} data-attr="bookings-bar-delete" onClick={run(onDeleteBlock)}><Trash2 aria-hidden />Delete</button> : null}
        <Link className={SHEET_ROW} href={bookingRecordHref("/portal", bookingEntryKey(entry))} onClick={onClose}><ArrowUpRight aria-hidden />Open booking</Link>
      </div>
    </div>
  </VaulBottomSheet>;
}
