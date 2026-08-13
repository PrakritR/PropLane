"use client";

import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input, NativeSelect, Select } from "@/components/ui/input";
import { FieldSingleSelect } from "@/components/ui/checkbox-multi-select";
import { Modal, ModalFooter, MODAL_HEADER_CLOSE_CLASS } from "@/components/ui/modal";
import { X } from "lucide-react";
import { PortalNotificationPreviewModal, type NotificationConfirmDraft } from "@/components/portal/portal-notification-preview-modal";
import { TourReminderTourPanel } from "@/components/portal/tour-reminder-tour-panel";
import { PORTAL_CALENDAR_FRAME, PortalSegmentedControl } from "./portal-metrics";
import { useAppUi } from "@/components/providers/app-ui-provider";
import { formatPacificDate } from "@/lib/pacific-time";
import { formatTourContactPhoneDisplay } from "@/lib/tour-contact-quality";
import { getPropertyById } from "@/lib/rental-application/data";
import {
  TOUR_CANCELED_TENANT_SUBJECT,
  TOUR_CONFIRMED_TENANT_SUBJECT,
  TOUR_REQUEST_REMOVED_TENANT_SUBJECT,
  buildTourCanceledTenantBody,
  buildTourConfirmedTenantBody,
  buildTourNotificationContext,
  buildTourRequestRemovedTenantBody,
} from "@/lib/tour-notifications";
import { deliverPortalInboxMessage } from "@/lib/portal-message-delivery";
import {
  DEFAULT_EVENT_DURATION_MINUTES,
  EVENT_DURATION_PRESET_MINUTES,
  MAX_EVENT_DURATION_MINUTES,
  MIN_EVENT_DURATION_MINUTES,
  SLOTS_PER_DAY,
  SLOT_DURATION_MINUTES,
  acceptPartnerInquiryFromServer,
  clampEventDurationMinutes,
  dateHasAvailability,
  dateSlotKey,
  deletePartnerInquiryFromServer,
  deletePlannedEventFromServer,
  endIsoForDuration,
  formatRangeLabel,
  formatAvailabilitySlotLabel,
  readPlannedEvents,
  readAvailabilityDateSetForStorageKey,
  startOfWeekMonday,
  syncScheduleRecordsFromServer,
  toLocalDateStr,
  writeAvailabilityDateSetForStorageKeyToServer,
} from "@/lib/demo-admin-scheduling";
import { mondayBasedDayIndex, resolveBlockBaseDates } from "@/lib/portal/availability-block";
import {
  defaultTourSlotKeysForDate,
  resolveTourOfferingSlots,
  slotIsBookable,
} from "@/lib/tour-slot-math";
import { cn } from "@/lib/utils";
import { HORIZONTAL_SCROLL_ATTR, PORTAL_HORIZONTAL_SCROLL_ROW_CLASS } from "@/lib/horizontal-scroll";
import {
  type CoManagerAvailabilityOverlay,
  type ScheduledTourFilter,
} from "@/lib/co-manager-calendar";
import { buildScheduledTourMeetings } from "@/lib/manager-calendar-tour-meetings";
import { isGoogleCalendarPrivateBlock, meetingCalendarGridLabel, calendarMeetingSupportsDelete, isPropPlaneGoogleTourMeeting, scheduledCalendarMeetings } from "@/lib/google-calendar/meetings";
import { deleteProplaneGoogleTourFromServer } from "@/lib/google-calendar/delete-tour.client";
import {
  cancelPlannedTourFromServer,
  tourGuestNotificationFailed,
} from "@/lib/tour-planned-change.client";
type CalendarMode = "day" | "week" | "month";
type RecurrenceCadence = "once" | "weekly" | "biweekly" | "monthly";
type DragSelection = {
  dateStr: string;
  weekday: number;
  startSlot: number;
  endSlotExclusive: number;
};

const SLOT_ROW_START = 0;
const SLOT_ROW_END = SLOTS_PER_DAY - 1;
const DEFAULT_VISIBLE_START_SLOT = 12; // 6:00 AM
const DEFAULT_VISIBLE_END_SLOT_EXCLUSIVE = 44; // 10:00 PM
const WEEKDAY_OPTIONS = [
  { value: 0, label: "Mon" },
  { value: 1, label: "Tue" },
  { value: 2, label: "Wed" },
  { value: 3, label: "Thu" },
  { value: 4, label: "Fri" },
  { value: 5, label: "Sat" },
  { value: 6, label: "Sun" },
] as const;

const CALENDAR_HEADER_CELL =
  "bg-accent/30 font-bold uppercase tracking-[0.12em] text-muted [html[data-theme=dark]_&]:portal-calendar-header-cell";
const CALENDAR_TIME_CELL =
  "whitespace-nowrap text-[10px] font-semibold tabular-nums text-muted sm:text-[11px] [html[data-theme=dark]_&]:portal-calendar-time-cell";
const CALENDAR_GRID_GAP = "gap-px bg-accent/40 [html[data-theme=dark]_&]:portal-calendar-grid";
const CALENDAR_OPEN_SLOT =
  "bg-emerald-100 text-emerald-950 ring-1 ring-inset ring-emerald-300 [html[data-theme=dark]_&]:portal-calendar-open-slot";
const CALENDAR_OPEN_SLOT_SOFT =
  "border-emerald-300 bg-emerald-100 text-emerald-900 [html[data-theme=dark]_&]:portal-calendar-open-slot";
/**
 * Bookable by the 9-5 default, not by anything the manager painted. Deliberately
 * a dashed, lower-contrast cousin of the painted-open style: it IS live to
 * prospects (so it must not read as empty), but it is not a deliberate choice
 * the manager made (so it must not read the same as painted availability).
 */
const CALENDAR_DEFAULT_OPEN_SLOT =
  "bg-emerald-50 text-emerald-800 ring-1 ring-inset ring-dashed ring-emerald-300/70 hover:bg-emerald-100 [html[data-theme=dark]_&]:portal-calendar-open-slot";
const CALENDAR_BADGE_SUCCESS =
  "rounded-full portal-badge-success";
const CALENDAR_BADGE_INFO =
  "rounded-full portal-badge-info";
const CALENDAR_BADGE_ERROR =
  "rounded-full portal-badge-danger";
const CALENDAR_OPEN_COUNT = "text-emerald-700 [html[data-theme=dark]_&]:portal-calendar-open-count";
const CALENDAR_EMPTY_SLOT =
  "bg-card text-transparent hover:bg-primary/[0.07] hover:text-primary [html[data-theme=dark]_&]:portal-calendar-empty-slot";
const CALENDAR_INACTIVE_SLOT =
  "border-border bg-accent/30 text-muted hover:border-primary/20 hover:bg-primary/[0.06] [html[data-theme=dark]_&]:portal-calendar-inactive-slot";
const CALENDAR_CO_MANAGER_SLOT =
  "border-violet-300 bg-violet-100 text-violet-950 ring-1 ring-inset ring-violet-300/80 [html[data-theme=dark]_&]:border-violet-400/40 [html[data-theme=dark]_&]:bg-violet-500/15 [html[data-theme=dark]_&]:text-violet-100";
const COMPACT_CALENDAR_ACTION_BTN =
  "h-7 shrink-0 whitespace-nowrap rounded-full border-border px-2.5 text-xs font-semibold max-lg:h-8 max-lg:px-3";
const COMPACT_TIME_SELECT_TRIGGER_FLAT =
  "h-8 min-h-0 shrink-0 rounded-md border-0 bg-transparent px-1 text-[11px] font-semibold whitespace-nowrap text-foreground shadow-none ring-0 hover:bg-accent/50 focus:border-transparent focus:ring-0 sm:text-xs";
export const MEETING_CONFIRMED_COLOR =
  "border-sky-300 bg-sky-100 text-sky-950 [html[data-theme=dark]_&]:portal-calendar-meeting-confirmed";
export const MEETING_PEER_COLOR =
  "border-indigo-300 bg-indigo-100 text-indigo-950 [html[data-theme=dark]_&]:portal-calendar-meeting-confirmed";
export const MEETING_PENDING_COLOR =
  "border-amber-300 bg-amber-100 text-amber-950 [html[data-theme=dark]_&]:portal-calendar-meeting-pending";

function addDays(d: Date, n: number): Date {
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 12, 0, 0, 0);
  x.setDate(x.getDate() + n);
  return x;
}

function addMonths(d: Date, n: number): Date {
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 12, 0, 0, 0);
  x.setMonth(x.getMonth() + n);
  return x;
}

function buildMonthCells(year: number, month: number): (number | null)[] {
  const first = new Date(year, month, 1, 12, 0, 0, 0);
  const pad = mondayBasedDayIndex(first);
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const cells: (number | null)[] = Array(pad).fill(null);
  for (let day = 1; day <= daysInMonth; day += 1) cells.push(day);
  while (cells.length % 7 !== 0) cells.push(null);
  return cells;
}

function formatWeekRangeMonSun(monday: Date): string {
  const sunday = addDays(monday, 6);
  const opts: Intl.DateTimeFormatOptions = { month: "short", day: "numeric" };
  // Match the day strip and slot grid — they use local calendar dates, not Pacific labels.
  return `${monday.toLocaleDateString(undefined, opts)}–${sunday.toLocaleDateString(undefined, { ...opts, year: "numeric" })}`;
}

function unionAvailabilityForStorageKeys(keys: string[]): Set<string> {
  const union = new Set<string>();
  for (const key of keys) {
    for (const slot of readAvailabilityDateSetForStorageKey(key)) union.add(slot);
  }
  return union;
}

function isInMonthPickRange(ds: string, pick: { start: string | null; end: string | null }): boolean {
  if (!pick.start) return false;
  if (!pick.end) return ds === pick.start;
  const lo = pick.start < pick.end ? pick.start : pick.end;
  const hi = pick.start < pick.end ? pick.end : pick.start;
  return ds >= lo && ds <= hi;
}

function formatNavTitle(anchor: Date, mode: CalendarMode): string {
  if (mode === "month") {
    return formatPacificDate(anchor, { month: "long", year: "numeric" });
  }
  if (mode === "week") {
    return formatWeekRangeMonSun(startOfWeekMonday(anchor));
  }
  return formatPacificDate(anchor, { weekday: "long", month: "short", day: "numeric", year: "numeric" });
}

export type DemoMeeting = {
  id: string;
  source: "planned" | "inquiry" | "external";
  sourceId: string;
  startIso: string;
  endIso: string;
  dateStr: string;
  startSlot: number;
  span: number;
  durationMinutes: number;
  title: string;
  color: string;
  statusLabel?: string;
  name?: string;
  email?: string;
  phone?: string;
  notes?: string;
  propertyTitle?: string;
  propertyId?: string;
  roomLabel?: string;
  instructions?: string;
  kind?: "partner" | "tour" | "service";
  hostLabel?: string;
  isPeerTour?: boolean;
  /** Personal Google Calendar busy time — title/details must not be shown in the UI. */
  googleCalendarPrivate?: boolean;
  /**
   * Does this meeting make the manager unavailable for a tour? Absent means yes.
   *
   * Only Google-sourced meetings ever set it false (an event marked Free, or an
   * invite the manager declined). Such an event still DRAWS on the calendar —
   * the manager wants to see it — but must not reduce the "N open" counts, or
   * the header would disagree with what the public booking page offers.
   */
  blocksTourAvailability?: boolean;
};

/** A meeting consumes a half hour unless it is explicitly non-blocking. */
export function meetingConsumesTourSlot(meeting: DemoMeeting): boolean {
  return meeting.blocksTourAvailability !== false;
}

function shiftDateStr(dateStr: string, days: number): string {
  const [year, month, day] = dateStr.split("-").map(Number);
  if (!year || !month || !day) return dateStr;
  // Noon anchor: a DST transition can never skip or repeat a calendar date.
  return toLocalDateStr(new Date(year, month - 1, day + days, 12, 0, 0, 0));
}

/**
 * Every `dateStr:slotIndex` a meeting occupies, rolling an index past the end of
 * a day onto the following date.
 *
 * A multi-day or all-day Google event has a ~96-slot span, so without the
 * rollover its later half emitted keys like `2026-08-06:48` that match no cell:
 * only the first day lost capacity in the "N open" headers, while the public
 * booking route — which works in real instants — blocked the whole span. That is
 * exactly the header-vs-public-page disagreement `blocksTourAvailability` exists
 * to close.
 */
export function meetingOccupiedSlotKeys(
  meeting: Pick<DemoMeeting, "dateStr" | "startSlot" | "span">,
): string[] {
  const keys: string[] = [];
  for (let offset = 0; offset < meeting.span; offset += 1) {
    const absolute = meeting.startSlot + offset;
    const dayOffset = Math.floor(absolute / SLOTS_PER_DAY);
    const slotIndex = absolute - dayOffset * SLOTS_PER_DAY;
    keys.push(
      dateSlotKey(dayOffset === 0 ? meeting.dateStr : shiftDateStr(meeting.dateStr, dayOffset), slotIndex),
    );
  }
  return keys;
}

/**
 * Which meeting a half hour DRAWS when two cover it — lower wins.
 *
 * A cell shows exactly one meeting, and the modal it opens is the only way to
 * reach that meeting's controls. A PropLane-owned tour therefore has to beat an
 * external Google busy block: a multi-day "Vacation" overlapping a confirmed
 * tour must not replace it with an untitled block whose modal offers no
 * Reschedule or Cancel tour. Ordering must be explicit rather than inherited
 * from the order `meetings` happens to be concatenated in.
 *
 * Open-slot math is unaffected — {@link takenSlotKeys} unions every covering
 * meeting, so a cell either kind covers is still not open.
 */
function calendarCellPriority(meeting: DemoMeeting): number {
  if (meeting.source === "planned" || meeting.source === "inquiry") return 0;
  if (isGoogleCalendarPrivateBlock(meeting)) return 2;
  return 1;
}

type CalendarBlockSelection =
  | { kind: "availability"; dateStr: string; slotIndex: number }
  | { kind: "meeting"; meeting: DemoMeeting };

const slotRowIndices = Array.from({ length: SLOT_ROW_END - SLOT_ROW_START + 1 }, (_, i) => SLOT_ROW_START + i);

function formatSlotEndLabel(slotIndexExclusive: number): string {
  return formatAvailabilitySlotLabel(slotIndexExclusive);
}

function localIsoForSlot(dateStr: string, slotIndex: number): string {
  const [year, month, day] = dateStr.split("-").map(Number);
  const d = new Date(year!, month! - 1, day!, 0, 0, 0, 0);
  d.setMinutes(slotIndex * 30);
  return d.toISOString();
}

function weekdayLabelList(days: number[]) {
  return WEEKDAY_OPTIONS.filter((option) => days.includes(option.value))
    .map((option) => option.label)
    .join(", ");
}

type TourGuestNotifyPreviewAction = "confirm" | "delete" | "cancel" | "delete-confirmed";

type TourGuestNotifyPreview =
  | {
      action: "confirm";
      meeting: DemoMeeting;
      endIso: string;
      subject: string;
      body: string;
    }
  | {
      action: "delete";
      meeting: DemoMeeting;
      subject: string;
      body: string;
    }
  | {
      action: "cancel";
      meeting: DemoMeeting;
      subject: string;
      body: string;
    }
  | {
      action: "delete-confirmed";
      meeting: DemoMeeting;
      subject: string;
      body: string;
    };

type GuestMessagePreview = {
  email: string;
  phone?: string;
};

const TOUR_GUEST_NOTIFY_PREVIEW_COPY: Record<
  TourGuestNotifyPreviewAction,
  {
    title: string;
    intro: string;
    skipMessageLabel: string;
    confirmLabel: string;
    confirmLabelWithoutMessage: string;
    confirmBusyLabel: string;
  }
> = {
  confirm: {
    title: "Confirm tour",
    intro: "Confirming schedules the tour and sends this message to the guest.",
    skipMessageLabel: "Don't message guest",
    confirmLabel: "Confirm tour & send notification",
    confirmLabelWithoutMessage: "Confirm tour only",
    confirmBusyLabel: "Confirming…",
  },
  delete: {
    title: "Delete tour",
    intro: "Deleting removes this tour request from your calendar and sends this message to the guest.",
    skipMessageLabel: "Don't message guest",
    confirmLabel: "Delete tour & send notification",
    confirmLabelWithoutMessage: "Delete tour only",
    confirmBusyLabel: "Deleting…",
  },
  cancel: {
    title: "Cancel tour",
    intro: "Cancelling removes this tour and sends this message to the guest.",
    skipMessageLabel: "Don't message guest",
    confirmLabel: "Cancel tour & send notification",
    confirmLabelWithoutMessage: "Cancel tour only",
    confirmBusyLabel: "Cancelling…",
  },
  "delete-confirmed": {
    title: "Delete tour",
    intro: "Deleting removes this tour from your calendar and sends this message to the guest.",
    skipMessageLabel: "Don't message guest",
    confirmLabel: "Delete tour & send notification",
    confirmLabelWithoutMessage: "Delete tour only",
    confirmBusyLabel: "Deleting…",
  },
};

function buildTourGuestNotifyContext(
  meeting: DemoMeeting,
  scheduleOwnerLabel: string | null | undefined,
  tourEndIso: string,
) {
  const property = meeting.propertyId ? getPropertyById(meeting.propertyId) : undefined;
  return buildTourNotificationContext({
    origin: typeof window !== "undefined" ? window.location.origin : "",
    guestName: meeting.name || "Guest",
    guestEmail: meeting.email ?? "",
    guestPhone: meeting.phone || null,
    propertyId: meeting.propertyId || null,
    propertyTitle: meeting.propertyTitle || property?.title || "Property",
    propertyAddress: property?.address || null,
    roomLabel: meeting.roomLabel || null,
    tourStartIso: meeting.startIso,
    tourEndIso,
    notes: meeting.notes || null,
    managerLabel: scheduleOwnerLabel || null,
  });
}

export function PortalCalendarPanels({
  storageKey,
  /** When set, availability edits apply to every key (union display). */
  availabilityStorageKeys,
  calendarRefreshSignal,
  defaultViewMode = "week",
  pinMonthSchedule = false,
  tourScopeLabel,
  unavailableMessage = "Sign in to manage your availability.",
  compactAvailability = false,
  otherProperties,
  onCopyWeekToHouses,
  scheduledTourFilter,
  coManagerAvailabilityOverlays,
  scheduleOwnerLabel,
  availabilityHeading = "Availability",
  externalMeetings,
  onGoogleCalendarRefresh,
  onMeetingsChanged,
  readOnly = false,
  eventSummaryLabel,
  vendorDayFlexibility,
  vendorCalendarActions,
  preferEventCountsInDayHeader = false,
  anchorDate: anchorDateProp,
  onAnchorDateChange,
  /** Flat portal canvas — no outer card or input-style chrome (property calendar tab). */
  bareSurface = false,
  /**
   * Scroll with the parent page instead of a nested grid viewport (property detail
   * tab). Keeps the week toolbar sticky inside that one scroll surface.
   */
  flowScroll = false,
}: {
  storageKey: string | null;
  availabilityStorageKeys?: string[];
  calendarRefreshSignal?: number;
  defaultViewMode?: CalendarMode;
  pinMonthSchedule?: boolean;
  tourScopeLabel?: string;
  unavailableMessage?: string;
  compactAvailability?: boolean;
  bareSurface?: boolean;
  flowScroll?: boolean;
  otherProperties?: { id: string; name: string }[];
  onCopyWeekToHouses?: (propertyIds: string[], weekDateStrs: string[], scope: "week" | "entire") => void;
  scheduledTourFilter?: ScheduledTourFilter;
  coManagerAvailabilityOverlays?: CoManagerAvailabilityOverlay[];
  scheduleOwnerLabel?: string | null;
  availabilityHeading?: string;
  /** Pre-built calendar events from a caller-owned data source (e.g. vendor visits) merged
   * alongside the planned-events/partner-inquiries meetings this component reads itself. */
  externalMeetings?: DemoMeeting[];
  onGoogleCalendarRefresh?: () => void;
  /**
   * Fired whenever this panel changes a meeting (confirm, reschedule, cancel,
   * delete). The panel's own `meetingRefresh` is invisible to the page around
   * it, so without this the header's view-tab counts kept the pre-change number
   * — deleting a confirmed tour redrew the grid while the tabs still read
   * "All 1 / Tours 1" until a manual reload.
   */
  onMeetingsChanged?: () => void;
  /** Hides availability-editing affordances (create/copy/clear block, slot painting) so this
   * component can display a schedule for a caller that manages availability elsewhere. */
  readOnly?: boolean;
  eventSummaryLabel?: "meeting" | "tour" | "visit" | "event";
  /** Vendor calendar: per-weekday flexible toggles + link to timing preferences. */
  vendorDayFlexibility?: {
    flexibleWeekdays: Set<number>;
    onToggleFlexibleDay: (weekday: number) => void;
    onOpenFlexibleSettings: () => void;
  };
  /** Vendor calendar: click empty slots to add personal work blocks; edit vendor-owned meetings. */
  preferEventCountsInDayHeader?: boolean;
  anchorDate?: Date;
  onAnchorDateChange?: (date: Date) => void;
  vendorCalendarActions?: {
    onAddFromSlot: (dateStr: string, slotIdx: number) => void;
    canEditMeeting: (meeting: DemoMeeting) => boolean;
    onEditMeeting: (meeting: DemoMeeting) => void;
    onAddWork?: () => void;
  };
}) {
  const { showToast } = useAppUi();
  const writeStorageKeys = useMemo(() => {
    if (availabilityStorageKeys?.length) return availabilityStorageKeys;
    return storageKey ? [storageKey] : [];
  }, [availabilityStorageKeys, storageKey]);
  const [viewMode, setViewMode] = useState<CalendarMode>(defaultViewMode);
  const [monthPick, setMonthPick] = useState<{ start: string | null; end: string | null }>({ start: null, end: null });
  const [uncontrolledAnchorDate, setUncontrolledAnchorDate] = useState(() => new Date());
  const anchorDate = anchorDateProp ?? uncontrolledAnchorDate;
  const setAnchorDate = useCallback(
    (updater: Date | ((prev: Date) => Date)) => {
      const prev = anchorDateProp ?? uncontrolledAnchorDate;
      const next = typeof updater === "function" ? updater(prev) : updater;
      if (onAnchorDateChange) onAnchorDateChange(next);
      else setUncontrolledAnchorDate(next);
    },
    [anchorDateProp, onAnchorDateChange, uncontrolledAnchorDate],
  );
  const [activeSlots, setActiveSlots] = useState<Set<string>>(() =>
    writeStorageKeys.length > 0 ? unionAvailabilityForStorageKeys(writeStorageKeys) : new Set(),
  );
  /** Painted availability plus the 9-5 default on days with no published windows. */
  const offeredSlots = useMemo(
    () => new Set(resolveTourOfferingSlots([...activeSlots]).filter((slot) => slotIsBookable(slot))),
    [activeSlots],
  );
  /**
   * Windows a prospect can book that the manager never painted — the implicit
   * 9-5 default. These were invisible here while being live on the public
   * booking page, so a manager had no idea their calendar was open, let alone
   * which days. Shown as a distinct "default" state that can be removed.
   */
  /** Availability edits need exactly one write target; the portfolio-wide view has none. */
  const canEditAvailability = !readOnly && writeStorageKeys.length > 0;
  const defaultOnlySlots = useMemo(() => {
    const out = new Set<string>();
    for (const key of offeredSlots) {
      if (!activeSlots.has(key)) out.add(key);
    }
    return out;
  }, [activeSlots, offeredSlots]);

  const [dragSelection, setDragSelection] = useState<DragSelection | null>(null);
  // Mirrors dragSelection synchronously. mousedown and mouseup can land in the
  // same React batch on a fast click, so finishDragSelection would otherwise
  // read a stale `null` and the click would silently do nothing.
  const dragSelectionRef = useRef<DragSelection | null>(null);
  const [mobileDayIndex, setMobileDayIndex] = useState(0);
  const [visibleStartSlot, setVisibleStartSlot] = useState(DEFAULT_VISIBLE_START_SLOT);
  const [visibleEndSlotExclusive, setVisibleEndSlotExclusive] = useState(DEFAULT_VISIBLE_END_SLOT_EXCLUSIVE);
  const [blockModalOpen, setBlockModalOpen] = useState(false);
  const [blockStartSlot, setBlockStartSlot] = useState(DEFAULT_VISIBLE_START_SLOT);
  const [blockEndSlotExclusive, setBlockEndSlotExclusive] = useState(DEFAULT_VISIBLE_START_SLOT + 2);
  const [blockWeekdays, setBlockWeekdays] = useState<number[]>([0, 1, 2, 3, 4]);
  const [blockCadence, setBlockCadence] = useState<RecurrenceCadence>("weekly");
  const [blockOccurrences, setBlockOccurrences] = useState(4);
  const [updateToHousesOpen, setUpdateToHousesOpen] = useState(false);
  const [copyToHousesScope, setCopyToHousesScope] = useState<"week" | "entire">("week");
  const [selectedHouseIds, setSelectedHouseIds] = useState<Set<string>>(new Set());
  const [selectedBlock, setSelectedBlock] = useState<CalendarBlockSelection | null>(null);
  const [durationChoice, setDurationChoice] = useState<number | "custom">(DEFAULT_EVENT_DURATION_MINUTES);
  const [customDurationText, setCustomDurationText] = useState(String(DEFAULT_EVENT_DURATION_MINUTES));
  const [tourGuestNotifyPreview, setTourGuestNotifyPreview] = useState<TourGuestNotifyPreview | null>(null);
  const [tourNotifyPreviewBusy, setTourNotifyPreviewBusy] = useState(false);
  const [guestMessagePreview, setGuestMessagePreview] = useState<GuestMessagePreview | null>(null);
  const [guestMessageBusy, setGuestMessageBusy] = useState(false);
  /**
   * Destructive actions on non-confirmed meetings still use an inline confirm
   * step. Confirmed tours open the shared message compose popup instead.
   */
  const [pendingTourAction, setPendingTourAction] = useState<"delete" | "cancel" | null>(null);
  const [tourActionBusy, setTourActionBusy] = useState(false);
  const [meetingRefresh, setMeetingRefresh] = useState(0);
  const [saveStatus, setSaveStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");

  useEffect(() => {
    if (writeStorageKeys.length === 0) return;
    let cancelled = false;
    const load = async () => {
      try {
        await syncScheduleRecordsFromServer();
      } catch {
        /* offline or dev server restart — calendar still renders */
      }
      if (!cancelled) {
        setActiveSlots(unionAvailabilityForStorageKeys(writeStorageKeys));
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [writeStorageKeys]);

  // Poll every 60 s so approvals/cancellations from linked accounts propagate
  // automatically. Skip while the tab is hidden to avoid egress from background
  // tabs, and refresh once immediately when the tab becomes visible again.
  useEffect(() => {
    if (writeStorageKeys.length === 0) return;
    const refresh = () =>
      syncScheduleRecordsFromServer()
        .then(() => setMeetingRefresh((n) => n + 1))
        .catch(() => undefined);
    const id = setInterval(() => {
      if (document.hidden) return;
      void refresh();
    }, 60_000);
    const onVisible = () => {
      if (!document.hidden) void refresh();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(id);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [writeStorageKeys]);

  const weekMonday = useMemo(() => startOfWeekMonday(anchorDate), [anchorDate]);
  const fullWeekDates = useMemo(() => [0, 1, 2, 3, 4, 5, 6].map((i) => addDays(weekMonday, i)), [weekMonday]);
  const fullWeekDateStrs = useMemo(() => fullWeekDates.map(toLocalDateStr), [fullWeekDates]);
  const activeBlockDates = fullWeekDates;
  const activeBlockDateStrs = fullWeekDateStrs;

  const meetings = useMemo<DemoMeeting[]>(() => {
    void calendarRefreshSignal;
    void meetingRefresh;
    const tourMeetings = buildScheduledTourMeetings(scheduledTourFilter, storageKey);
    const linkedGoogleIds = new Set(
      readPlannedEvents()
        .map((event) => event.googleCalendarEventId?.trim())
        .filter((id): id is string => Boolean(id)),
    );
    const plannedTourStarts = new Set(
      tourMeetings.filter((meeting) => meeting.source === "planned" && meeting.kind === "tour").map((meeting) => meeting.startIso),
    );
    const filteredExternal = (externalMeetings ?? []).filter((meeting) => {
      if (!isPropPlaneGoogleTourMeeting(meeting)) return true;
      if (linkedGoogleIds.has(meeting.sourceId)) return false;
      if (plannedTourStarts.has(meeting.startIso)) return false;
      return true;
    });
    return [...tourMeetings, ...filteredExternal];
  }, [storageKey, calendarRefreshSignal, meetingRefresh, scheduledTourFilter, externalMeetings]);

  /**
   * Personal Google busy time is drawn as "Blocked", never as an event, and the
   * view tabs above this grid count only tours + service visits. Counting busy
   * blocks in the day header made it read "9 EVENTS" on Wednesday directly
   * under a tab reading "All 0" (F-CAL-1). The header counts the same set the
   * tabs do; the blocks stay visible in the grid, labelled Blocked.
   */
  const scheduledMeetings = useMemo(() => scheduledCalendarMeetings(meetings), [meetings]);
  const showEventCountsInDayHeader = readOnly || preferEventCountsInDayHeader;

  const monthYear = anchorDate.getFullYear();
  const monthIndex = anchorDate.getMonth();
  const monthCells = useMemo(() => buildMonthCells(monthYear, monthIndex), [monthYear, monthIndex]);
  const today = useMemo(() => new Date(), []);

  const monthBlocksCount = useMemo(() => {
    let n = 0;
    const dim = new Date(monthYear, monthIndex + 1, 0).getDate();
    for (let day = 1; day <= dim; day += 1) {
      const ds = toLocalDateStr(new Date(monthYear, monthIndex, day, 12, 0, 0, 0));
      for (const slot of slotRowIndices) {
        if (activeSlots.has(dateSlotKey(ds, slot))) n += 1;
      }
    }
    return n;
  }, [monthYear, monthIndex, activeSlots]);

  const visibleSlotIndices = useMemo(
    () => slotRowIndices.filter((slot) => slot >= visibleStartSlot && slot < visibleEndSlotExclusive),
    [visibleEndSlotExclusive, visibleStartSlot],
  );

  const reloadAvailability = useCallback(() => {
    if (writeStorageKeys.length === 0) return;
    setActiveSlots(unionAvailabilityForStorageKeys(writeStorageKeys));
    void syncScheduleRecordsFromServer({ force: true }).finally(() => {
      setActiveSlots(unionAvailabilityForStorageKeys(writeStorageKeys));
    });
  }, [writeStorageKeys]);

  const mutateAvailability = useCallback(
    (mutate: (current: Set<string>) => Set<string>) => {
      if (writeStorageKeys.length === 0) return;
      setSaveStatus("saving");
      void Promise.all(
        writeStorageKeys.map((key) => {
          const current = new Set(readAvailabilityDateSetForStorageKey(key));
          const next = mutate(current);
          return writeAvailabilityDateSetForStorageKeyToServer(next, key, { adminLabel: scheduleOwnerLabel });
        }),
      )
        .then(async (results) => {
          if (results.some((ok) => !ok)) {
            setSaveStatus("error");
            reloadAvailability();
            return;
          }
          await syncScheduleRecordsFromServer({ force: true });
          setActiveSlots(unionAvailabilityForStorageKeys(writeStorageKeys));
          setSaveStatus("saved");
        })
        .catch(() => {
          setSaveStatus("error");
          reloadAvailability();
        });
    },
    [reloadAvailability, scheduleOwnerLabel, writeStorageKeys],
  );

  const openSlotDetails = useCallback(
    (dateStr: string, slotIdx: number, _target: HTMLElement, meeting?: DemoMeeting) => {
      // Never carry a staged destructive action into the next event's modal —
      // reopening must always start from the plain, non-armed state.
      setPendingTourAction(null);
      setGuestMessagePreview(null);
      if (meeting) {
        if (vendorCalendarActions?.canEditMeeting(meeting)) {
          vendorCalendarActions.onEditMeeting(meeting);
          return;
        }
        const minutes = clampEventDurationMinutes(meeting.durationMinutes);
        setDurationChoice((EVENT_DURATION_PRESET_MINUTES as readonly number[]).includes(minutes) ? minutes : "custom");
        setCustomDurationText(String(minutes));
        setSelectedBlock({ kind: "meeting", meeting });
        return;
      }
      if (activeSlots.has(dateSlotKey(dateStr, slotIdx))) {
        setSelectedBlock({ kind: "availability", dateStr, slotIndex: slotIdx });
        return;
      }
      if (vendorCalendarActions) {
        vendorCalendarActions.onAddFromSlot(dateStr, slotIdx);
      }
    },
    [activeSlots, vendorCalendarActions],
  );

  /**
   * Removes one default window. The rest of that day's default is written back
   * explicitly, because painting anything on a day takes it off the default —
   * without this, dropping one window would close the whole day.
   */
  const removeDefaultSlot = useCallback(
    (dateStr: string, slotIdx: number) => {
      const removedKey = dateSlotKey(dateStr, slotIdx);
      mutateAvailability((current) => {
        const next = new Set(current);
        for (const key of defaultTourSlotKeysForDate(dateStr)) {
          if (key !== removedKey && slotIsBookable(key)) next.add(key);
        }
        next.delete(removedKey);
        return next;
      });
    },
    [mutateAvailability],
  );

  const deleteAvailabilitySlot = useCallback(() => {
    if (selectedBlock?.kind !== "availability") return;
    const slotKey = dateSlotKey(selectedBlock.dateStr, selectedBlock.slotIndex);
    mutateAvailability((current) => {
      const next = new Set(current);
      next.delete(slotKey);
      return next;
    });
    setSelectedBlock(null);
  }, [mutateAvailability, selectedBlock]);

  const selectedDurationMinutes = useMemo(
    () =>
      durationChoice === "custom"
        ? clampEventDurationMinutes(Number.parseInt(customDurationText, 10))
        : durationChoice,
    [customDurationText, durationChoice],
  );

  const approveSelectedInquiry = useCallback(async () => {
    if (selectedBlock?.kind !== "meeting" || selectedBlock.meeting.source !== "inquiry") return;
    const result = await acceptPartnerInquiryFromServer(selectedBlock.meeting.sourceId, {
      start: selectedBlock.meeting.startIso,
      end: endIsoForDuration(selectedBlock.meeting.startIso, selectedDurationMinutes),
    });
    if (!result.ok) {
      showToast(result.error ?? "Could not approve request.");
      return;
    }
    setSelectedBlock(null);
    setMeetingRefresh((n) => n + 1);
    onMeetingsChanged?.();
    reloadAvailability();
    showToast("Request approved.");
  }, [onMeetingsChanged, reloadAvailability, selectedBlock, selectedDurationMinutes, showToast]);

  const openTourConfirmPreview = useCallback(() => {
    if (selectedBlock?.kind !== "meeting" || selectedBlock.meeting.source !== "inquiry") return;
    const meeting = selectedBlock.meeting;
    if (meeting.kind !== "tour" || !meeting.email?.trim()) {
      showToast("Guest email is required before confirming this tour.");
      return;
    }
    const endIso = endIsoForDuration(meeting.startIso, selectedDurationMinutes);
    const ctx = buildTourGuestNotifyContext(meeting, scheduleOwnerLabel, endIso);
    setTourGuestNotifyPreview({
      action: "confirm",
      meeting,
      endIso,
      subject: TOUR_CONFIRMED_TENANT_SUBJECT,
      body: buildTourConfirmedTenantBody(ctx),
    });
  }, [scheduleOwnerLabel, selectedBlock, selectedDurationMinutes, showToast]);

  const openTourDeletePreview = useCallback(() => {
    if (selectedBlock?.kind !== "meeting" || selectedBlock.meeting.source !== "inquiry") return;
    const meeting = selectedBlock.meeting;
    if (meeting.kind !== "tour") {
      setPendingTourAction("delete");
      return;
    }
    if (!meeting.email?.trim()) {
      showToast("Guest email is required before deleting this tour.");
      setPendingTourAction("delete");
      return;
    }
    const ctx = buildTourGuestNotifyContext(meeting, scheduleOwnerLabel, meeting.endIso);
    setTourGuestNotifyPreview({
      action: "delete",
      meeting,
      subject: TOUR_REQUEST_REMOVED_TENANT_SUBJECT,
      body: buildTourRequestRemovedTenantBody(ctx),
    });
    setPendingTourAction(null);
  }, [scheduleOwnerLabel, selectedBlock, showToast]);

  const openConfirmedTourCancelPreview = useCallback(() => {
    if (selectedBlock?.kind !== "meeting" || selectedBlock.meeting.source !== "planned") return;
    const meeting = selectedBlock.meeting;
    if (!meeting.email?.trim()) {
      showToast("Guest email is required before cancelling this tour.");
      return;
    }
    const ctx = buildTourGuestNotifyContext(meeting, scheduleOwnerLabel, meeting.endIso);
    setTourGuestNotifyPreview({
      action: "cancel",
      meeting,
      subject: TOUR_CANCELED_TENANT_SUBJECT,
      body: buildTourCanceledTenantBody(ctx),
    });
    setPendingTourAction(null);
  }, [scheduleOwnerLabel, selectedBlock, showToast]);

  const openConfirmedTourDeletePreview = useCallback(() => {
    if (selectedBlock?.kind !== "meeting" || selectedBlock.meeting.source !== "planned") return;
    const meeting = selectedBlock.meeting;
    if (!meeting.email?.trim()) {
      setPendingTourAction("delete");
      return;
    }
    const ctx = buildTourGuestNotifyContext(meeting, scheduleOwnerLabel, meeting.endIso);
    setTourGuestNotifyPreview({
      action: "delete-confirmed",
      meeting,
      subject: TOUR_CANCELED_TENANT_SUBJECT,
      body: buildTourCanceledTenantBody(ctx),
    });
    setPendingTourAction(null);
  }, [scheduleOwnerLabel, selectedBlock]);

  const openGuestMessageCompose = useCallback(
    (email?: string | null, phone?: string | null) => {
      const trimmed = email?.trim() ?? "";
      if (!trimmed.includes("@")) {
        showToast("No guest email on this event.");
        return;
      }
      setGuestMessagePreview({
        email: trimmed,
        phone: phone?.trim() || undefined,
      });
    },
    [showToast],
  );

  const submitGuestMessage = useCallback(
    async (_skip: boolean, channels?: { viaEmail?: boolean; viaSms?: boolean }, draft?: NotificationConfirmDraft) => {
      if (!guestMessagePreview || guestMessageBusy) return;
      const subject = draft?.subject?.trim() ?? "";
      const body = draft?.body?.trim() ?? "";
      if (!subject || !body) {
        showToast("Subject and message are required.");
        return;
      }
      setGuestMessageBusy(true);
      try {
        const result = await deliverPortalInboxMessage({
          eventCategory: "messages",
          fromName: scheduleOwnerLabel?.trim() || "Property Manager",
          toEmails: [guestMessagePreview.email],
          subject,
          text: body,
          deliverViaEmail: channels?.viaEmail !== false,
          deliverViaSms: channels?.viaSms === true,
        });
        if (!result.ok) {
          showToast(result.error ?? "Message could not be sent.");
          return;
        }
        setGuestMessagePreview(null);
        showToast(
          result.skipped
            ? "Message saved to PropLane inbox."
            : channels?.viaSms && channels?.viaEmail
              ? "Message sent via email, SMS, and PropLane inbox."
              : channels?.viaSms
                ? "Message sent via SMS and PropLane inbox."
                : "Message sent via inbox and email.",
        );
      } finally {
        setGuestMessageBusy(false);
      }
    },
    [guestMessageBusy, guestMessagePreview, scheduleOwnerLabel, showToast],
  );

  const submitTourGuestNotifyPreview = useCallback(
    async (skipMessage: boolean, _channels?: unknown, draft?: NotificationConfirmDraft) => {
      if (!tourGuestNotifyPreview || tourNotifyPreviewBusy) return;
      const preview = tourGuestNotifyPreview;
      setTourNotifyPreviewBusy(true);
      try {
        if (preview.action === "confirm") {
          const { meeting, endIso } = preview;
          const result = await acceptPartnerInquiryFromServer(meeting.sourceId, {
            start: meeting.startIso,
            end: endIso,
            notifyTenant: !skipMessage,
            subject: draft?.subject,
            body: draft?.body,
          });
          if (!result.ok) {
            showToast(result.error ?? "Could not confirm tour.");
            return;
          }
          setTourGuestNotifyPreview(null);
          setSelectedBlock(null);
          setMeetingRefresh((n) => n + 1);
          onMeetingsChanged?.();
          reloadAvailability();
          if (skipMessage) {
            showToast("Tour confirmed (no guest notification sent).");
          } else if (result.notificationSkipped) {
            showToast(
              "Tour confirmed. Confirmation sent to PropLane inbox (email skipped for demo address or missing provider).",
            );
          } else if (result.error) {
            showToast("Tour confirmed, but the confirmation email could not be sent.");
          } else {
            showToast("Tour confirmed and confirmation sent via inbox and email.");
          }
          return;
        }

        if (preview.action === "delete") {
          const { meeting } = preview;
          const ok = await deletePartnerInquiryFromServer(meeting.sourceId, {
            notifyTenant: !skipMessage,
            subject: draft?.subject,
            body: draft?.body,
          });
          if (!ok) {
            showToast("Could not delete this tour.");
            return;
          }
          setTourGuestNotifyPreview(null);
          setSelectedBlock(null);
          setPendingTourAction(null);
          setMeetingRefresh((n) => n + 1);
          onMeetingsChanged?.();
          reloadAvailability();
          showToast(
            skipMessage ? "Tour removed (no guest notification sent)." : "Tour removed and guest notified.",
          );
          return;
        }

        if (preview.action === "cancel" || preview.action === "delete-confirmed") {
          const { meeting } = preview;
          const result = await cancelPlannedTourFromServer({
            plannedEventId: meeting.sourceId,
            notifyGuest: !skipMessage,
            subject: draft?.subject,
            body: draft?.body,
          });
          if (!result.ok) {
            showToast(result.error ?? "Could not cancel this tour.");
            return;
          }
          setTourGuestNotifyPreview(null);
          setSelectedBlock(null);
          setPendingTourAction(null);
          await syncScheduleRecordsFromServer({ force: true });
          setMeetingRefresh((n) => n + 1);
          onMeetingsChanged?.();
          reloadAvailability();
          const actionLabel = preview.action === "cancel" ? "cancelled" : "deleted";
          showToast(
            tourGuestNotificationFailed(result.guestNotification)
              ? `Tour ${actionLabel}, but the guest could not be notified.`
              : result.calendarSync?.ok === false
                ? `Tour ${actionLabel} and the guest was notified, but your Google Calendar did not update.`
                : skipMessage
                  ? `Tour ${actionLabel} (no guest notification sent).`
                  : `Tour ${actionLabel} and the guest was notified.`,
          );
        }
      } finally {
        setTourNotifyPreviewBusy(false);
      }
    },
    [onMeetingsChanged, reloadAvailability, showToast, tourGuestNotifyPreview, tourNotifyPreviewBusy],
  );

  const deleteSelectedMeeting = useCallback(async () => {
    if (selectedBlock?.kind !== "meeting") return;
    const meeting = selectedBlock.meeting;
    let ok = false;
    if (isPropPlaneGoogleTourMeeting(meeting)) {
      const result = await deleteProplaneGoogleTourFromServer(meeting.sourceId);
      if (!result.ok) {
        showToast(result.error ?? "Could not delete calendar event.");
        return;
      }
      ok = true;
    } else if (meeting.source === "planned") {
      const planned = readPlannedEvents().find((event) => event.id === meeting.sourceId);
      if (planned?.googleCalendarEventId?.trim()) {
        await deleteProplaneGoogleTourFromServer(planned.googleCalendarEventId);
        onGoogleCalendarRefresh?.();
      }
      ok = await deletePlannedEventFromServer(meeting.sourceId);
    } else {
      ok = await deletePartnerInquiryFromServer(meeting.sourceId, { notifyTenant: false });
    }
    if (ok) {
      setSelectedBlock(null);
      setPendingTourAction(null);
      setMeetingRefresh((n) => n + 1);
      onMeetingsChanged?.();
      reloadAvailability();
      if (isPropPlaneGoogleTourMeeting(meeting)) onGoogleCalendarRefresh?.();
      showToast(meeting.source === "inquiry" ? "Tour request removed and guest notified." : "Event deleted.");
    } else {
      showToast("Could not delete this event.");
    }
  }, [onGoogleCalendarRefresh, onMeetingsChanged, reloadAvailability, selectedBlock, showToast]);

  const prevRefreshSig = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (calendarRefreshSignal === undefined) return;
    if (prevRefreshSig.current === undefined) {
      prevRefreshSig.current = calendarRefreshSignal;
      return;
    }
    if (prevRefreshSig.current === calendarRefreshSignal) return;
    prevRefreshSig.current = calendarRefreshSignal;
    reloadAvailability();
  }, [calendarRefreshSignal, reloadAvailability]);

  const meetingBySlotKey = useMemo(() => {
    const map = new Map<string, DemoMeeting>();
    for (const meeting of meetings) {
      for (const key of meetingOccupiedSlotKeys(meeting)) {
        const current = map.get(key);
        if (current && calendarCellPriority(current) < calendarCellPriority(meeting)) continue;
        map.set(key, meeting);
      }
    }
    return map;
  }, [meetings]);

  /**
   * The half hours that are genuinely TAKEN — the grid still draws every
   * meeting, but a Google event the manager marked Free or declined is not
   * capacity they have lost, and the public booking page goes on offering it.
   */
  const takenSlotKeys = useMemo(() => {
    const keys = new Set<string>();
    for (const meeting of meetings) {
      if (!meetingConsumesTourSlot(meeting)) continue;
      for (const key of meetingOccupiedSlotKeys(meeting)) {
        keys.add(key);
      }
    }
    return keys;
  }, [meetings]);

  /**
   * "N open" for a day header — painted availability MINUS the slots a booked
   * meeting already occupies.
   *
   * The count used to read `activeSlots` alone, so a half hour consumed by a
   * confirmed tour still advertised itself as open: a Thursday whose only 10 am
   * window had just been booked kept reporting "1 open". A manager reads that
   * header as remaining capacity, so it has to agree with what the grid draws
   * and with what the public booking page will actually offer.
   */
  const openSlotCountForDate = useCallback(
    (dateStr: string) =>
      visibleSlotIndices.reduce((total, slot) => {
        const key = dateSlotKey(dateStr, slot);
        if (!offeredSlots.has(key)) return total;
        return takenSlotKeys.has(key) ? total : total + 1;
      }, 0),
    [offeredSlots, takenSlotKeys, visibleSlotIndices],
  );

  /** Week total for the "N open slots" badge — same booked-slot subtraction. */
  const weekSlotCount = useMemo(() => {
    let n = 0;
    for (const ds of activeBlockDateStrs) {
      for (const slot of slotRowIndices) {
        const key = dateSlotKey(ds, slot);
        if (offeredSlots.has(key) && !takenSlotKeys.has(key)) n += 1;
      }
    }
    return n;
  }, [activeBlockDateStrs, offeredSlots, takenSlotKeys]);

  const coManagerOverlayBySlotKey = useMemo(() => {
    const map = new Map<string, CoManagerAvailabilityOverlay>();
    for (const overlay of coManagerAvailabilityOverlays ?? []) {
      for (const slotKey of overlay.slots) {
        if (!map.has(slotKey)) map.set(slotKey, overlay);
      }
    }
    return map;
  }, [coManagerAvailabilityOverlays]);

  const upcomingMeetingSummary = useMemo(() => {
    const now = today.getTime() - 30 * 60 * 1000;
    const sorted = meetings
      .filter((meeting) => !isGoogleCalendarPrivateBlock(meeting))
      .map((meeting) => ({ meeting, startMs: new Date(meeting.startIso).getTime() }))
      .filter((item) => Number.isFinite(item.startMs) && item.startMs >= now)
      .sort((a, b) => a.startMs - b.startMs);
    const pending = sorted.filter((item) => item.meeting.source === "inquiry").length;
    const confirmed = sorted.filter((item) => item.meeting.source === "planned" || item.meeting.source === "external").length;
    return {
      total: sorted.length,
      pending,
      confirmed,
      next: sorted.slice(0, 3).map((item) => item.meeting),
    };
  }, [meetings, today]);

  const isPropertyTourCalendar = Boolean(scheduledTourFilter?.viewerUserId);
  const eventSummaryKind =
    eventSummaryLabel ??
    (isPropertyTourCalendar || meetings.some((meeting) => meeting.kind === "tour") ? "tour" : "meeting");

  const startTimeOptions = useMemo(
    () =>
      slotRowIndices.map((slot) => ({
        value: String(slot),
        label: formatAvailabilitySlotLabel(slot),
      })),
    [slotRowIndices],
  );
  const endTimeOptions = useMemo(
    () =>
      slotRowIndices
        .map((slot) => slot + 1)
        .filter((slot) => slot > visibleStartSlot && slot <= SLOTS_PER_DAY)
        .map((slot) => ({
          value: String(slot),
          label: formatSlotEndLabel(slot),
        })),
    [slotRowIndices, visibleStartSlot],
  );

  const renderTimeWindowControl = (compact = false) => {
    const onStartChange = (nextRaw: string) => {
      const nextStart = Number.parseInt(nextRaw, 10);
      if (!Number.isFinite(nextStart)) return;
      setVisibleStartSlot(nextStart);
      setVisibleEndSlotExclusive((current) =>
        current <= nextStart ? Math.min(nextStart + 1, SLOTS_PER_DAY) : current,
      );
    };
    const onEndChange = (nextRaw: string) => {
      const nextEnd = Number.parseInt(nextRaw, 10);
      if (!Number.isFinite(nextEnd)) return;
      setVisibleEndSlotExclusive(nextEnd);
      setVisibleStartSlot((current) => (current >= nextEnd ? Math.max(0, nextEnd - 1) : current));
    };

    if (compact) {
      return (
        <div className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap sm:gap-1.5">
          <FieldSingleSelect
            hideLabel
            label="Start time"
            variant="pill"
            wrapperClassName="min-w-[3.25rem] shrink-0"
            triggerClassName={COMPACT_TIME_SELECT_TRIGGER_FLAT}
            value={String(visibleStartSlot)}
            onChange={onStartChange}
            options={startTimeOptions}
          />
          <span className="text-[11px] font-medium text-muted sm:text-xs">–</span>
          <FieldSingleSelect
            hideLabel
            label="End time"
            variant="pill"
            wrapperClassName="min-w-[3.25rem] shrink-0"
            triggerClassName={COMPACT_TIME_SELECT_TRIGGER_FLAT}
            value={String(visibleEndSlotExclusive)}
            onChange={onEndChange}
            options={endTimeOptions}
          />
        </div>
      );
    }

    return (
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs font-semibold uppercase tracking-[0.14em] text-muted">Show</span>
        <Select value={String(visibleStartSlot)} onChange={(e) => onStartChange(e.target.value)}>
          {slotRowIndices.map((slot) => (
            <option key={`start-${slot}`} value={slot}>
              {formatAvailabilitySlotLabel(slot)}
            </option>
          ))}
        </Select>
        <span className="text-sm font-medium text-muted">to</span>
        <Select value={String(visibleEndSlotExclusive)} onChange={(e) => onEndChange(e.target.value)}>
          {slotRowIndices
            .map((slot) => slot + 1)
            .filter((slot) => slot > visibleStartSlot && slot <= SLOTS_PER_DAY)
            .map((slot) => (
              <option key={`end-${slot}`} value={slot}>
                {formatSlotEndLabel(slot)}
              </option>
            ))}
        </Select>
      </div>
    );
  };

  const shiftAnchor = (dir: -1 | 1) => {
    if (viewMode === "month") setAnchorDate((d) => addMonths(d, dir));
    else if (viewMode === "week") setAnchorDate((d) => addDays(d, dir * 7));
    else setAnchorDate((d) => addDays(d, dir));
  };

  const jumpToToday = useCallback(() => {
    setAnchorDate(new Date(today));
    setMonthPick({ start: null, end: null });
  }, [today]);

  const shiftAvailabilityWeek = useCallback((dir: -1 | 1) => {
    setAnchorDate((d) => addDays(d, dir * 7));
  }, []);

  useEffect(() => {
    if (!compactAvailability) return;
    setMobileDayIndex(mondayBasedDayIndex(anchorDate));
  }, [compactAvailability, weekMonday, anchorDate]);

  const copyPreviousWeek = useCallback(() => {
    const currentDates = activeBlockDates;
    const previousBlockDates = currentDates.map((date) => addDays(date, -7));

    mutateAvailability((activeSlotsForKey) => {
      const next = new Set(activeSlotsForKey);

      for (const targetDate of currentDates) {
        const targetDateStr = toLocalDateStr(targetDate);
        for (const slot of slotRowIndices) {
          next.delete(dateSlotKey(targetDateStr, slot));
        }
      }

      previousBlockDates.forEach((sourceDate, idx) => {
        const sourceDateStr = toLocalDateStr(sourceDate);
        const targetDateStr = toLocalDateStr(currentDates[idx]!);
        for (const slot of slotRowIndices) {
          if (activeSlotsForKey.has(dateSlotKey(sourceDateStr, slot))) {
            next.add(dateSlotKey(targetDateStr, slot));
          }
        }
      });

      return next;
    });
  }, [activeBlockDates, mutateAvailability]);

  const toggleBlockWeekday = useCallback((weekday: number) => {
    setBlockWeekdays((current) =>
      current.includes(weekday) ? current.filter((value) => value !== weekday) : [...current, weekday].sort((a, b) => a - b),
    );
  }, []);

  const prefillBlockModal = useCallback(
    (selection?: DragSelection | null) => {
      const baseDate = selection ? new Date(`${selection.dateStr}T12:00:00`) : anchorDate;
      const weekday = selection ? selection.weekday : mondayBasedDayIndex(baseDate);
      setBlockWeekdays(viewMode === "day" && !selection ? [weekday] : selection ? [weekday] : [0, 1, 2, 3, 4]);
      setBlockStartSlot(selection?.startSlot ?? visibleStartSlot);
      setBlockEndSlotExclusive(
        selection?.endSlotExclusive ?? Math.min(SLOTS_PER_DAY, visibleStartSlot + 2),
      );
      setBlockCadence(selection ? "once" : "weekly");
      setBlockOccurrences(selection ? 1 : 4);
      setBlockModalOpen(true);
    },
    [anchorDate, viewMode, visibleStartSlot],
  );

  const openBlockModal = useCallback(() => {
    prefillBlockModal(null);
  }, [prefillBlockModal]);

  const startDragSelection = useCallback((dateStr: string, weekday: number, slotIdx: number) => {
    const next: DragSelection = {
      dateStr,
      weekday,
      startSlot: slotIdx,
      endSlotExclusive: slotIdx + 1,
    };
    dragSelectionRef.current = next;
    setDragSelection(next);
  }, []);

  const extendDragSelection = useCallback((dateStr: string, slotIdx: number) => {
    setDragSelection((current) => {
      if (!current || current.dateStr !== dateStr) return current;
      const start = Math.min(current.startSlot, slotIdx);
      const end = Math.max(current.startSlot, slotIdx) + 1;
      const next = { ...current, startSlot: start, endSlotExclusive: end };
      dragSelectionRef.current = next;
      return next;
    });
  }, []);

  const finishDragSelection = useCallback(() => {
    const pending = dragSelectionRef.current;
    if (!pending) return;
    dragSelectionRef.current = null;
    prefillBlockModal(pending);
    setDragSelection(null);
  }, [prefillBlockModal]);

  const cancelDragSelection = useCallback(() => {
    dragSelectionRef.current = null;
    setDragSelection(null);
  }, []);

  /** Open the recurring-block modal prefilled with a single slot (keyboard path). */
  const openBlockModalForSlot = useCallback(
    (dateStr: string, weekday: number, slotIdx: number) => {
      dragSelectionRef.current = null;
      setDragSelection(null);
      prefillBlockModal({ dateStr, weekday, startSlot: slotIdx, endSlotExclusive: slotIdx + 1 });
    },
    [prefillBlockModal],
  );

  const isSlotInDragSelection = useCallback(
    (dateStr: string, slotIdx: number) =>
      Boolean(
        dragSelection &&
          dragSelection.dateStr === dateStr &&
          slotIdx >= dragSelection.startSlot &&
          slotIdx < dragSelection.endSlotExclusive,
      ),
    [dragSelection],
  );

  const applyRecurringBlock = useCallback(() => {
    if (blockWeekdays.length === 0 || blockEndSlotExclusive <= blockStartSlot) return;

    mutateAvailability((current) => {
      const next = new Set(current);
      const occurrences = blockCadence === "once" ? 1 : Math.max(1, blockOccurrences);
      const baseDates = resolveBlockBaseDates(activeBlockDates, weekMonday, blockWeekdays);

      for (let occurrenceIndex = 0; occurrenceIndex < occurrences; occurrenceIndex += 1) {
        const targetDates = baseDates.map((date) => {
          if (blockCadence === "once" || blockCadence === "weekly") return addDays(date, occurrenceIndex * 7);
          if (blockCadence === "biweekly") return addDays(date, occurrenceIndex * 14);
          return addMonths(date, occurrenceIndex);
        });

        for (const targetDate of targetDates) {
          const targetDateStr = toLocalDateStr(targetDate);
          for (let slot = blockStartSlot; slot < blockEndSlotExclusive; slot += 1) {
            next.add(dateSlotKey(targetDateStr, slot));
          }
        }
      }

      return next;
    });
    setBlockModalOpen(false);
  }, [activeBlockDates, blockCadence, blockEndSlotExclusive, blockOccurrences, blockStartSlot, blockWeekdays, mutateAvailability, weekMonday]);

  const clearCurrentWeek = useCallback(() => {
    mutateAvailability((current) => {
      const next = new Set(current);
      for (const ds of activeBlockDateStrs) {
        for (const slot of slotRowIndices) {
          next.delete(dateSlotKey(ds, slot));
        }
      }
      return next;
    });
  }, [activeBlockDateStrs, mutateAvailability]);

  const blockSummary = useMemo(() => {
    const days = blockWeekdays.length > 0 ? weekdayLabelList(blockWeekdays) : "No days selected";
    const repeats =
      blockCadence === "once"
        ? "this week only"
        : `${blockCadence} for ${blockOccurrences} occurrence${blockOccurrences === 1 ? "" : "s"}`;
    return `${days} · ${formatAvailabilitySlotLabel(blockStartSlot)}-${formatSlotEndLabel(blockEndSlotExclusive)} · ${repeats}`;
  }, [blockCadence, blockEndSlotExclusive, blockOccurrences, blockStartSlot, blockWeekdays]);

  const closeSelectedBlock = useCallback(() => {
    setSelectedBlock(null);
    setPendingTourAction(null);
    setGuestMessagePreview(null);
  }, []);

  /**
   * A confirmed tour: PropLane has told the guest it is happening. That earns
   * cancel-with-notice instead of a lone silent delete.
   *
   * `source === "planned"` ONLY. A PropLane-shaped Google event is `"external"`
   * and its `sourceId` is a Google Calendar event id, which the two server
   * routes look up in `axis_admin_planned_events_v1` — so offering those
   * controls there can only ever 404. `Delete event` keeps working for them
   * because it routes through the Google delete path instead.
   */
  const selectedIsConfirmedTour =
    selectedBlock?.kind === "meeting" &&
    selectedBlock.meeting.kind === "tour" &&
    selectedBlock.meeting.source === "planned";

  /**
   * Whether PropLane already emailed the guest "your tour is confirmed" — true
   * for a Google-sourced PropLane tour too, so the delete warning still names
   * the consequence even where cancel is unreachable.
   */
  const selectedTourGuestAlreadyTold =
    selectedBlock?.kind === "meeting" &&
    selectedBlock.meeting.kind === "tour" &&
    (selectedBlock.meeting.source === "planned" || isPropPlaneGoogleTourMeeting(selectedBlock.meeting));

  /**
   * Is the thing being deleted a tour someone outside PropLane is waiting on?
   *
   * The delete confirmation is armed for EVERY deletable meeting, including a
   * manager's own planned event, so the guest-facing wording has to be gated on
   * this — otherwise deleting a personal calendar entry asks about a guest who
   * does not exist and offers to "Keep tour".
   */
  const selectedIsGuestFacingTour =
    selectedBlock?.kind === "meeting" && selectedBlock.meeting.kind === "tour";

  const selectedIsPendingTourInquiry =
    selectedBlock?.kind === "meeting" &&
    selectedBlock.meeting.kind === "tour" &&
    selectedBlock.meeting.source === "inquiry";

  /** Matches the un-armed button, so arming never renames the action. */
  const selectedDeleteLabel =
    selectedBlock?.kind === "meeting" &&
    (selectedBlock.meeting.source === "planned" || isPropPlaneGoogleTourMeeting(selectedBlock.meeting))
      ? "Delete event"
      : selectedBlock?.kind === "meeting" && selectedBlock.meeting.kind === "tour"
        ? "Delete tour"
        : "Delete request";

  const selectedKeepLabel = selectedIsGuestFacingTour
    ? "Keep tour"
    : selectedDeleteLabel === "Delete event"
      ? "Keep event"
      : "Keep tour";

  useEffect(() => {
    if (!selectedBlock) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeSelectedBlock();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [closeSelectedBlock, selectedBlock]);

  const selectedBlockModal = (
    selectedBlock ? (
    <div className="fixed inset-0 z-[80] flex items-center justify-center p-4">
      <button
        type="button"
        aria-label="Close calendar details"
        className="absolute inset-0 modal-overlay"
        onClick={closeSelectedBlock}
      />
      {/* The height cap and `overflow-y-auto` are load-bearing, not styling: the
          parent is `fixed inset-0` (so the PAGE cannot scroll) and `.modal-panel`
          sets no cap of its own. Without them a tour inquiry carrying
          name/email/phone/property/room/notes renders taller than a 667px phone
          and the Approve/Delete row is simply unreachable. */}
      <div
        className="modal-panel relative z-[81] max-h-[min(600px,calc(100svh-2rem))] w-full max-w-[540px] overflow-y-auto rounded-3xl border border-border p-4 shadow-2xl sm:p-5"
      >
      <div className="mb-4 flex items-center justify-between gap-3 border-b border-border pb-3">
        <h3 className="min-w-0 text-base font-bold text-foreground">
          {selectedBlock.kind === "meeting"
            ? isGoogleCalendarPrivateBlock(selectedBlock.meeting)
              ? "Blocked"
              : selectedBlock.meeting.title
            : "Availability block"}
        </h3>
        <button
          type="button"
          onClick={closeSelectedBlock}
          aria-label="Close"
          className={MODAL_HEADER_CLOSE_CLASS}
        >
          <X className="h-5 w-5" aria-hidden />
        </button>
      </div>
      {selectedBlock?.kind === "meeting" ? (
        <div className="space-y-5">
          <div className="rounded-2xl border border-border bg-accent/30 px-4 py-3 text-sm text-muted">
            <p className="font-semibold text-foreground">{formatRangeLabel(selectedBlock.meeting.startIso, selectedBlock.meeting.endIso)}</p>
            <p className="mt-1 text-xs font-semibold uppercase tracking-[0.14em] text-muted">
              {selectedBlock.meeting.statusLabel ??
                (selectedBlock.meeting.source === "planned" || isPropPlaneGoogleTourMeeting(selectedBlock.meeting)
                  ? "Confirmed"
                  : "Requested")}
            </p>
          </div>

          {isGoogleCalendarPrivateBlock(selectedBlock.meeting) ? (
            <p className="text-sm text-muted">
              This time is busy on your linked Google Calendar. Personal event details stay on Google — only the blocked
              time is shown here so tour availability stays accurate.
            </p>
          ) : (
            <>
          <div className="grid gap-3 text-sm sm:grid-cols-2">
            {selectedBlock.meeting.name ? (
              <div>
                <p className="text-xs font-bold uppercase tracking-[0.14em] text-muted">Name</p>
                <p className="mt-1 font-medium text-foreground">{selectedBlock.meeting.name}</p>
              </div>
            ) : null}
            {selectedBlock.meeting.email ? (
              <div>
                <p className="text-xs font-bold uppercase tracking-[0.14em] text-muted">Email</p>
                <p className="mt-1 break-words font-medium text-foreground">{selectedBlock.meeting.email}</p>
              </div>
            ) : null}
            {selectedBlock.meeting.phone ? (
              <div>
                <p className="text-xs font-bold uppercase tracking-[0.14em] text-muted">Phone</p>
                <p className="mt-1 font-medium text-foreground">
                  {formatTourContactPhoneDisplay(selectedBlock.meeting.phone)}
                </p>
              </div>
            ) : null}
            {selectedBlock.meeting.propertyTitle ? (
              <div>
                <p className="text-xs font-bold uppercase tracking-[0.14em] text-muted">Property</p>
                <p className="mt-1 break-words font-medium text-foreground">
                  {selectedBlock.meeting.propertyTitle}
                  {selectedBlock.meeting.roomLabel ? ` · ${selectedBlock.meeting.roomLabel}` : ""}
                </p>
              </div>
            ) : null}
          </div>

          {selectedBlock.meeting.notes ? (
            <div className="rounded-2xl border border-border bg-card px-4 py-3 text-sm">
              <p className="text-xs font-bold uppercase tracking-[0.14em] text-muted">Notes</p>
              <p className="mt-1.5 whitespace-pre-wrap text-muted">{selectedBlock.meeting.notes}</p>
            </div>
          ) : null}

          {selectedBlock.meeting.instructions ? (
            <div className="rounded-2xl border px-4 py-3 text-sm portal-banner-info">
              <p className="text-xs font-bold uppercase tracking-[0.14em] text-sky-700 portal-calendar-callout-sky-sub [html[data-theme=dark]_&]:portal-calendar-callout-sky-sub">Confirmation details</p>
              <p className="mt-1.5 whitespace-pre-wrap text-sky-950 portal-calendar-callout-sky-title [html[data-theme=dark]_&]:portal-calendar-callout-sky-title">{selectedBlock.meeting.instructions}</p>
            </div>
          ) : null}

          {selectedIsConfirmedTour && !selectedBlock.meeting.isPeerTour ? (
            <TourReminderTourPanel
              plannedEventId={selectedBlock.meeting.sourceId}
              tourStartIso={selectedBlock.meeting.startIso}
              tourEndIso={selectedBlock.meeting.endIso}
              recipientEmail={selectedBlock.meeting.email}
              recipientName={selectedBlock.meeting.name}
              propertyTitle={
                selectedBlock.meeting.propertyTitle
                  ? `${selectedBlock.meeting.propertyTitle}${selectedBlock.meeting.roomLabel ? ` · ${selectedBlock.meeting.roomLabel}` : ""}`
                  : undefined
              }
              instructions={selectedBlock.meeting.instructions}
            />
          ) : null}

          {selectedBlock.meeting.isPeerTour ? (
            <div className="rounded-2xl border border-border bg-accent/30 px-4 py-3 text-sm text-muted">
              Hosted by {selectedBlock.meeting.hostLabel ?? "your co-manager"}. You can view this tour because you were also available when it was booked.
            </div>
          ) : null}

          {selectedBlock.meeting.source === "inquiry" && !selectedBlock.meeting.isPeerTour ? (
            <div className="rounded-2xl border border-border bg-card px-4 py-3 text-sm">
              <p className="text-xs font-bold uppercase tracking-[0.14em] text-muted">Duration</p>
              <div className="mt-2 flex flex-wrap items-center gap-2">
                {EVENT_DURATION_PRESET_MINUTES.map((minutes) => (
                  <button
                    key={minutes}
                    type="button"
                    data-attr="event-duration-preset"
                    onClick={() => {
                      setDurationChoice(minutes);
                      setCustomDurationText(String(minutes));
                    }}
                    className={`rounded-full border px-3 py-1.5 text-xs font-semibold transition ${
                      durationChoice === minutes
                        ? "border-primary bg-primary/[0.12] text-primary"
                        : "border-border bg-card text-muted hover:border-primary/30"
                    }`}
                  >
                    {minutes} min
                  </button>
                ))}
                <button
                  type="button"
                  data-attr="event-duration-custom"
                  onClick={() => setDurationChoice("custom")}
                  className={`rounded-full border px-3 py-1.5 text-xs font-semibold transition ${
                    durationChoice === "custom"
                      ? "border-primary bg-primary/[0.12] text-primary"
                      : "border-border bg-card text-muted hover:border-primary/30"
                  }`}
                >
                  Custom
                </button>
                {durationChoice === "custom" ? (
                  <label className="flex items-center gap-1.5 text-xs font-semibold text-muted">
                    <Input
                      type="number"
                      min={MIN_EVENT_DURATION_MINUTES}
                      max={MAX_EVENT_DURATION_MINUTES}
                      step={5}
                      value={customDurationText}
                      onChange={(e) => setCustomDurationText(e.target.value)}
                      className="h-9 w-24 rounded-xl"
                      aria-label="Custom duration in minutes"
                    />
                    min
                  </label>
                ) : null}
              </div>
              <p className="mt-2 text-xs text-muted">
                Will be scheduled for{" "}
                <span className="font-semibold text-foreground">
                  {formatRangeLabel(
                    selectedBlock.meeting.startIso,
                    endIsoForDuration(selectedBlock.meeting.startIso, selectedDurationMinutes),
                  )}
                </span>
              </p>
            </div>
          ) : null}

            </>
          )}

          {pendingTourAction === "delete" && !selectedIsPendingTourInquiry && !selectedIsConfirmedTour ? (
            <div className="rounded-2xl border px-4 py-3 text-sm portal-banner-pending" data-attr="tour-delete-confirm">
              <p className="font-semibold text-foreground">
                {selectedIsGuestFacingTour ? "Delete without telling the guest?" : "Delete this event?"}
              </p>
              <p className="mt-1 text-xs text-muted">
                {selectedIsGuestFacingTour
                  ? "This removes the event from your calendar and sends nothing."
                  : "This removes the event from your calendar. It cannot be undone."}
                {selectedTourGuestAlreadyTold
                  ? " The guest was already told this tour is confirmed, so they will still expect it. Use Cancel tour instead unless you have already reached them."
                  : ""}
              </p>
            </div>
          ) : null}

          <div className="flex flex-wrap items-center gap-2 border-t border-border pt-4">
            {calendarMeetingSupportsDelete(selectedBlock.meeting) ? (
              <>
            {pendingTourAction ? (
              <>
                <Button
                  type="button"
                  variant="outline"
                  className="h-9 shrink-0 whitespace-nowrap rounded-full px-3 text-xs sm:h-10 sm:px-5 sm:text-sm"
                  onClick={() => setPendingTourAction(null)}
                >
                  {selectedKeepLabel}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  loading={tourActionBusy}
                  className="h-9 shrink-0 whitespace-nowrap rounded-full border-rose-200 px-3 text-xs text-rose-800 hover:bg-[var(--status-overdue-bg)] sm:h-10 sm:px-5 sm:text-sm"
                  data-attr="tour-delete-submit"
                  onClick={() => deleteSelectedMeeting()}
                >
                  {selectedDeleteLabel}
                </Button>
              </>
            ) : (
              <>
            {selectedBlock.meeting.email?.trim() && !pendingTourAction ? (
              <Button
                type="button"
                variant="outline"
                className="h-9 shrink-0 whitespace-nowrap rounded-full px-4 text-xs sm:h-10 sm:px-5 sm:text-sm"
                data-attr="tour-open-message-thread"
                onClick={() =>
                  openGuestMessageCompose(selectedBlock.meeting.email, selectedBlock.meeting.phone)
                }
              >
                {selectedIsConfirmedTour || selectedIsGuestFacingTour ? "Message resident" : "Message"}
              </Button>
            ) : null}
            {selectedIsConfirmedTour ? (
              <Button
                type="button"
                variant="outline"
                className="h-9 shrink-0 whitespace-nowrap rounded-full border-rose-200 px-3 text-xs text-rose-800 hover:bg-[var(--status-overdue-bg)] sm:h-10 sm:px-5 sm:text-sm"
                data-attr="tour-cancel-open"
                onClick={openConfirmedTourCancelPreview}
              >
                Cancel tour
              </Button>
            ) : null}
            <Button
              type="button"
              variant="outline"
              className="h-9 shrink-0 whitespace-nowrap rounded-full border-rose-200 px-4 text-xs text-rose-800 hover:bg-[var(--status-overdue-bg)] sm:h-10 sm:px-5 sm:text-sm"
              data-attr="tour-delete-open"
              onClick={() => {
                if (selectedIsPendingTourInquiry) openTourDeletePreview();
                else if (selectedIsConfirmedTour) openConfirmedTourDeletePreview();
                else setPendingTourAction("delete");
              }}
            >
              {selectedDeleteLabel}
            </Button>
            {selectedBlock.meeting.source === "inquiry" ? (
              selectedBlock.meeting.kind === "tour" ? (
                <Button
                  type="button"
                  variant="primary"
                  className="h-9 min-w-0 shrink-0 whitespace-nowrap rounded-full px-4 text-xs sm:h-10 sm:px-5 sm:text-sm"
                  onClick={openTourConfirmPreview}
                >
                  Confirm tour
                </Button>
              ) : (
                <Button
                  type="button"
                  variant="primary"
                  className="h-9 shrink-0 whitespace-nowrap rounded-full px-3 text-xs sm:h-10 sm:px-5 sm:text-sm"
                  onClick={() => approveSelectedInquiry()}
                >
                  Approve
                </Button>
              )
            ) : null}
              </>
            )}
              </>
            ) : null}
          </div>
        </div>
      ) : selectedBlock?.kind === "availability" ? (
        <div className="space-y-5">
          <div className="rounded-2xl border px-4 py-3 text-sm portal-banner-success">
            <p className="font-semibold">Open tour window</p>
            <p className="mt-1">
              {formatRangeLabel(
                localIsoForSlot(selectedBlock.dateStr, selectedBlock.slotIndex),
                localIsoForSlot(selectedBlock.dateStr, selectedBlock.slotIndex + 1),
              )}
            </p>
          </div>
          <p className="text-sm text-muted">Delete this slot if you no longer want applicants to book it.</p>
          <div className="flex flex-nowrap items-center gap-1.5 border-t border-border pt-4 sm:gap-2">
            <Button
              type="button"
              variant="outline"
              className="h-9 shrink-0 whitespace-nowrap rounded-full border-rose-200 px-3 text-xs text-rose-800 hover:bg-[var(--status-overdue-bg)] sm:h-10 sm:px-5 sm:text-sm"
              onClick={deleteAvailabilitySlot}
            >
              Delete slot
            </Button>
          </div>
        </div>
      ) : null}
      </div>
    </div>
    ) : null
  );

  const tourGuestNotifyPreviewModal = tourGuestNotifyPreview ? (
    <PortalNotificationPreviewModal
      open
      title={TOUR_GUEST_NOTIFY_PREVIEW_COPY[tourGuestNotifyPreview.action].title}
      onClose={() => setTourGuestNotifyPreview(null)}
      recipient={tourGuestNotifyPreview.meeting.email ?? ""}
      recipientPhone={tourGuestNotifyPreview.meeting.phone?.trim() || undefined}
      subject={tourGuestNotifyPreview.subject}
      body={tourGuestNotifyPreview.body}
      intro={TOUR_GUEST_NOTIFY_PREVIEW_COPY[tourGuestNotifyPreview.action].intro}
      skipMessageLabel={TOUR_GUEST_NOTIFY_PREVIEW_COPY[tourGuestNotifyPreview.action].skipMessageLabel}
      showChannelPicker
      emailAvailable={Boolean(tourGuestNotifyPreview.meeting.email?.includes("@"))}
      smsAvailable={Boolean(tourGuestNotifyPreview.meeting.phone?.trim())}
      showSchedule={false}
      confirmLabel={TOUR_GUEST_NOTIFY_PREVIEW_COPY[tourGuestNotifyPreview.action].confirmLabel}
      confirmLabelWithoutMessage={
        TOUR_GUEST_NOTIFY_PREVIEW_COPY[tourGuestNotifyPreview.action].confirmLabelWithoutMessage
      }
      confirmBusy={tourNotifyPreviewBusy}
      confirmBusyLabel={TOUR_GUEST_NOTIFY_PREVIEW_COPY[tourGuestNotifyPreview.action].confirmBusyLabel}
      panelClassName="z-[90] max-w-xl"
      onConfirm={(skipMessage, _channels, draft) => void submitTourGuestNotifyPreview(skipMessage, _channels, draft)}
    />
  ) : null;

  const guestMessageModal = guestMessagePreview ? (
    <PortalNotificationPreviewModal
      open
      title="Message resident"
      onClose={() => {
        if (guestMessageBusy) return;
        setGuestMessagePreview(null);
      }}
      recipient={guestMessagePreview.email}
      recipientPhone={guestMessagePreview.phone}
      subject=""
      body=""
      showSkipMessage={false}
      showChannelPicker
      emailAvailable
      smsAvailable={Boolean(guestMessagePreview.phone)}
      defaultViaSms={false}
      showSchedule={false}
      confirmLabel="Send message"
      confirmBusy={guestMessageBusy}
      confirmBusyLabel="Sending…"
      panelClassName="z-[90] max-w-xl"
      onConfirm={(_skip, channels, draft) => void submitGuestMessage(false, channels, draft)}
    />
  ) : null;

  if (!storageKey && !readOnly && writeStorageKeys.length === 0) {
    return bareSurface ? (
      <p className="text-sm font-medium text-foreground">{unavailableMessage}</p>
    ) : (
      <Card className="p-5">
        <p className="text-sm font-medium text-foreground">{unavailableMessage}</p>
      </Card>
    );
  }

  if (compactAvailability) {
    const vendorMode = Boolean(vendorDayFlexibility);
    const compactShellClass = cn(
      "portal-calendar-compact flex flex-col",
      flowScroll ? "portal-calendar-flow-scroll" : "min-h-0 flex-1",
      !bareSurface && "overflow-hidden rounded-2xl border border-border bg-card shadow-sm",
    );
    const compactToolbarClass = cn(
      "portal-calendar-toolbar shrink-0",
      "px-2 py-2.5 sm:px-3 sm:py-3",
      bareSurface
        ? flowScroll
          ? "border-b border-border/50 bg-background"
          : "border-b border-border/50"
        : "border-b border-border/60 bg-gradient-to-b from-accent/35 to-accent/15 [html[data-theme=dark]_&]:portal-calendar-week-banner",
    );
    const compactBodyClass = cn(
      "portal-calendar-compact-body",
      flowScroll ? "" : "min-h-0 flex-1",
      bareSurface
        ? flowScroll
          ? ""
          : "pt-2 max-lg:pt-4"
        : "p-3 sm:p-4 max-lg:px-4 max-lg:pt-4 max-lg:pb-5",
    );
    const compactGridTopGap = flowScroll ? "mt-0" : "mt-2";
    const compactMobileTopGap = flowScroll ? "mt-0" : "mt-2 max-lg:mt-4";
    return (
      <>
        <div className={compactShellClass}>
          <div className={compactToolbarClass}>
            <div className="flex w-full min-w-0 max-w-full flex-wrap items-center justify-center gap-1.5 sm:gap-2">
              <Button
                type="button"
                variant="ghost"
                className="h-8 w-7 shrink-0 rounded-full p-0 text-base leading-none text-muted hover:bg-accent/60 hover:text-foreground"
                onClick={() => shiftAvailabilityWeek(-1)}
                aria-label="Previous week"
              >
                ←
              </Button>
              <p className="shrink-0 whitespace-nowrap px-0.5 text-center text-xs font-semibold text-foreground sm:text-sm">
                {formatWeekRangeMonSun(weekMonday)}
              </p>
              <Button
                type="button"
                variant="ghost"
                className="h-8 w-7 shrink-0 rounded-full p-0 text-base leading-none text-muted hover:bg-accent/60 hover:text-foreground"
                onClick={() => shiftAvailabilityWeek(1)}
                aria-label="Next week"
              >
                →
              </Button>
              {!vendorMode ? (
                <div className="shrink-0 pl-0.5 sm:pl-1">{renderTimeWindowControl(true)}</div>
              ) : null}
              <div className="mx-0.5 hidden h-7 w-px shrink-0 bg-border/80 sm:block" aria-hidden />
              {saveStatus === "saving" ? <span className={`shrink-0 px-2 py-0.5 text-[11px] font-semibold ${CALENDAR_BADGE_INFO}`}>Saving…</span> : null}
              {saveStatus === "error" ? <span className={`shrink-0 px-2 py-0.5 text-[11px] font-semibold ${CALENDAR_BADGE_ERROR}`}>Failed</span> : null}
              {vendorMode ? (
                <Button
                  type="button"
                  variant="outline"
                  className="h-7 shrink-0 rounded-full px-2.5 text-xs"
                  data-attr="vendor-flexible-settings-open"
                  onClick={vendorDayFlexibility!.onOpenFlexibleSettings}
                >
                  Flexible
                </Button>
              ) : null}
              {vendorMode && vendorCalendarActions?.onAddWork ? (
                <Button
                  type="button"
                  variant="outline"
                  className="h-7 shrink-0 rounded-full px-2.5 text-xs"
                  data-attr="vendor-add-work-open"
                  onClick={vendorCalendarActions.onAddWork}
                >
                  Add work
                </Button>
              ) : null}
            </div>
            {!vendorMode && !readOnly ? (
              <div className="mt-2 flex w-full flex-wrap items-center justify-center gap-1.5 sm:gap-2">
                <Button
                  type="button"
                  variant="outline"
                  className={COMPACT_CALENDAR_ACTION_BTN}
                  disabled={readOnly}
                  title={readOnly ? "Select one house to edit availability" : undefined}
                  onClick={copyPreviousWeek}
                >
                  Copy previous week
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  className={COMPACT_CALENDAR_ACTION_BTN}
                  disabled={readOnly}
                  title={readOnly ? "Select one house to edit availability" : undefined}
                  onClick={openBlockModal}
                >
                  Block
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  className={COMPACT_CALENDAR_ACTION_BTN}
                  disabled={readOnly}
                  title={readOnly ? "Select one house to edit availability" : undefined}
                  onClick={clearCurrentWeek}
                >
                  Clear
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  className={COMPACT_CALENDAR_ACTION_BTN}
                  disabled={readOnly || !onCopyWeekToHouses || !otherProperties?.length}
                  title={
                    readOnly
                      ? "Select one house to edit availability"
                      : !otherProperties?.length
                        ? "Add another house to copy availability"
                        : undefined
                  }
                  onClick={() => {
                    setSelectedHouseIds(new Set());
                    setCopyToHousesScope("week");
                    setUpdateToHousesOpen(true);
                  }}
                >
                  Copy to houses
                </Button>
              </div>
            ) : null}
          </div>

          <div className={compactBodyClass}>
          {upcomingMeetingSummary.total > 0 ? (
            <div className="mt-2 rounded-2xl border px-4 py-3 portal-banner-info">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <p className="text-sm font-bold text-sky-950 portal-calendar-callout-sky-title [html[data-theme=dark]_&]:portal-calendar-callout-sky-title">
                    {upcomingMeetingSummary.total} upcoming {eventSummaryKind}
                    {upcomingMeetingSummary.total === 1 ? "" : "s"} on this calendar
                  </p>
                  <p className="mt-1 text-xs font-medium text-sky-800 portal-calendar-callout-sky-sub [html[data-theme=dark]_&]:portal-calendar-callout-sky-sub">
                    {upcomingMeetingSummary.pending} pending · {upcomingMeetingSummary.confirmed} confirmed
                  </p>
                </div>
              </div>
              <div className="mt-3 grid gap-2 md:grid-cols-3">
                {upcomingMeetingSummary.next.map((meeting) => (
                  <button
                    key={meeting.id}
                    type="button"
                    className="rounded-xl border bg-card px-3 py-2 text-left text-xs shadow-sm transition hover:border-primary/30 hover:bg-[var(--status-approved-bg)]"
                    onClick={(e: MouseEvent<HTMLButtonElement>) => openSlotDetails(meeting.dateStr, meeting.startSlot, e.currentTarget, meeting)}
                  >
                    <span className="block font-bold text-foreground">{meetingCalendarGridLabel(meeting)}</span>
                    <span className="mt-1 block text-muted">{formatRangeLabel(meeting.startIso, meeting.endIso)}</span>
                    {meeting.propertyTitle ? (
                      <span className="mt-1 block truncate text-muted">{meeting.propertyTitle}</span>
                    ) : null}
                  </button>
                ))}
              </div>
            </div>
          ) : null}

          {(() => {
            const renderSlotButton = (ds: string, slotIdx: number) => {
              const key = dateSlotKey(ds, slotIdx);
              const active = activeSlots.has(key);
              const coManagerOverlay = coManagerOverlayBySlotKey.get(key);
              const coManagerOpen = Boolean(coManagerOverlay && !active && !meetingBySlotKey.get(key));
              const selected = isSlotInDragSelection(ds, slotIdx);
              const meeting = meetingBySlotKey.get(key);
              // Bookable by the 9-5 default rather than by anything the manager
              // painted. Shown so the calendar tells the truth about what
              // prospects can book; clicking removes just this window.
              const defaultOpen = Boolean(
                !active && !meeting && !coManagerOpen && defaultOnlySlots.has(key),
              );
              const isMeetingStart = Boolean(
                meeting && key === dateSlotKey(meeting.dateStr, meeting.startSlot),
              );
              return (
                <button
                  key={key}
                  type="button"
                  onMouseDown={() => {
                    if (readOnly || meeting || active || coManagerOpen || defaultOpen) return;
                    // Weekday must come from the column's actual date, not its position in the
                    // window — the compact view can start on any weekday, so the Nth column is
                    // not the Nth weekday.
                    startDragSelection(ds, mondayBasedDayIndex(new Date(`${ds}T12:00:00`)), slotIdx);
                  }}
                  onMouseEnter={() => {
                    if (readOnly || meeting || active || coManagerOpen || defaultOpen) return;
                    extendDragSelection(ds, slotIdx);
                  }}
                  onMouseUp={() => {
                    if (readOnly || meeting || active || coManagerOpen || defaultOpen) return;
                    finishDragSelection();
                  }}
                  onClick={(e: MouseEvent<HTMLButtonElement>) => {
                    if (defaultOpen) {
                      if (canEditAvailability) removeDefaultSlot(ds, slotIdx);
                      return;
                    }
                    // Keyboard activation (Enter / Space) fires click without any
                    // mousedown/mouseup, so the drag-select path never runs. Open the
                    // block modal directly for an empty slot so the grid is usable
                    // without a mouse.
                    if (!readOnly && !meeting && !active && !coManagerOpen && e.detail === 0) {
                      openBlockModalForSlot(ds, mondayBasedDayIndex(new Date(`${ds}T12:00:00`)), slotIdx);
                      return;
                    }
                    openSlotDetails(ds, slotIdx, e.currentTarget, meeting);
                  }}
                  className={`portal-calendar-grid-slot min-h-9 px-2 text-center text-[11px] font-semibold transition ${
                    meeting
                      ? `${meeting.color} ring-1 ring-inset`
                      : selected
                        ? "bg-primary/[0.14] text-primary ring-2 ring-inset ring-primary/35"
                      : active
                        ? CALENDAR_OPEN_SLOT
                        : coManagerOpen
                          ? CALENDAR_CO_MANAGER_SLOT
                          : defaultOpen
                            ? CALENDAR_DEFAULT_OPEN_SLOT
                        : CALENDAR_EMPTY_SLOT
                  }`}
                  title={
                    defaultOpen
                      ? canEditAvailability
                        ? "Open for tours by default — click to remove this time"
                        : "Open for tours by default. Select one house to edit availability."
                      : undefined
                  }
                  aria-label={
                    defaultOpen
                      ? canEditAvailability
                        ? `Open for tours by default. Remove ${formatAvailabilitySlotLabel(slotIdx)} on ${ds}`
                        : `Open for tours by default at ${formatAvailabilitySlotLabel(slotIdx)} on ${ds}. Select one house to edit availability.`
                      : `${meeting || active || coManagerOpen ? "Open details for" : "Select"} ${formatAvailabilitySlotLabel(slotIdx)} on ${ds}`
                  }
                >
                  {meeting ? (
                    isMeetingStart ? (
                      <span className="block truncate">{meetingCalendarGridLabel(meeting)}</span>
                    ) : (
                      <span className="block truncate opacity-70">
                        {isGoogleCalendarPrivateBlock(meeting) ? "Blocked" : meeting.statusLabel}
                      </span>
                    )
                  ) : selected ? (
                    "Selected"
                  ) : active ? (
                    "Open"
                  ) : coManagerOpen ? (
                    `${coManagerOverlay!.label}`
                  ) : (
                    readOnly ? "" : "Add"
                  )}
                </button>
              );
            };

            const mobileDs = activeBlockDateStrs[mobileDayIndex] ?? activeBlockDateStrs[0]!;
            const mobileDate = activeBlockDates[mobileDayIndex] ?? activeBlockDates[0]!;
            const renderFlexibleToggle = (weekday: number) => {
              if (!vendorDayFlexibility) return null;
              const checked = vendorDayFlexibility.flexibleWeekdays.has(weekday);
              return (
                <label className="mt-1.5 flex cursor-pointer items-center justify-center gap-1.5 text-[10px] font-medium text-muted">
                  <input
                    type="checkbox"
                    className="h-3.5 w-3.5 rounded border-border"
                    checked={checked}
                    data-attr={`vendor-flexible-day-${weekday}`}
                    onChange={() => vendorDayFlexibility.onToggleFlexibleDay(weekday)}
                  />
                  <span>Mark day as flexible</span>
                </label>
              );
            };

            return (
              <>
                {/* Mobile: week strip — seven equal columns across full width. */}
                <div className={`${compactMobileTopGap} lg:hidden`}>
                  <div className="grid w-full grid-cols-7 gap-1 pb-1 sm:gap-1.5">
                    {activeBlockDates.map((d, idx) => {
                      const ds = toLocalDateStr(d);
                      const count = showEventCountsInDayHeader
                        ? scheduledMeetings.filter((meeting) => meeting.dateStr === ds).length
                        : openSlotCountForDate(ds);
                      const isActive = idx === mobileDayIndex;
                      return (
                        <button
                          key={ds}
                          type="button"
                          onClick={() => {
                            setMobileDayIndex(idx);
                            setAnchorDate(activeBlockDates[idx]!);
                          }}
                          className={`flex min-w-0 w-full flex-col items-center justify-center rounded-xl px-1 py-1.5 text-center transition max-lg:py-2 ${
                            isActive ? "bg-primary text-primary-foreground" : "bg-accent/40 text-muted"
                          }`}
                        >
                          <span className="text-[10px] font-bold uppercase tracking-[0.08em]">
                            {d.toLocaleDateString(undefined, { weekday: "short" })}
                          </span>
                          <span className="text-sm font-semibold">{d.toLocaleDateString(undefined, { day: "numeric" })}</span>
                          <span className="text-[9px] font-medium opacity-80">{showEventCountsInDayHeader ? `${count} event${count === 1 ? "" : "s"}` : `${count} open`}</span>
                        </button>
                      );
                    })}
                  </div>
                  {vendorDayFlexibility ? (
                    <div className="mt-2 flex justify-center">{renderFlexibleToggle(mobileDate.getDay())}</div>
                  ) : null}
                  <div className={bareSurface ? "mt-2" : "mt-2 overflow-hidden rounded-2xl border border-border bg-card"}>
                    <div className={`grid grid-cols-[72px_1fr] text-xs ${CALENDAR_GRID_GAP}`}>
                      <div className={`px-2 py-2 ${bareSurface ? "bg-transparent" : ""} ${CALENDAR_HEADER_CELL}`}>Time</div>
                      <div className={`px-2 py-2 text-center ${CALENDAR_HEADER_CELL}`}>
                        {mobileDate.toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" })}
                      </div>
                      {visibleSlotIndices.map((slotIdx) => (
                        <Fragment key={slotIdx}>
                          <div className={`flex min-h-9 items-center bg-card px-2 ${CALENDAR_TIME_CELL}`}>
                            {formatAvailabilitySlotLabel(slotIdx)}
                          </div>
                          {renderSlotButton(mobileDs, slotIdx)}
                        </Fragment>
                      ))}
                    </div>
                  </div>
                </div>

                {/* Desktop: full-week grid with horizontal scroll on narrower viewports. */}
                <div className={`${compactGridTopGap} hidden lg:block`}>
                  <div className={bareSurface ? "" : "overflow-hidden rounded-2xl border border-border bg-card"}>
                    <div className="overflow-x-auto" onMouseLeave={cancelDragSelection} onMouseUp={finishDragSelection}>
                      <div className={`grid min-w-[760px] grid-cols-[56px_repeat(7,minmax(72px,1fr))] text-[10px] sm:text-xs ${CALENDAR_GRID_GAP}`}>
                        <div className={`px-1.5 py-2 sm:px-2 ${CALENDAR_HEADER_CELL}`}>Time</div>
                        {activeBlockDates.map((d) => {
                          const ds = toLocalDateStr(d);
                          const count = showEventCountsInDayHeader
                            ? scheduledMeetings.filter((meeting) => meeting.dateStr === ds).length
                            : openSlotCountForDate(ds);
                          return (
                            <div key={ds} className={`px-1 py-2.5 text-center sm:px-2 ${CALENDAR_HEADER_CELL}`}>
                              <p className="text-[11px] font-semibold text-muted sm:text-xs">
                                {d.toLocaleDateString(undefined, { weekday: "short" })}
                              </p>
                              <p className="mt-0.5 text-sm font-semibold text-foreground">
                                {d.toLocaleDateString(undefined, { month: "short", day: "numeric" })}
                              </p>
                              <p className={`mt-0.5 text-[10px] font-medium sm:text-[11px] ${CALENDAR_OPEN_COUNT}`}>
                                {showEventCountsInDayHeader ? `${count} event${count === 1 ? "" : "s"}` : `${count} open`}
                              </p>
                              {renderFlexibleToggle(d.getDay())}
                            </div>
                          );
                        })}

                        {visibleSlotIndices.map((slotIdx) => (
                          <Fragment key={slotIdx}>
                            <div className={`flex min-h-8 items-center bg-card px-1.5 sm:min-h-9 sm:px-2 ${CALENDAR_TIME_CELL}`}>
                              {formatAvailabilitySlotLabel(slotIdx)}
                            </div>
                            {activeBlockDateStrs.map((ds) => renderSlotButton(ds, slotIdx))}
                          </Fragment>
                        ))}
                      </div>
                    </div>
                  </div>
                </div>
              </>
            );
          })()}
          </div>
        </div>

        <Modal
          open={blockModalOpen}
          title="Create recurring availability block"
          onClose={() => {
            setBlockModalOpen(false);
            setDragSelection(null);
          }}
          footer={
            <ModalFooter>
              <Button
                type="button"
                variant="primary"
                className="rounded-full"
                onClick={applyRecurringBlock}
                disabled={blockWeekdays.length === 0 || blockEndSlotExclusive <= blockStartSlot}
              >
                Create block
              </Button>
            </ModalFooter>
          }
        >
          <div className="space-y-5">
            <div className="rounded-2xl border border-border bg-accent/30 px-4 py-3 text-sm text-muted">{blockSummary}</div>

            <div className="space-y-2">
              <p className="text-sm font-semibold text-foreground">Days of week</p>
              <div className="flex flex-wrap gap-2">
                {WEEKDAY_OPTIONS.map((option) => {
                  const active = blockWeekdays.includes(option.value);
                  return (
                    <button
                      key={option.value}
                      type="button"
                      onClick={() => toggleBlockWeekday(option.value)}
                      className={`rounded-full border px-3 py-2 text-sm font-semibold transition ${
                        active
                          ? "border-primary bg-primary text-white"
                          : "border-border bg-card text-muted hover:border-primary/30 hover:text-primary [html[data-theme=dark]_&]:portal-calendar-inactive-slot"
                      }`}
                    >
                      {option.label}
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <label className="text-sm font-semibold text-foreground">Start time</label>
                <NativeSelect
                  value={String(blockStartSlot)}
                  onChange={(e) => {
                    const nextStart = Number.parseInt(e.target.value, 10);
                    if (!Number.isFinite(nextStart)) return;
                    setBlockStartSlot(nextStart);
                    setBlockEndSlotExclusive((current) =>
                      current <= nextStart ? Math.min(SLOTS_PER_DAY, nextStart + 1) : current,
                    );
                  }}
                >
                  {slotRowIndices.map((slot) => (
                    <option key={`block-start-${slot}`} value={slot}>
                      {formatAvailabilitySlotLabel(slot)}
                    </option>
                  ))}
                </NativeSelect>
              </div>
              <div className="space-y-2">
                <label className="text-sm font-semibold text-foreground">End time</label>
                <NativeSelect
                  value={String(blockEndSlotExclusive)}
                  onChange={(e) => {
                    const nextEnd = Number.parseInt(e.target.value, 10);
                    if (!Number.isFinite(nextEnd)) return;
                    setBlockEndSlotExclusive(nextEnd);
                    setBlockStartSlot((current) => (current >= nextEnd ? Math.max(0, nextEnd - 1) : current));
                  }}
                >
                  {slotRowIndices
                    .map((slot) => slot + 1)
                    .filter((slot) => slot > blockStartSlot && slot <= SLOTS_PER_DAY)
                    .map((slot) => (
                      <option key={`block-end-${slot}`} value={slot}>
                        {formatSlotEndLabel(slot)}
                      </option>
                    ))}
                </NativeSelect>
              </div>
            </div>

            <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_140px]">
              <div className="space-y-2">
                <label className="text-sm font-semibold text-foreground">Repeat</label>
                <NativeSelect value={blockCadence} onChange={(e) => setBlockCadence(e.target.value as RecurrenceCadence)}>
                  <option value="once">Once</option>
                  <option value="weekly">Weekly</option>
                  <option value="biweekly">Biweekly</option>
                  <option value="monthly">Monthly</option>
                </NativeSelect>
              </div>
              <div className="space-y-2">
                <label className="text-sm font-semibold text-foreground">Occurrences</label>
                <Input
                  type="number"
                  min={1}
                  max={24}
                  value={String(blockCadence === "once" ? 1 : blockOccurrences)}
                  onChange={(e) => setBlockOccurrences(Math.max(1, Math.min(24, Number.parseInt(e.target.value, 10) || 1)))}
                  disabled={blockCadence === "once"}
                />
              </div>
            </div>

          </div>
        </Modal>

        {otherProperties && otherProperties.length > 0 && onCopyWeekToHouses ? (
          <Modal
            open={updateToHousesOpen}
            title="Copy availability to other houses"
            onClose={() => setUpdateToHousesOpen(false)}
            footer={
              <ModalFooter>
                <Button
                  type="button"
                  variant="primary"
                  className="rounded-full"
                  disabled={selectedHouseIds.size === 0}
                  onClick={() => {
                    onCopyWeekToHouses([...selectedHouseIds], activeBlockDateStrs, copyToHousesScope);
                    setUpdateToHousesOpen(false);
                  }}
                >
                  Copy to {selectedHouseIds.size > 0 ? `${selectedHouseIds.size} house${selectedHouseIds.size > 1 ? "s" : ""}` : "houses"}
                </Button>
              </ModalFooter>
            }
          >
            <div className="space-y-5">
              <p className="text-sm text-muted">
                {copyToHousesScope === "week"
                  ? "Copy this week's open slots to the selected houses. New slots are added on top of existing ones — nothing is removed."
                  : "Copy every open slot from this house to the selected houses. New slots are added on top of existing ones — nothing is removed."}
              </p>
              <div className="space-y-2">
                {otherProperties.map((p) => (
                  <label
                    key={p.id}
                    className={`flex cursor-pointer items-center gap-3 rounded-xl border px-4 py-3 transition ${
                      selectedHouseIds.has(p.id)
                        ? "border-primary bg-primary/[0.06] ring-1 ring-primary/30"
                        : "border-border bg-card hover:border-border"
                    }`}
                  >
                    <input
                      type="checkbox"
                      checked={selectedHouseIds.has(p.id)}
                      onChange={(e) => {
                        setSelectedHouseIds((cur) => {
                          const next = new Set(cur);
                          if (e.target.checked) next.add(p.id);
                          else next.delete(p.id);
                          return next;
                        });
                      }}
                      className="h-4 w-4 rounded border-border accent-primary"
                    />
                    <span className="text-sm font-medium text-foreground">{p.name}</span>
                  </label>
                ))}
              </div>
              <div className="grid grid-cols-2 gap-2">
                <label
                  className={`flex cursor-pointer items-center gap-2.5 rounded-xl border px-3 py-2.5 transition ${
                    copyToHousesScope === "week"
                      ? "border-primary bg-primary/[0.06] ring-1 ring-primary/30"
                      : "border-border bg-card hover:border-border"
                  }`}
                >
                  <input
                    type="checkbox"
                    checked={copyToHousesScope === "week"}
                    onChange={() => setCopyToHousesScope("week")}
                    className="h-4 w-4 rounded border-border accent-primary"
                  />
                  <span className="text-sm font-medium text-foreground">This week only</span>
                </label>
                <label
                  className={`flex cursor-pointer items-center gap-2.5 rounded-xl border px-3 py-2.5 transition ${
                    copyToHousesScope === "entire"
                      ? "border-primary bg-primary/[0.06] ring-1 ring-primary/30"
                      : "border-border bg-card hover:border-border"
                  }`}
                >
                  <input
                    type="checkbox"
                    checked={copyToHousesScope === "entire"}
                    onChange={() => setCopyToHousesScope("entire")}
                    className="h-4 w-4 rounded border-border accent-primary"
                  />
                  <span className="text-sm font-medium text-foreground">Entire schedule</span>
                </label>
              </div>
            </div>
          </Modal>
        ) : null}
        {selectedBlockModal}
        {tourGuestNotifyPreviewModal}
        {guestMessageModal}
      </>
    );
  }

  const scheduleCard = (
    <Card className="overflow-hidden p-0">
      <div className="border-b border-border bg-card px-5 py-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0">
            <p className="text-xs font-bold uppercase tracking-[0.16em] text-muted">
              {viewMode === "day" ? "Day view" : viewMode === "week" ? "Week view" : "Month view"}
            </p>
            <h2 className="mt-1 truncate text-xl font-semibold text-foreground">{formatNavTitle(anchorDate, viewMode)}</h2>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <div className="flex items-center gap-1 rounded-full border border-border bg-card p-0.5">
              <Button type="button" variant="outline" className="h-9 rounded-full px-3 text-xs" onClick={jumpToToday}>
                Today
              </Button>
              <Button type="button" variant="outline" className="h-9 rounded-full px-3 text-xs" onClick={() => shiftAnchor(-1)}>
                ←
              </Button>
              <Button type="button" variant="outline" className="h-9 rounded-full px-3 text-xs" onClick={() => shiftAnchor(1)}>
                →
              </Button>
            </div>
            <PortalSegmentedControl<CalendarMode>
              options={[
                { id: "day", label: "Day" },
                { id: "week", label: "Week" },
                { id: "month", label: "Month" },
              ]}
              value={viewMode}
              onChange={setViewMode}
            />
            <div className="rounded-full bg-accent/30 px-4 py-2 text-sm font-semibold text-muted">
              {viewMode === "month" ? monthBlocksCount : meetings.length} blocks
            </div>
            {viewMode !== "month" ? renderTimeWindowControl() : null}
            <Button type="button" variant="outline" className="h-9 rounded-full px-3 text-xs" onClick={openBlockModal}>
              Create block
            </Button>
          </div>
        </div>
      </div>

      {viewMode === "month" ? (
        <div className="p-5">
          <div className="grid grid-cols-7 gap-1 text-center text-[10px] font-bold uppercase tracking-wide text-muted">
            {["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((d) => (
              <div key={d} className="py-1">
                {d}
              </div>
            ))}
          </div>
          <div className="mt-1 grid grid-cols-7 gap-1">
            {monthCells.map((day, i) => {
              if (!day) return <div key={`pad-${i}`} className="aspect-square" />;
              const cellDate = new Date(monthYear, monthIndex, day, 12, 0, 0, 0);
              const ds = toLocalDateStr(cellDate);
              const picked = pinMonthSchedule && isInMonthPickRange(ds, monthPick);
              const hasAvail = dateHasAvailability(cellDate, offeredSlots);
              return (
                <button
                  key={`${monthYear}-${monthIndex}-${day}`}
                  type="button"
                  onClick={() => {
                    setAnchorDate(cellDate);
                    if (pinMonthSchedule) {
                      setMonthPick((prev) => {
                        if (!prev.start || (prev.start && prev.end)) return { start: ds, end: null };
                        if (prev.start === ds) return { start: ds, end: null };
                        return prev.start <= ds ? { start: prev.start, end: ds } : { start: ds, end: prev.start };
                      });
                    } else {
                      setViewMode("day");
                    }
                  }}
                  className={`flex aspect-square flex-col items-center justify-center rounded-xl border text-sm font-semibold transition hover:border-primary/30 ${
                    picked ? "border-primary bg-primary/[0.14] text-foreground ring-2 ring-primary/35" : ""
                  } ${hasAvail ? "border-primary/25 bg-primary/[0.07] text-foreground" : "border-border bg-card text-foreground"}`}
                >
                  {day}
                </button>
              );
            })}
          </div>
        </div>
      ) : null}

      {viewMode === "week" ? (
        <div className={PORTAL_CALENDAR_FRAME}>
          <div className="space-y-3">
            {fullWeekDates.map((d) => {
              const ds = toLocalDateStr(d);
              return (
                <div key={ds} className="overflow-hidden rounded-2xl border border-border bg-card">
                  <div className={`bg-accent/30 px-4 py-3 [html[data-theme=dark]_&]:portal-calendar-week-banner`}>
                    <p className="text-sm font-semibold text-foreground">{d.toLocaleDateString(undefined, { weekday: "long" })}</p>
                    <p className="text-xs text-muted">{d.toLocaleDateString(undefined, { month: "short", day: "numeric" })}</p>
                  </div>
                  <div className="grid grid-cols-[72px_minmax(0,1fr)] gap-px bg-accent/30">
                    {visibleSlotIndices.map((slotIdx) => {
                      const meeting = meetings.find((m) => m.dateStr === ds && m.startSlot === slotIdx);
                      return (
                        <Fragment key={`${ds}-${slotIdx}`}>
                          <div className={`bg-card px-3 py-2 text-[11px] ${CALENDAR_TIME_CELL}`}>{formatAvailabilitySlotLabel(slotIdx)}</div>
                          <div className="relative min-h-[40px] bg-card p-1">
                            {meeting ? (
                              <button
                                type="button"
                                className={`w-full rounded-xl border px-2 py-2 text-left text-xs font-semibold shadow-sm transition hover:brightness-95 ${meeting.color}`}
                                onClick={(e: MouseEvent<HTMLButtonElement>) => openSlotDetails(ds, slotIdx, e.currentTarget, meeting)}
                              >
                                {meetingCalendarGridLabel(meeting)}
                              </button>
                            ) : (
                              <div className="h-full rounded-xl border border-dashed border-border" />
                            )}
                          </div>
                        </Fragment>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      ) : null}

      {viewMode === "day" ? (
        <div className={PORTAL_CALENDAR_FRAME}>
          <div className={`grid grid-cols-[72px_minmax(0,1fr)] ${CALENDAR_GRID_GAP}`}>
            <div className={`col-span-2 px-3 py-3 text-center ${CALENDAR_HEADER_CELL}`}>
              <p className="text-sm font-semibold text-foreground">{anchorDate.toLocaleDateString(undefined, { weekday: "long" })}</p>
              <p className="text-xs text-muted">{anchorDate.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}</p>
            </div>
            {visibleSlotIndices.map((slotIdx) => {
              const ds = toLocalDateStr(anchorDate);
              const meeting = meetings.find((m) => m.dateStr === ds && m.startSlot === slotIdx);
              return (
                <Fragment key={slotIdx}>
                  <div className={`bg-card px-2 py-2 text-[11px] ${CALENDAR_TIME_CELL}`}>{formatAvailabilitySlotLabel(slotIdx)}</div>
                  <div className="relative min-h-[40px] bg-card p-1">
                    {meeting ? (
                      <button
                        type="button"
                        className={`absolute inset-1 z-[1] rounded-xl border px-2 py-2 text-left text-xs font-semibold shadow-sm transition hover:brightness-95 ${meeting.color}`}
                        style={{ height: `calc(${meeting.durationMinutes / SLOT_DURATION_MINUTES} * 40px - 4px)` }}
                        onClick={(e: MouseEvent<HTMLButtonElement>) => openSlotDetails(ds, slotIdx, e.currentTarget, meeting)}
                      >
                        {meetingCalendarGridLabel(meeting)}
                      </button>
                    ) : (
                      <div className="h-full rounded-xl border border-dashed border-border" />
                    )}
                  </div>
                </Fragment>
              );
            })}
          </div>
        </div>
      ) : null}
    </Card>
  );

  const availabilityCard = (
    <Card className="p-5">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0 flex-1">
          <p className="text-xs font-bold uppercase tracking-[0.16em] text-muted">Availability editor</p>
          <div className="mt-2 flex flex-wrap items-center gap-x-2.5 gap-y-1.5">
            <div className="min-w-0">
              <h2 className="text-xl font-semibold text-foreground">Public booking windows</h2>
              {tourScopeLabel ? <p className="mt-1 text-sm font-medium text-primary">{tourScopeLabel}</p> : null}
            </div>
            <div className="hidden h-7 w-px shrink-0 bg-border/80 sm:block" aria-hidden />
            {renderTimeWindowControl(true)}
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <Button type="button" variant="outline" className="h-9 shrink-0 rounded-full px-3 text-sm" onClick={jumpToToday}>
              Today
            </Button>
            <Button type="button" variant="outline" className="h-9 shrink-0 rounded-full px-3 text-sm" onClick={() => shiftAvailabilityWeek(-1)} aria-label="Previous week">
              ←
            </Button>
            <p className="min-w-0 flex-1 text-xs leading-snug text-muted sm:text-sm">
              <span className="font-semibold text-foreground">Week of {formatWeekRangeMonSun(weekMonday)}</span>
            </p>
            <Button type="button" variant="outline" className="h-9 shrink-0 rounded-full px-3 text-sm" onClick={() => shiftAvailabilityWeek(1)} aria-label="Next week">
              →
            </Button>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {saveStatus === "saving" ? <span className={`px-3 py-1.5 text-xs font-semibold ${CALENDAR_BADGE_INFO}`}>Saving…</span> : null}
          {saveStatus === "error" ? <span className={`px-3 py-1.5 text-xs font-semibold ${CALENDAR_BADGE_ERROR}`}>Save failed</span> : null}
          <div className={`px-4 py-2 text-sm font-semibold ${CALENDAR_BADGE_SUCCESS}`}>{weekSlotCount} open slots</div>
        </div>
      </div>

      <div className="mt-3 flex flex-wrap items-center justify-center gap-2">
        <Button type="button" variant="outline" className="shrink-0 rounded-full" onClick={openBlockModal}>
          Create block
        </Button>
        <Button type="button" variant="outline" className="shrink-0 rounded-full" onClick={copyPreviousWeek}>
          Copy previous week
        </Button>
      </div>

      <div className="mt-4 space-y-3 rounded-2xl border border-border bg-accent/30 p-3" onMouseLeave={cancelDragSelection} onMouseUp={finishDragSelection}>
        {fullWeekDates.map((d) => {
          const ds = toLocalDateStr(d);
          const weekday = mondayBasedDayIndex(d);
          return (
            <div key={ds} className="rounded-2xl border border-border bg-card p-3">
              <div className="mb-3">
                <p className="text-sm font-bold text-foreground">{d.toLocaleDateString(undefined, { weekday: "long" })}</p>
                <p className="text-xs font-semibold text-muted">{d.toLocaleDateString(undefined, { month: "short", day: "numeric" })}</p>
              </div>
              <div className="grid gap-2 sm:grid-cols-2">
                {visibleSlotIndices.map((slotIdx) => {
                  const key = dateSlotKey(ds, slotIdx);
                  const active = activeSlots.has(key);
                  const selected = isSlotInDragSelection(ds, slotIdx);
                  return (
                    <button
                      key={key}
                      type="button"
                      onMouseDown={() => {
                        if (active) return;
                        startDragSelection(ds, weekday, slotIdx);
                      }}
                      onMouseEnter={() => {
                        if (active) return;
                        extendDragSelection(ds, slotIdx);
                      }}
                      onMouseUp={() => {
                        if (active) return;
                        finishDragSelection();
                      }}
                      onClick={(e: MouseEvent<HTMLButtonElement>) => openSlotDetails(ds, slotIdx, e.currentTarget)}
                      className={`flex min-h-10 items-center justify-between rounded-xl border px-3 text-left text-xs font-semibold transition ${
                        selected
                          ? "border-primary/40 bg-primary/[0.12] text-primary"
                          : 
                        active
                          ? CALENDAR_OPEN_SLOT_SOFT
                          : CALENDAR_INACTIVE_SLOT
                      }`}
                    >
                      <span>{formatAvailabilitySlotLabel(slotIdx)}</span>
                      <span>{selected ? "Selected" : active ? "Open" : ""}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>

      <div className="mt-4 flex flex-wrap gap-2">
        <Button type="button" variant="outline" className="rounded-full" onClick={clearCurrentWeek}>
          Clear this week
        </Button>
      </div>
    </Card>
  );

  return (
    <>
      <div className="grid gap-4 xl:grid-cols-[1.25fr_0.95fr]">
        {scheduleCard}
        {availabilityCard}
      </div>

      <Modal
        open={blockModalOpen}
        title="Create recurring availability block"
        onClose={() => {
          setBlockModalOpen(false);
          setDragSelection(null);
        }}
        footer={
          <ModalFooter>
            <Button
              type="button"
              variant="primary"
              className="rounded-full"
              onClick={applyRecurringBlock}
              disabled={blockWeekdays.length === 0 || blockEndSlotExclusive <= blockStartSlot}
            >
              Create block
            </Button>
          </ModalFooter>
        }
      >
        <div className="space-y-5">
          <div className="rounded-2xl border border-border bg-accent/30 px-4 py-3 text-sm text-muted">{blockSummary}</div>

          <div className="space-y-2">
            <p className="text-sm font-semibold text-foreground">Days of week</p>
            <div className="flex flex-wrap gap-2">
              {WEEKDAY_OPTIONS.map((option) => {
                const active = blockWeekdays.includes(option.value);
                return (
                  <button
                    key={option.value}
                    type="button"
                    onClick={() => toggleBlockWeekday(option.value)}
                    className={`rounded-full border px-3 py-2 text-sm font-semibold transition ${
                      active
                        ? "border-primary bg-primary text-white"
                        : "border-border bg-card text-muted hover:border-primary/30 hover:text-primary"
                    }`}
                  >
                    {option.label}
                  </button>
                );
              })}
            </div>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <label className="text-sm font-semibold text-foreground">Start time</label>
              <NativeSelect
                value={String(blockStartSlot)}
                onChange={(e) => {
                  const nextStart = Number.parseInt(e.target.value, 10);
                  if (!Number.isFinite(nextStart)) return;
                  setBlockStartSlot(nextStart);
                  setBlockEndSlotExclusive((current) => (current <= nextStart ? Math.min(SLOTS_PER_DAY, nextStart + 1) : current));
                }}
              >
                {slotRowIndices.map((slot) => (
                  <option key={`block-start-${slot}`} value={slot}>
                    {formatAvailabilitySlotLabel(slot)}
                  </option>
                ))}
              </NativeSelect>
            </div>
            <div className="space-y-2">
              <label className="text-sm font-semibold text-foreground">End time</label>
              <NativeSelect
                value={String(blockEndSlotExclusive)}
                onChange={(e) => {
                  const nextEnd = Number.parseInt(e.target.value, 10);
                  if (!Number.isFinite(nextEnd)) return;
                  setBlockEndSlotExclusive(nextEnd);
                  setBlockStartSlot((current) => (current >= nextEnd ? Math.max(0, nextEnd - 1) : current));
                }}
              >
                {slotRowIndices
                  .map((slot) => slot + 1)
                  .filter((slot) => slot > blockStartSlot && slot <= SLOTS_PER_DAY)
                  .map((slot) => (
                    <option key={`block-end-${slot}`} value={slot}>
                      {formatSlotEndLabel(slot)}
                    </option>
                  ))}
              </NativeSelect>
            </div>
          </div>

          <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_140px]">
            <div className="space-y-2">
              <label className="text-sm font-semibold text-foreground">Repeat</label>
              <NativeSelect value={blockCadence} onChange={(e) => setBlockCadence(e.target.value as RecurrenceCadence)}>
                <option value="once">Once</option>
                <option value="weekly">Weekly</option>
                <option value="biweekly">Biweekly</option>
                <option value="monthly">Monthly</option>
              </NativeSelect>
            </div>
            <div className="space-y-2">
              <label className="text-sm font-semibold text-foreground">Occurrences</label>
              <Input
                type="number"
                min={1}
                max={24}
                value={String(blockCadence === "once" ? 1 : blockOccurrences)}
                onChange={(e) => setBlockOccurrences(Math.max(1, Math.min(24, Number.parseInt(e.target.value, 10) || 1)))}
                disabled={blockCadence === "once"}
              />
            </div>
          </div>

        </div>
      </Modal>
      {selectedBlockModal}
      {tourGuestNotifyPreviewModal}
      {guestMessageModal}
    </>
  );
}
