"use client";

import {
  Fragment,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
} from "react";
import { createPortal } from "react-dom";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input, Select } from "@/components/ui/input";
import { CheckboxMultiSelect, FieldSingleSelect } from "@/components/ui/checkbox-multi-select";
import {
  AVAILABILITY_KINDS,
  AVAILABILITY_KIND_LABELS,
  type AvailabilityKind,
} from "@/lib/manager-availability-kinds";
import { mergeOpenRuns, formatOpenRunKindsLabel, type OpenRun } from "@/lib/calendar-open-runs";
import { Modal, ModalFooter } from "@/components/ui/modal";
import { CalendarClock, Mail, Plus, X } from "lucide-react";
import { PortalIconAction, PortalPrimaryIconAction } from "@/components/portal/portal-icon-action";
import { ConfirmRows, PortalDialog, type PortalDialogAction } from "@/components/portal/portal-dialog";
import { PortalFormSingleSelect } from "@/components/portal/filter-field-lists";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { PortalNotificationPreviewModal, type NotificationConfirmDraft } from "@/components/portal/portal-notification-preview-modal";
import { TourReminderTourPanel } from "@/components/portal/tour-reminder-tour-panel";
import { PORTAL_CALENDAR_FRAME, PortalSegmentedControl } from "./portal-metrics";
import { useAppUi } from "@/components/providers/app-ui-provider";
import { useManagerUserId } from "@/hooks/use-manager-user-id";
import { useWorkAssignmentDirectory } from "@/hooks/use-work-assignment-directory";
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
  addExplicitTourSlotKeys,
  defaultTourSlotExclusionKey,
  partitionTourAvailabilityStoredKeys,
  resolveDefaultTourAvailabilityConfig,
  resolveTourOfferingSlots,
  slotIsBookable,
  type DefaultTourAvailabilityConfig,
} from "@/lib/tour-slot-math";
import { cn } from "@/lib/utils";
import {
  type CoManagerAvailabilityOverlay,
  type ScheduledTourFilter,
} from "@/lib/co-manager-calendar";
import { buildScheduledTourMeetings } from "@/lib/manager-calendar-tour-meetings";
import {
  calendarMeetingSupportsDelete,
  googleBusyBlockStatusLabel,
  isGoogleCalendarPrivateBlock,
  isPropPlaneGoogleTourMeeting,
  meetingCalendarGridLabel,
  meetingCalendarGridTooltip,
  scheduledCalendarMeetings,
} from "@/lib/google-calendar/meetings";
import { deleteProplaneGoogleTourFromServer } from "@/lib/google-calendar/delete-tour.client";
import {
  cancelPlannedTourFromServer,
  deletePlannedTourFromServer,
  tourGuestNotificationFailed,
  tourGuestNotificationSummary,
} from "@/lib/tour-planned-change.client";
import {
  createScheduledWorkTask,
  scheduledTaskTitleForTour,
} from "@/lib/manager-scheduled-work-tasks";
import { ManagerTaskFormModal } from "@/components/portal/pro-task-form-modal";
import { deleteManagerTask } from "@/lib/manager-tasks";
import {
  compactTaskPropertyLabel,
  compactTaskRoomLabel,
  taskNotesPreview,
} from "@/lib/manager-task-display";
export type CalendarMode = "day" | "week" | "month";
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

const BLOCK_MODAL_LABEL_CLASS = "text-xs font-semibold text-foreground";
const BLOCK_MODAL_FIELD_CLASS = "min-h-9 rounded-xl px-3 py-1.5 text-sm";
const BLOCK_MODAL_SUMMARY_CLASS =
  "rounded-xl border border-border bg-accent/30 px-3 py-2 text-xs leading-snug text-muted";
const BLOCK_MODAL_DAY_BTN_BASE =
  "rounded-full border px-2.5 py-1.5 text-xs font-semibold transition";
const BLOCK_MODAL_DAY_BTN_ACTIVE = "border-primary bg-primary text-white";
const BLOCK_MODAL_DAY_BTN_INACTIVE =
  "border-border bg-card text-muted hover:border-primary/30 hover:text-primary [html[data-theme=dark]_&]:portal-calendar-inactive-slot";

function BlockOccurrencesInput({
  cadence,
  value,
  draft,
  onDraftChange,
  onCommit,
}: {
  cadence: RecurrenceCadence;
  value: number;
  draft: string | null;
  onDraftChange: (draft: string | null) => void;
  onCommit: (next: number) => void;
}) {
  const disabled = cadence === "once";
  const displayValue = disabled ? "1" : draft !== null ? draft : String(value);

  return (
    <Input
      type="text"
      inputMode="numeric"
      pattern="[0-9]*"
      className={BLOCK_MODAL_FIELD_CLASS}
      value={displayValue}
      disabled={disabled}
      aria-label="Occurrences"
      onChange={(e) => {
        const raw = e.target.value.replace(/\D/g, "");
        if (raw === "") {
          onDraftChange("");
          return;
        }
        onDraftChange(null);
        const parsed = Number.parseInt(raw, 10);
        if (Number.isFinite(parsed)) {
          onCommit(Math.max(1, Math.min(24, parsed)));
        }
      }}
      onBlur={() => {
        if (draft === "") {
          onDraftChange(null);
          return;
        }
        if (draft !== null) {
          const parsed = Number.parseInt(draft, 10);
          onCommit(Math.max(1, Math.min(24, Number.isFinite(parsed) ? parsed : value)));
          onDraftChange(null);
        }
      }}
    />
  );
}

type RecurringBlockModalFormFieldsProps = {
  blockSummary: string;
  blockWeekdays: number[];
  toggleBlockWeekday: (weekday: number) => void;
  blockStartSlot: number;
  setBlockStartSlot: (slot: number) => void;
  blockEndSlotExclusive: number;
  setBlockEndSlotExclusive: Dispatch<SetStateAction<number>>;
  blockCadence: RecurrenceCadence;
  setBlockCadence: (cadence: RecurrenceCadence) => void;
  blockOccurrences: number;
  setBlockOccurrences: (count: number) => void;
  blockOccurrencesDraft: string | null;
  setBlockOccurrencesDraft: (draft: string | null) => void;
  slotRowIndices: number[];
  /** Manager calendar only (`availabilityKeysByKind` supplied) — admin/vendor never see "Applies to". */
  showAppliesTo: boolean;
  blockKinds: AvailabilityKind[];
  setBlockKinds: (next: AvailabilityKind[]) => void;
};

function RecurringBlockModalFormFields({
  blockSummary,
  blockWeekdays,
  toggleBlockWeekday,
  blockStartSlot,
  setBlockStartSlot,
  blockEndSlotExclusive,
  setBlockEndSlotExclusive,
  blockCadence,
  setBlockCadence,
  blockOccurrences,
  setBlockOccurrences,
  blockOccurrencesDraft,
  setBlockOccurrencesDraft,
  slotRowIndices,
  showAppliesTo,
  blockKinds,
  setBlockKinds,
}: RecurringBlockModalFormFieldsProps) {
  return (
    <div className="space-y-4">
      <div className={BLOCK_MODAL_SUMMARY_CLASS}>{blockSummary}</div>

      {showAppliesTo ? (
        <div className="space-y-1.5">
          <p className={BLOCK_MODAL_LABEL_CLASS}>Applies to</p>
          <CheckboxMultiSelect
            label="Applies to"
            hideLabel
            options={AVAILABILITY_KINDS.map((kind) => ({ value: kind, label: AVAILABILITY_KIND_LABELS[kind] }))}
            selected={blockKinds}
            onChange={(next) => setBlockKinds(next as AvailabilityKind[])}
            dataAttr="calendar-block-applies-to"
            className="w-full sm:w-64"
          />
        </div>
      ) : null}

      <div className="space-y-1.5">
        <CheckboxMultiSelect
          label="Days of week"
          labelClassName={BLOCK_MODAL_LABEL_CLASS}
          options={WEEKDAY_OPTIONS.map((option) => ({ value: String(option.value), label: option.label }))}
          selected={blockWeekdays.map(String)}
          onChange={(next) => {
            const values = next
              .map((value) => Number.parseInt(value, 10))
              .filter((value) => Number.isFinite(value));
            for (const option of WEEKDAY_OPTIONS) {
              const has = values.includes(option.value);
              const already = blockWeekdays.includes(option.value);
              if (has !== already) toggleBlockWeekday(option.value);
            }
          }}
          emptyLabel="Select days…"
          dataAttr="calendar-block-days"
          className="w-full sm:w-64"
        />
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <label className={BLOCK_MODAL_LABEL_CLASS}>Start time</label>
          <Select
            className={BLOCK_MODAL_FIELD_CLASS}
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
          </Select>
        </div>
        <div className="space-y-1.5">
          <label className={BLOCK_MODAL_LABEL_CLASS}>End time</label>
          <Select
            className={BLOCK_MODAL_FIELD_CLASS}
            value={String(blockEndSlotExclusive)}
            onChange={(e) => {
              const nextEnd = Number.parseInt(e.target.value, 10);
              if (!Number.isFinite(nextEnd)) return;
              setBlockEndSlotExclusive(nextEnd);
              if (blockStartSlot >= nextEnd) {
                setBlockStartSlot(Math.max(0, nextEnd - 1));
              }
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
          </Select>
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_96px]">
        <div className="space-y-1.5">
          <label className={BLOCK_MODAL_LABEL_CLASS}>Repeat</label>
          <Select
            className={BLOCK_MODAL_FIELD_CLASS}
            value={blockCadence}
            onChange={(e) => setBlockCadence(e.target.value as RecurrenceCadence)}
          >
            <option value="once">Once</option>
            <option value="weekly">Weekly</option>
            <option value="biweekly">Biweekly</option>
            <option value="monthly">Monthly</option>
          </Select>
        </div>
        <div className="space-y-1.5">
          <label className={BLOCK_MODAL_LABEL_CLASS}>Occurrences</label>
          <BlockOccurrencesInput
            cadence={blockCadence}
            value={blockOccurrences}
            draft={blockOccurrencesDraft}
            onDraftChange={setBlockOccurrencesDraft}
            onCommit={setBlockOccurrences}
          />
        </div>
      </div>
    </div>
  );
}

const CALENDAR_HEADER_CELL =
  "bg-accent/30 font-bold uppercase tracking-[0.12em] text-muted [html[data-theme=dark]_&]:portal-calendar-header-cell";
/**
 * The day/date row pins directly under the week toolbar.
 *
 * Both live in the SAME scroll container when `flowScroll` is on, and the
 * toolbar is already `sticky; top: 0`. `--portal-calendar-header-top` is the
 * measured toolbar height so `CALENDAR_WEEK_DAY_STRIP` can stick flush under it.
 */
const CALENDAR_WEEK_DAY_STRIP =
  "portal-calendar-week-days-header sticky z-[14] top-[var(--portal-calendar-header-top,0px)] border-b border-border/60 bg-card shadow-sm";
const CALENDAR_TIME_CELL =
  "whitespace-nowrap text-[10px] font-semibold tabular-nums text-muted sm:text-[11px] [html[data-theme=dark]_&]:portal-calendar-time-cell";
const CALENDAR_GRID_GAP = "gap-px bg-accent/40 [html[data-theme=dark]_&]:portal-calendar-grid";
// Open availability is the quiet layer of the week — a faint tint with a soft
// ring, the way Google Calendar draws free time — so the booked tours on top
// of it are what the eye lands on. Forty solid green blocks were a wall.
// (Kept only for the dead, pre-compact `viewMode` render path below — every
// live caller passes `compactAvailability`, which uses `CALENDAR_OPEN_RUN_TINTS`.)
const CALENDAR_OPEN_SLOT_SOFT =
  "border-emerald-200 bg-emerald-50 text-emerald-800 [html[data-theme=dark]_&]:portal-calendar-open-slot";
/**
 * Tint an open run by kind (PLAN-0914-1710 §1), split into fill + border
 * instead of one `ring-1 ring-inset` class. A ring sits inside every cell's
 * own edges, so two adjacent cells of the same run would each draw a full
 * ring and the seam between them would still read as a divider. Borders are
 * dropped per-edge inline in `renderSlotButton` (no `border-t` between
 * cells, `border-t`/`rounded-t-lg` only on the first, `border-b`/`rounded-b-lg`
 * only on the last) so only the run's OUTER edge draws a line and interior
 * cells butt seamlessly. Services and tasks reuse existing theme-aware CSS
 * variables (`--pl-accent-soft`, `--status-pending-*`) instead of new
 * hard-coded colors, so dark mode is correct without touching globals.css.
 */
const CALENDAR_OPEN_RUN_TINTS: Record<AvailabilityKind, { fill: string; border: string }> = {
  tours: {
    fill: "bg-emerald-50 text-emerald-700/80 hover:bg-emerald-100/80 [html[data-theme=dark]_&]:portal-calendar-open-slot",
    border: "border-emerald-200/80",
  },
  services: {
    fill: "bg-[var(--pl-accent-soft)] text-primary hover:brightness-95",
    border: "border-primary/25",
  },
  tasks: {
    fill: "bg-[var(--status-pending-bg)] text-[var(--status-pending-fg)] hover:brightness-95",
    border: "border-[var(--status-pending-fg)]/25",
  },
};
/**
 * Default-open run styling — the dashed, lower-contrast cousin of painted
 * tours. Deliberately lower-contrast: it IS live to prospects (so it must not
 * read as empty), but it is not a deliberate choice the manager made (so it
 * must not read the same as painted availability).
 */
const CALENDAR_DEFAULT_OPEN_RUN_TINT = {
  fill: "bg-emerald-50/60 text-emerald-700/70 hover:bg-emerald-100/80 [html[data-theme=dark]_&]:portal-calendar-open-slot",
  border: "border-dashed border-emerald-200/80",
};
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
/** Toolbar default-hours pickers — same field-select chrome as property forms (rounded-2xl, portaled menu). */
const CALENDAR_TIME_FIELD_SELECT_TRIGGER =
  "min-h-9 rounded-2xl border border-border bg-auth-input-bg px-3 text-xs font-semibold text-foreground shadow-[0_1px_2px_rgba(15,23,42,0.03)] hover:border-primary/25 focus:border-primary/40 focus:ring-4 focus:ring-primary/10 sm:min-h-10 sm:text-sm";
/** Compact tour-calendar toolbar — fits beside week nav on phones. */
const CALENDAR_COMPACT_TIME_FIELD_SELECT_TRIGGER =
  "h-6 min-h-6 min-w-0 rounded-md border border-border bg-auth-input-bg px-1 text-[8px] font-semibold leading-none text-foreground shadow-none hover:border-primary/25 focus:border-primary/40 focus:ring-2 focus:ring-primary/10 max-lg:[&_svg]:h-2.5 max-lg:[&_svg]:w-2.5 max-lg:[&_svg]:opacity-70 sm:h-8 sm:min-h-8 sm:rounded-lg sm:px-2.5 sm:text-xs lg:[&_svg]:h-3.5 lg:[&_svg]:w-3.5";
const CALENDAR_COMPACT_TOOLBAR_TEXT = "text-[10px] font-semibold leading-none";
const CALENDAR_COMPACT_TIME_SELECT_WRAP =
  // `flex-1` so the pair still fills a phone toolbar; the cap stops them from
  // stretching to half the width each on a tablet-width panel.
  "min-w-0 flex-1 max-w-[7.5rem] [&_svg]:right-1 [&_svg]:h-2.5 [&_svg]:w-2.5 [&_svg]:opacity-70";
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

/** Calendar navigation is noon-anchored so DST cannot skip a local date. */
export function shiftCalendarAnchor(anchor: Date, mode: CalendarMode, direction: -1 | 1): Date {
  if (mode === "month") return addMonths(anchor, direction);
  return addDays(anchor, mode === "week" ? direction * 7 : direction);
}

/** A fresh value prevents a mutating Date caller from changing the clock anchor. */
export function calendarTodayAnchor(today: Date): Date {
  return new Date(today);
}

export function calendarVisibleDateCount(mode: CalendarMode, anchor: Date): number {
  if (mode === "day") return 1;
  if (mode === "week") return 7;
  return buildMonthCells(anchor.getFullYear(), anchor.getMonth()).filter(Boolean).length;
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

/** Narrow toolbar label — omits the year so week nav fits beside controls on phones. */
function formatWeekRangeMonSunShort(monday: Date): string {
  const sunday = addDays(monday, 6);
  const opts: Intl.DateTimeFormatOptions = { month: "short", day: "numeric" };
  return `${monday.toLocaleDateString(undefined, opts)}–${sunday.toLocaleDateString(undefined, opts)}`;
}

/** Ultra-compact week label for property tour toolbar on phones (e.g. 8/31–9/6). */
function formatWeekRangeMonSunNumeric(monday: Date): string {
  const sunday = addDays(monday, 6);
  return `${monday.getMonth() + 1}/${monday.getDate()}–${sunday.getMonth() + 1}/${sunday.getDate()}`;
}

function unionAvailabilityForStorageKeys(keys: string[]): Set<string> {
  const union = new Set<string>();
  for (const key of keys) {
    for (const slot of readAvailabilityDateSetForStorageKey(key)) union.add(slot);
  }
  return union;
}

/** Per-kind version of {@link unionAvailabilityForStorageKeys} — one Set per kind that has keys. */
function unionAvailabilityByKind(
  map: Partial<Record<AvailabilityKind, string[]>>,
): Partial<Record<AvailabilityKind, Set<string>>> {
  const out: Partial<Record<AvailabilityKind, Set<string>>> = {};
  for (const kind of AVAILABILITY_KINDS) {
    const keys = map[kind];
    if (!keys?.length) continue;
    out[kind] = unionAvailabilityForStorageKeys(keys);
  }
  return out;
}

/** Union across every kind's slot set — the "is this painted at all" view every existing consumer wants. */
function unionOfKindSlots(byKind: Partial<Record<AvailabilityKind, Set<string>>>): Set<string> {
  const union = new Set<string>();
  for (const kind of AVAILABILITY_KINDS) {
    const slots = byKind[kind];
    if (!slots) continue;
    for (const key of slots) union.add(key);
  }
  return union;
}

/** A merged open run, plus whether it is the implicit 9-5 default rather than something painted. */
type CalendarOpenRun = OpenRun & { isDefault?: boolean };

/** "6-8 am" / "6-6:30 am" — drops the repeated meridiem when start and end share one. */
function formatOpenRunTimeRangeLabel(startSlot: number, endSlotExclusive: number): string {
  const start = formatAvailabilitySlotLabel(startSlot);
  const end = formatSlotEndLabel(endSlotExclusive);
  const startMeridiem = start.slice(-2);
  const endMeridiem = end.slice(-2);
  return startMeridiem === endMeridiem ? `${start.slice(0, -3)}–${end}` : `${start}–${end}`;
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
  // "task" arrived with manager tasks, which are planned events like any other; without it here
  // the meeting builder cannot pass a PlannedEvent straight through.
  kind?: "partner" | "tour" | "service" | "task";
  /** Present on manager task blocks — links back to the task list row. */
  sourceTaskId?: string;
  hostLabel?: string;
  isPeerTour?: boolean;
  /**
   * Personal Google Calendar busy time. `title` is the event's own summary and
   * is shown ONLY to the manager whose calendar it is (the events route answers
   * for the signed-in account alone); no attendees or description are carried.
   */
  googleCalendarPrivate?: boolean;
  /** Google `eventType` metadata rows (working location, birthday) — never paint or block. */
  googleCalendarInformational?: boolean;
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

const EVENT_DURATION_SELECT_OPTIONS = [
  ...EVENT_DURATION_PRESET_MINUTES.map((minutes) => ({
    value: String(minutes),
    label: `${minutes} min`,
  })),
  { value: "custom", label: "Custom" },
];

/**
 * Footer + Message chrome for a calendar event (PLAN-0922-1013). One secondary
 * + one primary, or no footer on a browse-only visit. Message is a header icon.
 */
export function calendarEventDialogActions(meeting: DemoMeeting): {
  title: string;
  primaryLabel: string | null;
  primaryDataAttr?: string;
  secondaryLabel: string | null;
  secondaryDataAttr?: string;
  showMessage: boolean;
  messageLabel: string;
} {
  const isConfirmedTour = meeting.kind === "tour" && meeting.source === "planned";
  const isManagerTask = meeting.kind === "task" && Boolean(meeting.sourceTaskId);
  const isGuestFacingTour = meeting.kind === "tour";
  const canDelete = calendarMeetingSupportsDelete(meeting);
  const secondaryLabel = !canDelete
    ? null
    : isManagerTask
      ? "Delete task"
      : meeting.source === "planned" || isPropPlaneGoogleTourMeeting(meeting)
        ? "Delete event"
        : meeting.kind === "tour"
          ? "Delete tour"
          : "Delete request";
  let primaryLabel: string | null = !canDelete
    ? null
    : isManagerTask
      ? "Edit task"
      : isConfirmedTour
        ? "Cancel tour"
        : meeting.source === "inquiry"
          ? meeting.kind === "tour"
            ? "Confirm tour"
            : "Approve"
          : null;
  // A deletable personal event has no other commit — Delete is the primary so
  // the footer exists (visit / service stays footer-less).
  let resolvedSecondary = secondaryLabel;
  if (canDelete && !primaryLabel && secondaryLabel) {
    primaryLabel = secondaryLabel;
    resolvedSecondary = null;
  }
  return {
    title: isGoogleCalendarPrivateBlock(meeting) ? meetingCalendarGridLabel(meeting) : meeting.title,
    primaryLabel,
    primaryDataAttr: isManagerTask
      ? "calendar-task-edit"
      : isConfirmedTour
        ? "tour-cancel-open"
        : undefined,
    secondaryLabel: resolvedSecondary,
    secondaryDataAttr: canDelete && resolvedSecondary ? "tour-delete-open" : undefined,
    showMessage: Boolean(meeting.email?.trim()),
    messageLabel: isConfirmedTour || isGuestFacingTour ? "Message resident" : "Message",
  };
}

/**
 * Whether a meeting paints a grid cell. Informational Google metadata must not
 * render as grey "Blocked" — that was the linked-calendar "everything blocked"
 * regression while day headers still read "0 EVENTS". Free and declined events
 * still draw (labelled "Free") so the manager can see them.
 */
export function meetingPaintsCalendarGrid(meeting: DemoMeeting): boolean {
  if (!isGoogleCalendarPrivateBlock(meeting)) return true;
  return !meeting.googleCalendarInformational;
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
  | {
      kind: "availability";
      dateStr: string;
      startSlot: number;
      endSlotExclusive: number;
      kinds: AvailabilityKind[];
      /** The implicit 9-5 default window rather than something painted — removed via `removeDefaultSlot`, always kind "tours". */
      isDefault?: boolean;
    }
  | { kind: "meeting"; meeting: DemoMeeting };

/** The availability variant of a block selection — what the edit dialog acts on. */
type AvailabilityBlockSelection = Extract<CalendarBlockSelection, { kind: "availability" }>;

const slotRowIndices = Array.from({ length: SLOT_ROW_END - SLOT_ROW_START + 1 }, (_, i) => SLOT_ROW_START + i);
/** Stable empty-Set identity — avoids a fresh object on every render for the `?? EMPTY_STRING_SET` fallback. */
const EMPTY_STRING_SET: Set<string> = new Set();

/**
 * End labels are EXCLUSIVE: slot 48 is midnight, the end of the day. Borrowing
 * the start formatter printed it as "12 pm" — the SAME label noon already
 * carries — so the end picker offered "12 pm" twice and picking the lower one
 * set the window to midnight. The grid then ran to 11:30 pm and the modal
 * scrolled far past any hour a tour is booked in. ("12 am", not "midnight":
 * the picker trigger is sized for "10:30 pm" and truncates a longer word.)
 */
function formatSlotEndLabel(slotIndexExclusive: number): string {
  if (slotIndexExclusive >= SLOTS_PER_DAY) return "12 am";
  return formatAvailabilitySlotLabel(slotIndexExclusive);
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
    skipMessageLabel: string;
    confirmLabel: string;
    confirmLabelWithoutMessage: string;
    confirmBusyLabel: string;
  }
> = {
  confirm: {
    title: "Confirm tour",
    skipMessageLabel: "Don't message guest",
    confirmLabel: "Confirm tour & send notification",
    confirmLabelWithoutMessage: "Confirm tour only",
    confirmBusyLabel: "Confirming…",
  },
  delete: {
    title: "Delete tour",
    skipMessageLabel: "Don't message guest",
    confirmLabel: "Delete tour & send notification",
    confirmLabelWithoutMessage: "Delete tour only",
    confirmBusyLabel: "Deleting…",
  },
  cancel: {
    title: "Cancel tour",
    skipMessageLabel: "Don't message guest",
    confirmLabel: "Cancel tour & send notification",
    confirmLabelWithoutMessage: "Cancel tour only",
    confirmBusyLabel: "Cancelling…",
  },
  "delete-confirmed": {
    title: "Delete tour",
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
  /**
   * Manager calendar only: read/write availability per kind instead of one
   * union. Absent means EXACTLY today's behaviour (admin, vendor, and
   * co-manager callers never pass this) — `availabilityStorageKeys` is
   * treated as the tours keys.
   */
  availabilityKeysByKind,
  /** Which kind drag-painting, the block modal's default, and the toolbar target. */
  editKind = "tours",
  calendarRefreshSignal,
  defaultViewMode = "week",
  viewMode: controlledViewMode,
  pinMonthSchedule = false,
  tourScopeLabel,
  unavailableMessage = "Sign in to manage your availability.",
  compactAvailability = false,
  otherProperties,
  onCopyWeekToHouses,
  scheduledTourFilter,
  scheduledMeetingFilter,
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
  inlineFooter: _inlineFooter = false,
  /**
   * Scroll with the parent page instead of a nested grid viewport (property detail
   * tab). Keeps the week toolbar sticky inside that one scroll surface.
   */
  flowScroll = false,
  /**
   * Fill a modal body (`scrollableContent={false}`) — grid scrolls inside the panel
   * while the week toolbar stays pinned.
   */
  embeddedInModal = false,
  /**
   * @deprecated Week actions live on the toolbar (PLAN-0916-1034). Kept so callers
   * that still pass a modal footer slot just get `null`.
   */
  delegateFooterToModal: _delegateFooterToModal = false,
  onModalFooterChange,
  defaultTourAvailability,
  editableDefaultTourHours = false,
  onDefaultTourHoursChange,
  onDefaultTourGridEnabledChange,
  weekActionsHost,
  weekPrimaryActionHost,
  extraAvailabilityAction,
  vendorViewer = false,
  hideViewModeControl = false,
  onVendorAvailabilityEdit,
}: {
  storageKey: string | null;
  availabilityStorageKeys?: string[];
  availabilityKeysByKind?: Partial<Record<AvailabilityKind, string[]>>;
  editKind?: AvailabilityKind;
  calendarRefreshSignal?: number;
  defaultViewMode?: CalendarMode;
  /** Route-owned calendar mode. When provided, navigation updates this panel without remounting it. */
  viewMode?: CalendarMode;
  pinMonthSchedule?: boolean;
  tourScopeLabel?: string;
  unavailableMessage?: string;
  compactAvailability?: boolean;
  bareSurface?: boolean;
  /** @deprecated Week actions are toolbar icons. Kept so existing callers type-check. */
  inlineFooter?: boolean;
  flowScroll?: boolean;
  embeddedInModal?: boolean;
  delegateFooterToModal?: boolean;
  onModalFooterChange?: (footer: ReactNode | null) => void;
  /** Manager default 9–5 (or customized in Calendar settings) when no week is published. */
  defaultTourAvailability?: DefaultTourAvailabilityConfig;
  /** When true and nothing is painted, toolbar hours update the default tour window. */
  editableDefaultTourHours?: boolean;
  onDefaultTourHoursChange?: (startSlot: number, endSlotExclusive: number) => void;
  onDefaultTourGridEnabledChange?: (enabled: boolean) => void;
  /** Command-bar host for the "Availability" utility icon (copy / clear / house actions). */
  weekActionsHost?: HTMLElement | null;
  /** Command-bar host for the standalone "+" (Add availability) primary icon — rendered after Share, per the one Filter · Availability · Share · + band shape. */
  weekPrimaryActionHost?: HTMLElement | null;
  /** An extra row folded into the Availability menu (Connect Google Calendar) so the band never grows past four icons. */
  extraAvailabilityAction?: ReactNode;
  /**
   * Vendor calendar: skip the manager assignment directory (403 on
   * `/api/portal-vendors`) without turning on Flexible / Add work. Those
   * still key off `vendorDayFlexibility`.
   */
  vendorViewer?: boolean;
  /** The portal route owns mode navigation, so do not render a second picker. */
  hideViewModeControl?: boolean;
  /** Vendor edits are delegated to the canonical vendor-availability editor. */
  onVendorAvailabilityEdit?: (dateStr: string, slotIdx?: number) => void;
  otherProperties?: { id: string; name: string }[];
  onCopyWeekToHouses?: (propertyIds: string[], weekDateStrs: string[], scope: "week" | "entire") => void;
  scheduledTourFilter?: ScheduledTourFilter;
  /**
   * Keeps only the planned meetings a calendar view wants — the Tours tab drops
   * tasks, the Tasks tab drops tours (PLAN-0914-1710). Runs after the meetings
   * are built so counts and the grid read the same list.
   */
  scheduledMeetingFilter?: (meeting: DemoMeeting) => boolean;
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
  const { userId } = useManagerUserId();

  /**
   * Publish the sticky week toolbar's height so the day/date row can pin
   * directly under it (`CALENDAR_WEEK_DAY_STRIP`). Measured rather than
   * hard-coded: the toolbar grows a second row on narrow panels and when the
   * time-range selects wrap, and a stale constant there puts the dates back
   * under the toolbar — the exact bug this fixes.
   */
  /**
   * `flowScroll` means "the toolbar and grid share the PAGE's one scroll
   * container" — which is only ever true on a page. Its CSS
   * (`.portal-calendar-flow-scroll`) is scoped under `.portal-list-page-scroll`,
   * so inside a modal none of it applies and the grid must fall back to the
   * ordinary bounded-body layout. Every flowScroll decision reads this one flag
   * so the classes and the sticky-header offset can never disagree.
   */
  const pageFlowScroll = flowScroll && !embeddedInModal;
  const compactShellRef = useRef<HTMLDivElement | null>(null);
  const compactToolbarRef = useRef<HTMLDivElement | null>(null);
  useLayoutEffect(() => {
    const shell = compactShellRef.current;
    const toolbar = compactToolbarRef.current;
    if (!shell || !toolbar) return;
    const publish = () => {
      // ONLY in flowScroll. There, the toolbar and the grid share the page's
      // one scroll container, so a header row stuck at 0 would slide under the
      // toolbar and the offset is what keeps it clear. Everywhere else the grid
      // scrolls inside its own body while the toolbar sits OUTSIDE that
      // scroller — nothing to clear — and offsetting anyway pushed the day row
      // down by a toolbar's height, leaving a blank band under the week nav and
      // the time gutter colliding with the dates.
      shell.style.setProperty(
        "--portal-calendar-header-top",
        pageFlowScroll ? `${Math.round(toolbar.offsetHeight)}px` : "0px",
      );
    };
    publish();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(publish);
    observer.observe(toolbar);
    return () => observer.disconnect();
  });
  useEffect(() => {
    onModalFooterChange?.(null);
    return () => onModalFooterChange?.(null);
  }, [onModalFooterChange]);
  // This calendar renders in the VENDOR portal too, where the assignment
  // directory (the manager's team + vendor list) is not the viewer's to read —
  // /api/portal-vendors answers 403 by design. `vendorViewer` is the flag the
  // vendor calendar passes once Flexible / Add work are gone; `vendorDayFlexibility`
  // still means the old vendor-only chrome.
  const isVendorViewer = vendorViewer || Boolean(vendorDayFlexibility);
  const { teamMembers, vendors } = useWorkAssignmentDirectory({
    managerUserId: userId,
    enabled: !isVendorViewer,
  });
  const writeStorageKeys = useMemo(() => {
    if (availabilityStorageKeys?.length) return availabilityStorageKeys;
    return storageKey ? [storageKey] : [];
  }, [availabilityStorageKeys, storageKey]);
  /**
   * Per-kind read/write keys. Absent `availabilityKeysByKind` (admin, vendor,
   * co-manager) falls back to treating `writeStorageKeys` as the tours keys —
   * EXACTLY today's single-union behaviour.
   */
  const kindKeysMap = useMemo<Partial<Record<AvailabilityKind, string[]>>>(() => {
    if (availabilityKeysByKind) return availabilityKeysByKind;
    return writeStorageKeys.length > 0 ? { tours: writeStorageKeys } : {};
  }, [availabilityKeysByKind, writeStorageKeys]);
  // A vendor supplies a storage key solely as a paint cache of canonical
  // `/api/vendor/availability` rules. It is never a legacy schedule-record
  // target, even though the manager calendar uses the same prop for writes.
  const hasEditableKeys = useMemo(
    () => !isVendorViewer && AVAILABILITY_KINDS.some((kind) => (kindKeysMap[kind]?.length ?? 0) > 0),
    [isVendorViewer, kindKeysMap],
  );
  const [uncontrolledViewMode, setViewMode] = useState<CalendarMode>(defaultViewMode);
  const viewMode = controlledViewMode ?? uncontrolledViewMode;
  const [monthPick, setMonthPick] = useState<{ start: string | null; end: string | null }>({ start: null, end: null });
  const [uncontrolledAnchorDate, setUncontrolledAnchorDate] = useState(() => new Date());
  const anchorDate = anchorDateProp ?? uncontrolledAnchorDate;
  /**
   * Move the anchor date.
   *
   * The uncontrolled path MUST go through React's functional updater. It used to read
   * `uncontrolledAnchorDate` out of this closure and hand `setUncontrolledAnchorDate` a plain
   * value, which made every caller holding a stale copy of this callback navigate relative to
   * whatever the anchor was when that copy was made. `shiftAvailabilityWeek` memoizes with `[]`
   * deps, so it held the FIRST copy forever: with today Aug 21 (week Aug 17-23), `<` went to the
   * week of Aug 14 and `>` then went to the week of Aug 28 instead of back to Aug 17 — the
   * reported "next date does not go to the next date". Reading `prev` from React means a stale
   * copy is harmless because the previous value is supplied at apply time, not captured.
   */
  const setAnchorDate = useCallback(
    (updater: Date | ((prev: Date) => Date)) => {
      const apply = (prev: Date) => (typeof updater === "function" ? updater(prev) : updater);
      if (onAnchorDateChange) {
        // Controlled: the parent owns the value, so the current prop IS the previous value.
        onAnchorDateChange(apply(anchorDateProp ?? uncontrolledAnchorDate));
        return;
      }
      setUncontrolledAnchorDate(apply);
    },
    [anchorDateProp, onAnchorDateChange, uncontrolledAnchorDate],
  );
  const [activeSlotsByKind, setActiveSlotsByKind] = useState<Partial<Record<AvailabilityKind, Set<string>>>>(() =>
    unionAvailabilityByKind(kindKeysMap),
  );
  /** Union across every kind currently in view — every pre-Stage-B consumer wants this, not a single kind. */
  const activeSlots = useMemo(() => unionOfKindSlots(activeSlotsByKind), [activeSlotsByKind]);
  const resolvedDefaultTourAvailability = useMemo(
    () => resolveDefaultTourAvailabilityConfig(defaultTourAvailability),
    [defaultTourAvailability],
  );
  const publishedActiveSlots = useMemo(
    () => new Set(partitionTourAvailabilityStoredKeys([...activeSlots]).publishedSlots),
    [activeSlots],
  );
  const canEditDefaultTourHours =
    editableDefaultTourHours && Boolean(onDefaultTourHoursChange);
  /**
   * The 9-5 default and the public tour-booking offer are TOURS concepts only
   * (manager-availability-kinds.ts header) — reading the general per-kind
   * union here would let a painted Services slot masquerade as a bookable
   * tour window on the All view.
   */
  const toursActiveSlots = activeSlotsByKind.tours ?? EMPTY_STRING_SET;
  /**
   * `Date.now()` cannot be called during render, and the memo below never
   * recomputed as time passed anyway — time was not one of its dependencies, so
   * the value was already pinned until `activeSlots` or the default config
   * changed. Making that explicit keeps the behaviour identical and moves the
   * impure read into an effect.
   */
  const [offeringNow, setOfferingNow] = useState(() => Date.now());
  useEffect(() => {
    setOfferingNow(Date.now());
  }, [toursActiveSlots, resolvedDefaultTourAvailability]);
  /** Painted tour availability plus the 9-5 default on days with no published windows. */
  const offeredSlots = useMemo(
    () =>
      new Set(
        resolveTourOfferingSlots([...toursActiveSlots], offeringNow, resolvedDefaultTourAvailability).filter((slot) =>
          slotIsBookable(slot),
        ),
      ),
    [toursActiveSlots, offeringNow, resolvedDefaultTourAvailability],
  );
  /**
   * Windows a prospect can book that the manager never painted — the implicit
   * 9-5 default. These were invisible here while being live on the public
   * booking page, so a manager had no idea their calendar was open, let alone
   * which days. Shown as a distinct "default" state that can be removed.
   */
  /** Availability edits target every scoped house (filter empty = whole portfolio) — or the current kind's keys. */
  const canEditAvailability = !readOnly && hasEditableKeys;
  const defaultOnlySlots = useMemo(() => {
    const out = new Set<string>();
    for (const key of offeredSlots) {
      if (!publishedActiveSlots.has(key)) out.add(key);
    }
    return out;
  }, [offeredSlots, publishedActiveSlots]);

  const [dragSelection, setDragSelection] = useState<DragSelection | null>(null);
  // Mirrors dragSelection synchronously. mousedown and mouseup can land in the
  // same React batch on a fast click, so finishDragSelection would otherwise
  // read a stale `null` and the click would silently do nothing.
  const dragSelectionRef = useRef<DragSelection | null>(null);
  // Suppress the click on cells that just finished a multi-slot drag (modal path).
  const lastMultiDragRef = useRef<DragSelection | null>(null);
  const [mobileDayIndex, setMobileDayIndex] = useState(0);
  const [visibleStartSlot, setVisibleStartSlot] = useState(DEFAULT_VISIBLE_START_SLOT);
  const [visibleEndSlotExclusive, setVisibleEndSlotExclusive] = useState(DEFAULT_VISIBLE_END_SLOT_EXCLUSIVE);
  // Declared AFTER the two setters it calls. It used to sit ~40 lines above
  // them, which reads as a hoisting quirk rather than intent and stops the
  // compiler from tracking the dependency.
  useEffect(() => {
    if (!editableDefaultTourHours) return;
    setVisibleStartSlot(resolvedDefaultTourAvailability.startSlot);
    setVisibleEndSlotExclusive(resolvedDefaultTourAvailability.endSlotExclusive);
  }, [
    editableDefaultTourHours,
    resolvedDefaultTourAvailability.endSlotExclusive,
    resolvedDefaultTourAvailability.startSlot,
  ]);
  const [blockModalOpen, setBlockModalOpen] = useState(false);
  const [blockStartSlot, setBlockStartSlot] = useState(DEFAULT_VISIBLE_START_SLOT);
  const [blockEndSlotExclusive, setBlockEndSlotExclusive] = useState(DEFAULT_VISIBLE_START_SLOT + 2);
  const [blockWeekdays, setBlockWeekdays] = useState<number[]>([0, 1, 2, 3, 4]);
  /** "Applies to" — manager calendar only (`availabilityKeysByKind` supplied); defaults to `editKind`. */
  const [blockKinds, setBlockKinds] = useState<AvailabilityKind[]>([editKind]);
  const showAppliesTo = Boolean(availabilityKeysByKind);
  const [blockCadence, setBlockCadence] = useState<RecurrenceCadence>("weekly");
  const [blockOccurrences, setBlockOccurrences] = useState(4);
  const [blockOccurrencesDraft, setBlockOccurrencesDraft] = useState<string | null>(null);
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
  const [taskFormOpen, setTaskFormOpen] = useState(false);
  const [taskEditId, setTaskEditId] = useState<string | null>(null);
  const [taskNotesExpanded, setTaskNotesExpanded] = useState(false);

  useEffect(() => {
    if (!hasEditableKeys) return;
    let cancelled = false;
    const load = async () => {
      try {
        await syncScheduleRecordsFromServer();
      } catch {
        /* offline or dev server restart — calendar still renders */
      }
      if (!cancelled) {
        setActiveSlotsByKind(unionAvailabilityByKind(kindKeysMap));
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [hasEditableKeys, kindKeysMap]);

  // Poll every 60 s so approvals/cancellations from linked accounts propagate
  // automatically. Skip while the tab is hidden to avoid egress from background
  // tabs, and refresh once immediately when the tab becomes visible again.
  useEffect(() => {
    if (!hasEditableKeys) return;
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
  }, [hasEditableKeys]);

  const weekMonday = useMemo(() => startOfWeekMonday(anchorDate), [anchorDate]);
  const fullWeekDates = useMemo(() => [0, 1, 2, 3, 4, 5, 6].map((i) => addDays(weekMonday, i)), [weekMonday]);
  const fullWeekDateStrs = useMemo(() => fullWeekDates.map(toLocalDateStr), [fullWeekDates]);
  const activeBlockDates = fullWeekDates;
  const activeBlockDateStrs = fullWeekDateStrs;

  const meetings = useMemo<DemoMeeting[]>(() => {
    void calendarRefreshSignal;
    void meetingRefresh;
    // Vendor visits arrive through `externalMeetings`. Do not read the shared
    // manager schedule snapshot here: that snapshot is hydrated and refreshed
    // by the legacy schedule-records transport, which a vendor viewer neither
    // owns nor needs.
    const builtMeetings = isVendorViewer ? [] : buildScheduledTourMeetings(scheduledTourFilter, storageKey);
    const tourMeetings = scheduledMeetingFilter ? builtMeetings.filter(scheduledMeetingFilter) : builtMeetings;
    const linkedGoogleIds = new Set(
      (isVendorViewer ? [] : readPlannedEvents())
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
  }, [storageKey, calendarRefreshSignal, meetingRefresh, scheduledTourFilter, scheduledMeetingFilter, externalMeetings, isVendorViewer]);

  /**
   * Personal Google busy time is drawn as "Blocked", never as an event, and the
   * view tabs above this grid count only tours + service visits. Counting busy
   * blocks in the day header made it read "9 EVENTS" on Wednesday directly
   * under a tab reading "All 0" (F-CAL-1). The header counts the same set the
   * tabs do; the blocks stay visible in the grid, labelled Blocked.
   */
  const scheduledMeetings = useMemo(() => scheduledCalendarMeetings(meetings), [meetings]);
  const gridPaintedMeetings = useMemo(
    () => meetings.filter((meeting) => meetingPaintsCalendarGrid(meeting)),
    [meetings],
  );
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

  const refreshPaintedAvailability = useCallback(() => {
    setActiveSlotsByKind(unionAvailabilityByKind(kindKeysMap));
  }, [kindKeysMap]);

  const reloadAvailability = useCallback(() => {
    // A vendor cache is installed from canonical availability rules by the
    // parent. It still needs a local React refresh to paint those slots, but
    // must never enter the legacy server synchronization path.
    refreshPaintedAvailability();
    if (isVendorViewer || !hasEditableKeys) return;
    void syncScheduleRecordsFromServer({ force: true }).finally(() => {
      refreshPaintedAvailability();
    });
  }, [hasEditableKeys, isVendorViewer, refreshPaintedAvailability]);

  /** Writes to one kind's keys (defaults to `editKind` — the view's current target). */
  const mutateAvailability = useCallback(
    (mutate: (current: Set<string>) => Set<string>, kind: AvailabilityKind = editKind) => {
      if (isVendorViewer) return;
      const keys = kindKeysMap[kind];
      if (!keys?.length) return;
      setSaveStatus("saving");
      void Promise.all(
        keys.map((key) => {
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
          setActiveSlotsByKind(unionAvailabilityByKind(kindKeysMap));
          setSaveStatus("saved");
        })
        .catch(() => {
          setSaveStatus("error");
          reloadAvailability();
        });
    },
    [editKind, isVendorViewer, kindKeysMap, reloadAvailability, scheduleOwnerLabel],
  );

  const mutateAvailabilityAllKinds = useCallback(
    (mutate: (current: Set<string>) => Set<string>) => {
      for (const kind of AVAILABILITY_KINDS) {
        if ((kindKeysMap[kind]?.length ?? 0) > 0) mutateAvailability(mutate, kind);
      }
    },
    [kindKeysMap, mutateAvailability],
  );

  /**
   * One day's open runs — painted (per kind, via `mergeOpenRuns`) plus the
   * implicit 9-5 default merged into its own contiguous spans. Computed for
   * the full week so both the mobile single-day strip and the desktop grid
   * (which share `activeBlockDateStrs`) read the same runs.
   */
  const openRunsByDate = useMemo(() => {
    const map = new Map<string, CalendarOpenRun[]>();
    for (const ds of activeBlockDateStrs) {
      const slotsByKind: Partial<Record<AvailabilityKind, number[]>> = {};
      for (const kind of AVAILABILITY_KINDS) {
        const slots = activeSlotsByKind[kind];
        if (!slots) continue;
        const indices = slotRowIndices.filter((slot) => slots.has(dateSlotKey(ds, slot)));
        if (indices.length) slotsByKind[kind] = indices;
      }
      const runs: CalendarOpenRun[] = mergeOpenRuns(slotsByKind);

      // Default-open runs never overlap a painted one — `defaultOnlySlots` already
      // excludes anything published — so a simple contiguous scan is enough.
      let runStart: number | null = null;
      let prevSlot = -2;
      const flushDefaultRun = () => {
        if (runStart === null) return;
        runs.push({ startSlot: runStart, endSlotExclusive: prevSlot + 1, kinds: ["tours"], isDefault: true });
        runStart = null;
      };
      for (const slot of slotRowIndices) {
        const isDefaultOpen = defaultOnlySlots.has(dateSlotKey(ds, slot));
        if (isDefaultOpen) {
          if (runStart === null) runStart = slot;
          else if (slot !== prevSlot + 1) {
            flushDefaultRun();
            runStart = slot;
          }
          prevSlot = slot;
        } else {
          flushDefaultRun();
        }
      }
      flushDefaultRun();

      map.set(
        ds,
        runs.sort((a, b) => a.startSlot - b.startSlot),
      );
    }
    return map;
  }, [activeBlockDateStrs, activeSlotsByKind, defaultOnlySlots]);

  const findOpenRun = useCallback(
    (dateStr: string, slotIdx: number): CalendarOpenRun | undefined =>
      openRunsByDate.get(dateStr)?.find((run) => slotIdx >= run.startSlot && slotIdx < run.endSlotExclusive),
    [openRunsByDate],
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
      if (publishedActiveSlots.has(dateSlotKey(dateStr, slotIdx))) {
        // Select the WHOLE run the clicked cell belongs to (PLAN-0914-1710 §1),
        // not just the one cell. The fallback only covers a stale-frame race
        // between the click and `openRunsByDate` recomputing.
        const run = findOpenRun(dateStr, slotIdx);
        const startSlot = run?.startSlot ?? slotIdx;
        const endSlotExclusive = run?.endSlotExclusive ?? slotIdx + 1;
        const kinds = run?.kinds ?? [editKind];
        setSelectedBlock({
          kind: "availability",
          dateStr,
          startSlot,
          endSlotExclusive,
          kinds,
          isDefault: run?.isDefault,
        });
        // Seed the shared block-form state so the edit dialog opens pre-filled
        // and behaves exactly like "Create recurring availability block"
        // (PLAN-0916-0041). Defaults to this occurrence only; the manager can
        // widen days / repeat to add more from the same dialog.
        setBlockStartSlot(startSlot);
        setBlockEndSlotExclusive(endSlotExclusive);
        setBlockKinds(kinds.length ? kinds : [editKind]);
        setBlockWeekdays([mondayBasedDayIndex(new Date(`${dateStr}T12:00:00`))]);
        setBlockCadence("once");
        setBlockOccurrences(1);
        setBlockOccurrencesDraft(null);
        return;
      }
      if (vendorCalendarActions) {
        vendorCalendarActions.onAddFromSlot(dateStr, slotIdx);
      }
    },
    [editKind, findOpenRun, publishedActiveSlots, vendorCalendarActions],
  );

  /**
   * Removes one default window by storing an exclusion marker so the rest of
   * that day stays on the implicit default. Always kind "tours" — the default
   * 9-5 grid is a tours-only concept (manager-availability-kinds.ts header).
   */
  const removeDefaultSlot = useCallback(
    (dateStr: string, slotIdx: number) => {
      mutateAvailability((current) => {
        const next = new Set(current);
        next.add(defaultTourSlotExclusionKey(dateStr, slotIdx));
        return next;
      }, "tours");
    },
    [mutateAvailability],
  );

  /** Removes a whole contiguous default-open span in one write (one × on the grid). */
  const removeDefaultRun = useCallback(
    (dateStr: string, startSlot: number, endSlotExclusive: number) => {
      mutateAvailability((current) => {
        const next = new Set(current);
        for (let slot = startSlot; slot < endSlotExclusive; slot += 1) {
          next.add(defaultTourSlotExclusionKey(dateStr, slot));
        }
        return next;
      }, "tours");
    },
    [mutateAvailability],
  );

  /** Paint one slot without opening the recurring-block modal — targets the view's current kind. */
  const addAvailabilitySlot = useCallback(
    (dateStr: string, slotIdx: number) => {
      mutateAvailability(
        (current) => new Set(addExplicitTourSlotKeys([...current], dateStr, slotIdx, resolvedDefaultTourAvailability)),
        editKind,
      );
    },
    [editKind, mutateAvailability, resolvedDefaultTourAvailability],
  );

  /** Removes a whole painted run from every kind it is open for ("Delete block" in the edit dialog, or the strip step of a Save). */
  const removeOpenRun = useCallback(
    (dateStr: string, startSlot: number, endSlotExclusive: number, kinds: AvailabilityKind[]) => {
      for (const kind of kinds) {
        mutateAvailability((current) => {
          const next = new Set(current);
          for (let slot = startSlot; slot < endSlotExclusive; slot += 1) {
            next.delete(dateSlotKey(dateStr, slot));
          }
          return next;
        }, kind);
      }
      setSelectedBlock((prev) =>
        prev?.kind === "availability" && prev.dateStr === dateStr && prev.startSlot === startSlot ? null : prev,
      );
      showToast("Open block removed");
    },
    [mutateAvailability, showToast],
  );

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
      // `notifyTenant` defaults to FALSE on the route, so omitting it here silently confirmed the
      // tour without telling the guest. There are two approve paths — this "Approve" button and
      // the guest-notify preview — and only the preview passed it, so which control the manager
      // happened to use decided whether the prospect was ever told their tour was confirmed.
      // A confirmed tour the guest never hears about is the one outcome that strands someone at
      // a property, so this path notifies too.
      notifyTenant: true,
    });
    if (!result.ok) {
      showToast(result.error ?? "Could not approve request.");
      return;
    }
    if (userId && selectedBlock.meeting.kind === "tour") {
      const meeting = selectedBlock.meeting;
      void createScheduledWorkTask(userId, {
        title: scheduledTaskTitleForTour(meeting.name || meeting.title),
        start: meeting.startIso,
        end: endIsoForDuration(meeting.startIso, selectedDurationMinutes),
        propertyId: meeting.propertyId,
        propertyTitle: meeting.propertyTitle,
        roomLabel: meeting.roomLabel,
        notes: meeting.email ? `Guest: ${meeting.email}` : undefined,
      });
    }
    setSelectedBlock(null);
    setMeetingRefresh((n) => n + 1);
    onMeetingsChanged?.();
    reloadAvailability();
    showToast("Request approved.");
  }, [onMeetingsChanged, reloadAvailability, selectedBlock, selectedDurationMinutes, showToast, userId]);

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
    async (skipMessage: boolean, channels?: { viaEmail?: boolean; viaSms?: boolean }, draft?: NotificationConfirmDraft) => {
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
            assignee: draft?.assignee ?? undefined,
            deliverViaEmail: channels?.viaEmail !== false,
            deliverViaSms: channels?.viaSms === true,
          });
          if (!result.ok) {
            showToast(result.error ?? "Could not confirm tour.");
            return;
          }
          if (userId) {
            void createScheduledWorkTask(userId, {
              title: scheduledTaskTitleForTour(meeting.name || meeting.title),
              start: meeting.startIso,
              end: endIso,
              propertyId: meeting.propertyId,
              propertyTitle: meeting.propertyTitle,
              roomLabel: meeting.roomLabel,
              assignee: draft?.assignee ?? undefined,
              notes: meeting.email ? `Guest: ${meeting.email}` : undefined,
            });
          }
          setTourGuestNotifyPreview(null);
          setSelectedBlock(null);
          setMeetingRefresh((n) => n + 1);
          onMeetingsChanged?.();
          reloadAvailability();
          if (result.calendarSync?.ok === false) {
            // Same warning the cancel path gives: the tour is booked and the
            // guest told, but the manager's own Google Calendar has no entry.
            showToast(
              skipMessage
                ? "Tour confirmed, but your Google Calendar did not update."
                : "Tour confirmed and the guest was notified, but your Google Calendar did not update.",
            );
          } else if (skipMessage) {
            showToast("Tour confirmed (no guest notification sent).");
          } else if (tourGuestNotificationFailed(result.tenantNotification)) {
            showToast("Tour confirmed, but one or more selected guest channels did not send.");
          } else if (result.notificationSkipped) {
            showToast(
              "Tour confirmed. Confirmation sent to PropLane inbox (email skipped for demo address or missing provider).",
            );
          } else if (result.error) {
            showToast(`Tour confirmed, but ${result.error}`);
          } else {
            showToast(`Tour confirmed. Sent via ${tourGuestNotificationSummary(result.tenantNotification)}.`);
          }
          return;
        }

        if (preview.action === "delete") {
          const { meeting } = preview;
          const result = await deletePartnerInquiryFromServer(meeting.sourceId, {
            notifyTenant: !skipMessage,
            subject: draft?.subject,
            body: draft?.body,
          });
          if (!result.ok) {
            showToast(result.error ?? "Could not delete this tour.");
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
            deliverViaEmail: channels?.viaEmail !== false,
            deliverViaSms: channels?.viaSms === true,
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
                  : result.guestNotification?.email || result.guestNotification?.sms
                    ? `Tour ${actionLabel}. Sent via ${tourGuestNotificationSummary(result.guestNotification)}.`
                    : `Tour ${actionLabel} and the guest was notified.`,
          );
        }
      } finally {
        setTourNotifyPreviewBusy(false);
      }
    },
    [onMeetingsChanged, reloadAvailability, showToast, tourGuestNotifyPreview, tourNotifyPreviewBusy, userId],
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
      if (planned?.kind === "task" && planned.sourceTaskId && userId) {
        try {
          await deleteManagerTask(userId, planned.sourceTaskId);
          ok = true;
        } catch (e) {
          showToast(e instanceof Error ? e.message : "Could not delete task.");
          return;
        }
      } else if (meeting.kind === "tour") {
        // A confirmed tour owns a durable slot reservation. Even when it has
        // no guest email, delete it through the tour lifecycle RPC so the JSON
        // row and reservation are retired atomically. The generic snapshot
        // writer intentionally preserves tours and would otherwise return a
        // misleading 200 while leaving both records active.
        const result = await deletePlannedTourFromServer({
          plannedEventId: meeting.sourceId,
          notifyGuest: false,
        });
        if (!result.ok) {
          showToast(result.error ?? "Could not delete this tour.");
          return;
        }
        await syncScheduleRecordsFromServer({ force: true });
        ok = true;
      } else {
        if (planned?.googleCalendarEventId?.trim()) {
          await deleteProplaneGoogleTourFromServer(planned.googleCalendarEventId);
          onGoogleCalendarRefresh?.();
        }
        ok = await deletePlannedEventFromServer(meeting.sourceId);
      }
    } else {
      ok = (await deletePartnerInquiryFromServer(meeting.sourceId, { notifyTenant: false })).ok;
    }
    if (ok) {
      setSelectedBlock(null);
      setPendingTourAction(null);
      setMeetingRefresh((n) => n + 1);
      onMeetingsChanged?.();
      reloadAvailability();
      if (isPropPlaneGoogleTourMeeting(meeting)) onGoogleCalendarRefresh?.();
      showToast(
        meeting.kind === "task"
          ? "Task removed."
          : meeting.source === "inquiry"
            ? "Tour request removed and guest notified."
            : "Event deleted.",
      );
    } else {
      showToast("Could not delete this event.");
    }
  }, [onGoogleCalendarRefresh, onMeetingsChanged, reloadAvailability, selectedBlock, showToast, userId]);

  const prevRefreshSig = useRef<number | undefined>(undefined);
  // Canonical vendor availability is installed in the local paint cache by
  // the parent. React may coalesce that first cache signal with mount, so the
  // generic change detector below cannot be the only refresh path: its first
  // observation intentionally skips a reload for manager calendars.
  useEffect(() => {
    if (!isVendorViewer || calendarRefreshSignal === undefined) return;
    refreshPaintedAvailability();
  }, [calendarRefreshSignal, isVendorViewer, refreshPaintedAvailability]);

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
      if (!meetingPaintsCalendarGrid(meeting)) continue;
      for (const key of meetingOccupiedSlotKeys(meeting)) {
        const current = map.get(key);
        if (current && calendarCellPriority(current) < calendarCellPriority(meeting)) continue;
        map.set(key, meeting);
      }
    }
    return map;
  }, [meetings]);

  /**
   * The half hours that are genuinely TAKEN — informational Google metadata is
   * neither painted nor counted; Free/declined rows still draw but do not reduce
   * open capacity, and the public booking page goes on offering them.
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

  /**
   * The day-header count under each date. A manager editing availability leads
   * with open time and only appends booked events when there are any — never a
   * bare "0 events" sitting on top of painted availability (the old behaviour
   * counted only `scheduledMeetings`, so a day full of open blocks still read
   * "0 EVENTS" — PLAN-0916-0041). Read-only viewers (residents) keep the plain
   * event-count header they had.
   */
  const dayHeaderCountLabel = useCallback(
    (dateStr: string): string => {
      const openCount = openSlotCountForDate(dateStr);
      const eventCount = scheduledMeetings.filter((meeting) => meeting.dateStr === dateStr).length;
      if (canEditAvailability) {
        return eventCount > 0 ? `${openCount} open · ${eventCount} booked` : `${openCount} open`;
      }
      if (showEventCountsInDayHeader) return `${eventCount} event${eventCount === 1 ? "" : "s"}`;
      return `${openCount} open`;
    },
    [canEditAvailability, openSlotCountForDate, scheduledMeetings, showEventCountsInDayHeader],
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
  const saveDefaultTourHours = useCallback(
    (nextStart: number, nextEndExclusive: number) => {
      if (!canEditDefaultTourHours) return;
      onDefaultTourHoursChange?.(nextStart, nextEndExclusive);
    },
    [canEditDefaultTourHours, onDefaultTourHoursChange],
  );

  const onVisibleWindowStartChange = useCallback(
    (nextRaw: string) => {
      const nextStart = Number.parseInt(nextRaw, 10);
      if (!Number.isFinite(nextStart)) return;
      const nextEnd =
        visibleEndSlotExclusive <= nextStart
          ? Math.min(nextStart + 1, SLOTS_PER_DAY)
          : visibleEndSlotExclusive;
      setVisibleStartSlot(nextStart);
      if (nextEnd !== visibleEndSlotExclusive) {
        setVisibleEndSlotExclusive(nextEnd);
      }
      saveDefaultTourHours(nextStart, nextEnd);
    },
    [saveDefaultTourHours, visibleEndSlotExclusive],
  );

  const onVisibleWindowEndChange = useCallback(
    (nextRaw: string) => {
      const nextEnd = Number.parseInt(nextRaw, 10);
      if (!Number.isFinite(nextEnd)) return;
      const nextStart =
        visibleStartSlot >= nextEnd ? Math.max(0, nextEnd - 1) : visibleStartSlot;
      setVisibleEndSlotExclusive(nextEnd);
      if (nextStart !== visibleStartSlot) {
        setVisibleStartSlot(nextStart);
      }
      saveDefaultTourHours(nextStart, nextEnd);
    },
    [saveDefaultTourHours, visibleStartSlot],
  );

  // Same PropLane dropdown the wide layout uses. These were native <select>s, so
  // below `lg` the two time pickers opened the OS menu — a full-height unstyled
  // list of every half hour — while the Property picker beside them opened the
  // product's own searchable menu.
  const renderCompactMobileTimeWindow = () => (
    <div className="flex min-w-0 flex-1 items-center gap-1">
      <FieldSingleSelect
        hideLabel
        label="Start time"
        wrapperClassName={CALENDAR_COMPACT_TIME_SELECT_WRAP}
        triggerClassName={CALENDAR_COMPACT_TIME_FIELD_SELECT_TRIGGER}
        value={String(visibleStartSlot)}
        onChange={onVisibleWindowStartChange}
        options={startTimeOptions}
      />
      <span className={cn("shrink-0 text-muted", CALENDAR_COMPACT_TOOLBAR_TEXT)}>–</span>
      <FieldSingleSelect
        hideLabel
        label="End time"
        wrapperClassName={CALENDAR_COMPACT_TIME_SELECT_WRAP}
        triggerClassName={CALENDAR_COMPACT_TIME_FIELD_SELECT_TRIGGER}
        value={String(visibleEndSlotExclusive)}
        onChange={onVisibleWindowEndChange}
        options={endTimeOptions}
      />
    </div>
  );

  const renderTimeWindowControl = (compact = false) => {

    if (compact) {
      return (
        <div className="flex min-w-0 shrink-0 flex-nowrap items-center gap-0 sm:gap-0.5 lg:inline-flex lg:gap-1">
          {onDefaultTourGridEnabledChange ? (
            <button
              type="button"
              className={cn(
                "h-6 shrink-0 rounded-full border px-2 text-[9px] font-semibold transition lg:h-7 lg:text-[10px]",
                resolvedDefaultTourAvailability.enabled !== false
                  ? "border-primary bg-primary/10 text-primary"
                  : "border-border bg-card text-muted",
              )}
              data-attr="calendar-default-tour-toggle"
              onClick={() =>
                onDefaultTourGridEnabledChange(resolvedDefaultTourAvailability.enabled === false)
              }
            >
              Default {resolvedDefaultTourAvailability.enabled !== false ? "on" : "off"}
            </button>
          ) : null}
          <FieldSingleSelect
            hideLabel
            label="Start time"
            wrapperClassName="w-[4.75rem] shrink-0 lg:w-[5rem]"
            triggerClassName={CALENDAR_COMPACT_TIME_FIELD_SELECT_TRIGGER}
            value={String(visibleStartSlot)}
            onChange={onVisibleWindowStartChange}
            options={startTimeOptions}
          />
          <span className="shrink-0 px-0.5 text-[10px] font-medium text-muted sm:text-[11px]">–</span>
          <FieldSingleSelect
            hideLabel
            label="End time"
            wrapperClassName="w-[4.75rem] shrink-0 lg:w-[5rem]"
            triggerClassName={CALENDAR_COMPACT_TIME_FIELD_SELECT_TRIGGER}
            value={String(visibleEndSlotExclusive)}
            onChange={onVisibleWindowEndChange}
            options={endTimeOptions}
          />
        </div>
      );
    }

    return (
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs font-semibold uppercase tracking-[0.14em] text-muted">Show</span>
        <Select value={String(visibleStartSlot)} onChange={(e) => onVisibleWindowStartChange(e.target.value)}>
          {slotRowIndices.map((slot) => (
            <option key={`start-${slot}`} value={slot}>
              {formatAvailabilitySlotLabel(slot)}
            </option>
          ))}
        </Select>
        <span className="text-sm font-medium text-muted">to</span>
        <Select
          value={String(visibleEndSlotExclusive)}
          onChange={(e) => onVisibleWindowEndChange(e.target.value)}
        >
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
    setAnchorDate((date) => shiftCalendarAnchor(date, viewMode, dir));
  };

  const jumpToToday = useCallback(() => {
    setAnchorDate(calendarTodayAnchor(today));
    setMonthPick({ start: null, end: null });
  }, [today]);

  // `setAnchorDate` is a real dependency: omitting it pinned this handler to the first copy, and
  // in CONTROLLED mode (where the parent owns the date) that copy also carries a stale prop, so
  // the functional-updater fix above cannot save it on its own.
  const shiftAvailabilityWeek = useCallback(
    (dir: -1 | 1) => {
      setAnchorDate((d) => addDays(d, dir * 7));
    },
    [setAnchorDate],
  );

  useEffect(() => {
    if (!compactAvailability) return;
    setMobileDayIndex(mondayBasedDayIndex(anchorDate));
  }, [compactAvailability, weekMonday, anchorDate]);

  const copyPreviousWeek = useCallback(() => {
    const currentDates = activeBlockDates;
    const previousBlockDates = currentDates.map((date) => addDays(date, -7));

    mutateAvailabilityAllKinds((activeSlotsForKey) => {
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
  }, [activeBlockDates, mutateAvailabilityAllKinds, slotRowIndices]);

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
      setBlockOccurrencesDraft(null);
      // Prefill from the current view's kind whether opened from a painted
      // cell/drag or from the toolbar — there is no per-cell kind to read back.
      setBlockKinds([editKind]);
      setBlockModalOpen(true);
    },
    [anchorDate, editKind, viewMode, visibleStartSlot],
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
    const span = pending.endSlotExclusive - pending.startSlot;
    dragSelectionRef.current = null;
    setDragSelection(null);
    if (span > 1) {
      lastMultiDragRef.current = pending;
      prefillBlockModal(pending);
    } else {
      lastMultiDragRef.current = null;
    }
  }, [prefillBlockModal]);

  const cancelDragSelection = useCallback(() => {
    dragSelectionRef.current = null;
    lastMultiDragRef.current = null;
    setDragSelection(null);
  }, []);

  /** Open the recurring-block modal prefilled with a single slot (vendor / keyboard path). */
  const openBlockModalForSlot = useCallback(
    (dateStr: string, weekday: number, slotIdx: number) => {
      dragSelectionRef.current = null;
      lastMultiDragRef.current = null;
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

  const applyRecurringBlock = useCallback((editOrigin?: AvailabilityBlockSelection) => {
    const kinds = showAppliesTo ? blockKinds : [editKind];
    if (blockWeekdays.length === 0 || blockEndSlotExclusive <= blockStartSlot || kinds.length === 0) return;

    // When saving an EDIT, first strip the original block's slots. This runs in
    // the SAME per-kind `mutateAvailability` pass as the re-add, so there is no
    // read-after-write race across two calls (PLAN-0916-0041). Origin kinds no
    // longer selected still get a strip-only pass below.
    const originKinds = editOrigin ? (editOrigin.isDefault ? (["tours"] as AvailabilityKind[]) : editOrigin.kinds) : [];
    const affectedKinds = Array.from(new Set<AvailabilityKind>([...kinds, ...originKinds]));

    // One `mutateAvailability` call per affected kind — each kind has its own
    // storage keys, and each call independently reads that kind's current set.
    for (const kind of affectedKinds) {
      mutateAvailability((current) => {
        let next = new Set(current);

        if (editOrigin && originKinds.includes(kind)) {
          if (editOrigin.isDefault) {
            // Editing one run of the implicit 9-5 band: the first explicit slot
            // on a day switches that whole day off the default, so the rest of
            // the band is written back explicitly FIRST (the same materialise
            // step a single Add does) and only then is the origin run removed.
            // Exclusion markers alone would have let the re-add below silently
            // close every other default run left on that day.
            next = new Set(
              addExplicitTourSlotKeys([...next], editOrigin.dateStr, editOrigin.startSlot, resolvedDefaultTourAvailability),
            );
            for (let slot = editOrigin.startSlot; slot < editOrigin.endSlotExclusive; slot += 1) {
              next.delete(dateSlotKey(editOrigin.dateStr, slot));
            }
          } else {
            for (let slot = editOrigin.startSlot; slot < editOrigin.endSlotExclusive; slot += 1) {
              next.delete(dateSlotKey(editOrigin.dateStr, slot));
            }
          }
        }

        if (kinds.includes(kind)) {
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
        }

        return next;
      }, kind);
    }
    setBlockModalOpen(false);
    if (editOrigin) {
      setSelectedBlock(null);
      showToast("Availability updated");
    }
  }, [
    activeBlockDates,
    blockCadence,
    blockEndSlotExclusive,
    blockKinds,
    blockOccurrences,
    blockStartSlot,
    blockWeekdays,
    editKind,
    mutateAvailability,
    resolvedDefaultTourAvailability,
    showAppliesTo,
    showToast,
    weekMonday,
  ]);

  const clearCurrentWeek = useCallback(() => {
    mutateAvailabilityAllKinds((current) => {
      const next = new Set(current);
      for (const ds of activeBlockDateStrs) {
        for (const slot of slotRowIndices) {
          const key = dateSlotKey(ds, slot);
          next.delete(key);
          next.delete(defaultTourSlotExclusionKey(ds, slot));
        }
      }
      return next;
    });
  }, [activeBlockDateStrs, mutateAvailabilityAllKinds, slotRowIndices]);

  const blockSummary = useMemo(() => {
    const days = blockWeekdays.length > 0 ? weekdayLabelList(blockWeekdays) : "No days selected";
    const repeats =
      blockCadence === "once"
        ? "this week only"
        : `${blockCadence} for ${blockOccurrences} occurrence${blockOccurrences === 1 ? "" : "s"}`;
    // Tours-only keeps today's text unchanged — every other selection names the kinds.
    const kindsSegment =
      showAppliesTo && !(blockKinds.length === 1 && blockKinds[0] === "tours")
        ? ` · ${blockKinds.map((kind) => AVAILABILITY_KIND_LABELS[kind].toLowerCase()).join(", ")}`
        : "";
    return `${days} · ${formatAvailabilitySlotLabel(blockStartSlot)}-${formatSlotEndLabel(blockEndSlotExclusive)}${kindsSegment} · ${repeats}`;
  }, [blockCadence, blockEndSlotExclusive, blockKinds, blockOccurrences, blockStartSlot, blockWeekdays, showAppliesTo]);

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

  const selectedIsManagerTask =
    selectedBlock?.kind === "meeting" &&
    selectedBlock.meeting.kind === "task" &&
    Boolean(selectedBlock.meeting.sourceTaskId);

  useEffect(() => {
    setTaskNotesExpanded(false);
  }, [selectedBlock?.kind === "meeting" ? selectedBlock.meeting.id : null]);

  /** Matches the un-armed button, so arming never renames the action. */
  const selectedDeleteLabel =
    selectedBlock?.kind === "meeting" && selectedBlock.meeting.kind === "task"
      ? "Delete task"
      : selectedBlock?.kind === "meeting" &&
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

  const selectedMeetingChrome =
    selectedBlock?.kind === "meeting" ? calendarEventDialogActions(selectedBlock.meeting) : null;

  const selectedBlockTitle =
    selectedBlock?.kind === "meeting"
      ? selectedMeetingChrome?.title ?? selectedBlock.meeting.title
      : "Availability block";

  const pendingInDialogDelete =
    pendingTourAction === "delete" &&
    selectedBlock?.kind === "meeting" &&
    !selectedIsPendingTourInquiry &&
    !selectedIsConfirmedTour;

  const meetingFactRows = (() => {
    if (selectedBlock?.kind !== "meeting") return [];
    const meeting = selectedBlock.meeting;
    const status =
      meeting.statusLabel ??
      (meeting.source === "planned" || isPropPlaneGoogleTourMeeting(meeting) ? "Confirmed" : "Requested");
    const property = meeting.propertyTitle
      ? [
          compactTaskPropertyLabel(meeting.propertyId, meeting.propertyTitle),
          compactTaskRoomLabel(meeting.roomLabel),
        ]
          .filter(Boolean)
          .join(" · ")
      : "";
    const notesValue = meeting.notes
      ? (() => {
          const { preview, truncated } = taskNotesPreview(meeting.notes);
          const showFull = !truncated || taskNotesExpanded;
          return (
            <div className="text-right">
              <p className={`whitespace-pre-wrap ${showFull ? "" : "line-clamp-4"}`}>
                {showFull ? meeting.notes : preview}
              </p>
              {truncated ? (
                <button
                  type="button"
                  className="mt-1 text-xs font-semibold text-primary"
                  onClick={() => setTaskNotesExpanded((open) => !open)}
                >
                  {taskNotesExpanded ? "Show less" : "Show full checklist"}
                </button>
              ) : null}
            </div>
          );
        })()
      : null;
    const durationValue =
      meeting.source === "inquiry" && !meeting.isPeerTour ? (
        <div className="flex flex-col items-end gap-2">
          <PortalFormSingleSelect
            label="Duration"
            labelClassName="sr-only"
            value={durationChoice === "custom" ? "custom" : String(durationChoice)}
            onChange={(next) => {
              if (next === "custom") {
                setDurationChoice("custom");
                return;
              }
              const minutes = Number(next);
              setDurationChoice(minutes);
              setCustomDurationText(String(minutes));
            }}
            options={EVENT_DURATION_SELECT_OPTIONS}
            dataAttr="event-duration"
            keepMenuWithinModalTree
          />
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
                data-attr="event-duration-custom"
              />
              min
            </label>
          ) : null}
        </div>
      ) : null;
    const rows: Array<{ label: string; value: ReactNode }> = [
      { label: "Time", value: formatRangeLabel(meeting.startIso, meeting.endIso) },
      { label: "Status", value: status },
    ];
    if (durationValue) rows.push({ label: "Duration", value: durationValue });
    if (meeting.name) rows.push({ label: "Name", value: meeting.name });
    if (meeting.email) rows.push({ label: "Email", value: meeting.email });
    if (meeting.phone) rows.push({ label: "Phone", value: formatTourContactPhoneDisplay(meeting.phone) });
    if (property) rows.push({ label: "Property", value: property });
    if (notesValue) rows.push({ label: "Notes", value: notesValue });
    if (meeting.instructions) rows.push({ label: "Details", value: meeting.instructions });
    return rows;
  })();

  const meetingPrimaryAction = ((): PortalDialogAction | null => {
    if (selectedBlock?.kind !== "meeting" || !selectedMeetingChrome) return null;
    if (pendingInDialogDelete) {
      return {
        label: selectedDeleteLabel,
        onClick: () => deleteSelectedMeeting(),
        loading: tourActionBusy,
        dataAttr: "tour-delete-submit",
      };
    }
    if (!selectedMeetingChrome.primaryLabel) return null;
    if (selectedIsManagerTask) {
      return {
        label: "Edit task",
        dataAttr: "calendar-task-edit",
        onClick: () => {
          setTaskEditId(selectedBlock.meeting.sourceTaskId ?? null);
          setTaskFormOpen(true);
        },
      };
    }
    if (selectedIsConfirmedTour) {
      return {
        label: "Cancel tour",
        dataAttr: "tour-cancel-open",
        onClick: openConfirmedTourCancelPreview,
      };
    }
    if (selectedBlock.meeting.source === "inquiry") {
      return selectedBlock.meeting.kind === "tour"
        ? { label: "Confirm tour", onClick: openTourConfirmPreview }
        : { label: "Approve", onClick: () => approveSelectedInquiry() };
    }
    return {
      label: selectedMeetingChrome.primaryLabel,
      dataAttr: "tour-delete-open",
      onClick: () => {
        if (selectedIsPendingTourInquiry) openTourDeletePreview();
        else if (selectedIsConfirmedTour) openConfirmedTourDeletePreview();
        else setPendingTourAction("delete");
      },
    };
  })();

  const meetingSecondaryAction = ((): PortalDialogAction | null | undefined => {
    if (selectedBlock?.kind !== "meeting") return undefined;
    if (pendingInDialogDelete) {
      return {
        label: selectedKeepLabel,
        onClick: () => setPendingTourAction(null),
        disabled: tourActionBusy,
      };
    }
    if (!selectedMeetingChrome?.secondaryLabel) return meetingPrimaryAction ? undefined : null;
    return {
      label: selectedMeetingChrome.secondaryLabel,
      dataAttr: "tour-delete-open",
      onClick: () => {
        if (selectedIsPendingTourInquiry) openTourDeletePreview();
        else if (selectedIsConfirmedTour) openConfirmedTourDeletePreview();
        else setPendingTourAction("delete");
      },
    };
  })();

  const availabilityPrimaryAction: PortalDialogAction | null =
    selectedBlock?.kind === "availability"
      ? {
          label: "Save changes",
          disabled:
            blockWeekdays.length === 0 ||
            blockEndSlotExclusive <= blockStartSlot ||
            (showAppliesTo && blockKinds.length === 0),
          onClick: () => applyRecurringBlock(selectedBlock),
        }
      : null;

  const availabilitySecondaryAction: PortalDialogAction | undefined =
    selectedBlock?.kind === "availability"
      ? {
          label: "Delete block",
          onClick: () => {
            if (selectedBlock.isDefault) {
              removeDefaultRun(selectedBlock.dateStr, selectedBlock.startSlot, selectedBlock.endSlotExclusive);
            } else {
              removeOpenRun(
                selectedBlock.dateStr,
                selectedBlock.startSlot,
                selectedBlock.endSlotExclusive,
                selectedBlock.kinds,
              );
            }
            closeSelectedBlock();
          },
        }
      : undefined;

  const selectedBlockModal = (
    <PortalDialog
      open={Boolean(selectedBlock)}
      onClose={closeSelectedBlock}
      title={selectedBlockTitle}
      size="default"
      tone={pendingInDialogDelete ? "danger" : "default"}
      dismissBlocked={tourActionBusy}
      dataAttr="calendar-event-detail-modal"
      headerAction={
        selectedBlock?.kind === "meeting" &&
        selectedMeetingChrome?.showMessage &&
        !pendingInDialogDelete ? (
          <PortalIconAction
            icon={Mail}
            label={selectedMeetingChrome.messageLabel}
            data-attr="tour-open-message-thread"
            onClick={() =>
              openGuestMessageCompose(selectedBlock.meeting.email, selectedBlock.meeting.phone)
            }
          />
        ) : undefined
      }
      primaryAction={
        selectedBlock?.kind === "availability"
          ? availabilityPrimaryAction
          : meetingPrimaryAction
      }
      secondaryAction={
        selectedBlock?.kind === "availability"
          ? availabilitySecondaryAction
          : meetingSecondaryAction
      }
    >
      {selectedBlock?.kind === "meeting" ? (
        <div className="space-y-4">
          {pendingInDialogDelete ? (
            <ConfirmRows
              rows={[
                { label: "Event", value: selectedBlock.meeting.title },
                {
                  label: "When",
                  value: formatRangeLabel(selectedBlock.meeting.startIso, selectedBlock.meeting.endIso),
                },
                ...(selectedBlock.meeting.name
                  ? [{ label: "Guest", value: selectedBlock.meeting.name }]
                  : []),
              ]}
            />
          ) : isGoogleCalendarPrivateBlock(selectedBlock.meeting) ? (
            <p className="text-sm text-muted">
              {selectedBlock.meeting.blocksTourAvailability === false
                ? "This time is marked Free on your linked Google Calendar. Personal event details stay on Google — tour slots here still count as open."
                : "This time is busy on your linked Google Calendar. Personal event details stay on Google — only the blocked time is shown here so tour availability stays accurate."}
            </p>
          ) : (
            <>
              <ConfirmRows rows={meetingFactRows} />
              {selectedIsConfirmedTour && !selectedBlock.meeting.isPeerTour ? (
                <TourReminderTourPanel
                  plannedEventId={selectedBlock.meeting.sourceId}
                  tourStartIso={selectedBlock.meeting.startIso}
                  tourEndIso={selectedBlock.meeting.endIso}
                  recipientEmail={selectedBlock.meeting.email}
                  recipientName={selectedBlock.meeting.name}
                  recipientPhone={selectedBlock.meeting.phone?.trim() || undefined}
                  propertyTitle={
                    selectedBlock.meeting.propertyTitle
                      ? `${selectedBlock.meeting.propertyTitle}${selectedBlock.meeting.roomLabel ? ` · ${selectedBlock.meeting.roomLabel}` : ""}`
                      : undefined
                  }
                  instructions={selectedBlock.meeting.instructions}
                />
              ) : null}
              {selectedBlock.meeting.isPeerTour ? (
                <p className="text-sm text-muted">
                  Hosted by {selectedBlock.meeting.hostLabel ?? "your co-manager"}.
                </p>
              ) : null}
            </>
          )}
        </div>
      ) : selectedBlock?.kind === "availability" ? (
        <RecurringBlockModalFormFields
          blockSummary={blockSummary}
          blockWeekdays={blockWeekdays}
          toggleBlockWeekday={toggleBlockWeekday}
          blockStartSlot={blockStartSlot}
          setBlockStartSlot={setBlockStartSlot}
          blockEndSlotExclusive={blockEndSlotExclusive}
          setBlockEndSlotExclusive={setBlockEndSlotExclusive}
          blockCadence={blockCadence}
          setBlockCadence={setBlockCadence}
          blockOccurrences={blockOccurrences}
          setBlockOccurrences={setBlockOccurrences}
          blockOccurrencesDraft={blockOccurrencesDraft}
          setBlockOccurrencesDraft={setBlockOccurrencesDraft}
          slotRowIndices={slotRowIndices}
          showAppliesTo={showAppliesTo}
          blockKinds={blockKinds}
          setBlockKinds={setBlockKinds}
        />
      ) : null}
    </PortalDialog>
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
      skipMessageLabel={TOUR_GUEST_NOTIFY_PREVIEW_COPY[tourGuestNotifyPreview.action].skipMessageLabel}
      showChannelPicker
      emailAvailable={Boolean(tourGuestNotifyPreview.meeting.email?.includes("@"))}
      smsAvailable={Boolean(tourGuestNotifyPreview.meeting.phone?.trim())}
      confirmLabel={TOUR_GUEST_NOTIFY_PREVIEW_COPY[tourGuestNotifyPreview.action].confirmLabel}
      confirmLabelWithoutMessage={
        TOUR_GUEST_NOTIFY_PREVIEW_COPY[tourGuestNotifyPreview.action].confirmLabelWithoutMessage
      }
      confirmBusy={tourNotifyPreviewBusy}
      confirmBusyLabel={TOUR_GUEST_NOTIFY_PREVIEW_COPY[tourGuestNotifyPreview.action].confirmBusyLabel}
      assigneeKind={tourGuestNotifyPreview.action === "confirm" ? "tour" : undefined}
      assigneeTeamMembers={tourGuestNotifyPreview.action === "confirm" ? teamMembers : undefined}
      assigneeVendors={tourGuestNotifyPreview.action === "confirm" ? vendors : undefined}
      panelClassName="z-[90]"
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
      confirmLabel="Send message"
      confirmBusy={guestMessageBusy}
      confirmBusyLabel="Sending…"
      panelClassName="z-[90]"
      onConfirm={(_skip, channels, draft) => void submitGuestMessage(false, channels, draft)}
    />
  ) : null;

  if (!storageKey && !readOnly && writeStorageKeys.length === 0 && !compactAvailability) {
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
      "portal-calendar-compact flex min-w-0 max-w-full flex-col overflow-x-hidden",
      // `portal-calendar-flow-scroll` only does anything under the page shell
      // (`.portal-list-page-scroll`); inside a modal those rules never match, so
      // taking it INSTEAD of the height chain left the grid unconstrained and
      // simply clipped by the overflow-hidden parent — hours below the fold were
      // unreachable rather than scrollable.
      pageFlowScroll ? "portal-calendar-flow-scroll" : "min-h-0 flex-1",
      // The nested-calendar bottom inset (phone nav + assistant FAB) is page
      // chrome. Inside a modal the grid scrolls within the panel, above both,
      // so that padding was ~116px of dead scroll under the last row.
      embeddedInModal && "portal-calendar-in-modal overflow-hidden",
      !bareSurface && "overflow-hidden rounded-2xl border border-border bg-card shadow-sm",
    );
    const compactToolbarClass = cn(
      "portal-calendar-toolbar min-w-0 shrink-0 overflow-x-hidden",
      "px-2 py-2.5 sm:px-3 sm:py-3",
      bareSurface
        ? flowScroll
          ? "border-b border-border/50 bg-background"
          : "border-b border-border/50"
        : "border-b border-border/60 bg-gradient-to-b from-accent/35 to-accent/15 [html[data-theme=dark]_&]:portal-calendar-week-banner",
    );
    const compactBodyClass = cn(
      "portal-calendar-compact-body min-w-0 max-w-full overflow-x-hidden",
      // Same reason as the shell above: the body's own `overflow-y-auto` can only
      // scroll once something bounds its height.
      pageFlowScroll ? "" : "min-h-0 flex-1",
      embeddedInModal && "overflow-y-auto overscroll-contain [-webkit-overflow-scrolling:touch]",
      bareSurface
        ? flowScroll
          ? ""
          : "pt-2 max-lg:pt-4"
        : "p-3 sm:p-4 max-lg:px-4 max-lg:pt-4 max-lg:pb-5",
    );
    const compactGridTopGap = flowScroll ? "mt-0" : "mt-2";
    const compactMobileTopGap = flowScroll ? "mt-0" : "mt-2 max-lg:mt-4";
    const copyToHousesDisabled = !onCopyWeekToHouses || !otherProperties?.length;
    const canEditWeek = !vendorMode && canEditAvailability;
    // One "Availability" icon holds every bulk/utility action (copy, clear,
    // copy to houses, connect Google Calendar) so the persistent command band
    // stays Filter · Availability · Share · + — never six loose icons
    // (PLAN-0920-1058 area 1d). "Add availability" is the band's one primary
    // instead of living inside the menu.
    const showAvailabilityMenu = canEditWeek || Boolean(extraAvailabilityAction);
    const availabilityMenuAction = showAvailabilityMenu ? (
      <div className="flex shrink-0 items-center" data-slot="calendar-week-actions">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <PortalIconAction icon={CalendarClock} label="Availability" data-attr="calendar-availability-menu" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" data-attr="calendar-availability-menu-content">
            {canEditWeek ? (
              <>
                <DropdownMenuItem data-attr="calendar-copy-previous-week" onSelect={copyPreviousWeek}>
                  Copy previous week
                </DropdownMenuItem>
                <DropdownMenuItem data-attr="calendar-clear-week" onSelect={clearCurrentWeek}>
                  Clear week
                </DropdownMenuItem>
                {isVendorViewer ? null : (
                  <DropdownMenuItem
                    data-attr="calendar-copy-to-houses"
                    disabled={copyToHousesDisabled}
                    onSelect={() => {
                      setSelectedHouseIds(new Set());
                      setCopyToHousesScope("week");
                      setUpdateToHousesOpen(true);
                    }}
                  >
                    {copyToHousesDisabled ? "Add another house to copy availability" : "Copy to houses"}
                  </DropdownMenuItem>
                )}
              </>
            ) : null}
            {canEditWeek && extraAvailabilityAction ? <DropdownMenuSeparator /> : null}
            {extraAvailabilityAction ? <div className="px-1 py-1">{extraAvailabilityAction}</div> : null}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    ) : null;
    const availabilityAddAction = canEditWeek ? (
      <div className="flex shrink-0 items-center" data-slot="calendar-week-add-action">
        <PortalPrimaryIconAction
          icon={Plus}
          label="Add availability"
          data-attr="calendar-create-block"
          onClick={openBlockModal}
        />
      </div>
    ) : null;
    return (
      <>
        <div className={compactShellClass} ref={compactShellRef}>
          <div className={compactToolbarClass} ref={compactToolbarRef}>
            <div className="grid w-full min-w-0 max-w-full grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-1 overflow-x-clip sm:gap-1.5">
              <div className="flex min-w-0 items-center justify-start gap-1.5">
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
              <div className="flex min-w-0 items-center justify-center gap-1 sm:gap-1.5">
                <Button
                  type="button"
                  variant="ghost"
                  className="h-8 w-6 shrink-0 rounded-full p-0 text-xs leading-none text-muted hover:bg-accent/60 hover:text-foreground lg:w-7 lg:text-base"
                  onClick={() => shiftAvailabilityWeek(-1)}
                  aria-label="Previous week"
                >
                  ←
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  className="h-7 shrink-0 rounded-full px-2 text-xs"
                  onClick={jumpToToday}
                  data-attr="calendar-today"
                >
                  Today
                </Button>
                <p className={cn("shrink-0 whitespace-nowrap px-0.5 text-center text-foreground", CALENDAR_COMPACT_TOOLBAR_TEXT, "lg:text-sm lg:font-semibold")}>
                  <span className="md:hidden">{formatWeekRangeMonSunNumeric(weekMonday)}</span>
                  <span className="hidden md:inline lg:hidden">{formatWeekRangeMonSunShort(weekMonday)}</span>
                  <span className="hidden lg:inline">{formatWeekRangeMonSun(weekMonday)}</span>
                </p>
                <Button
                  type="button"
                  variant="ghost"
                  className="h-8 w-6 shrink-0 rounded-full p-0 text-xs leading-none text-muted hover:bg-accent/60 hover:text-foreground lg:w-7 lg:text-base"
                  onClick={() => shiftAvailabilityWeek(1)}
                  aria-label="Next week"
                >
                  →
                </Button>
                {!vendorMode ? (
                  <>
                    <div className="lg:hidden">{renderCompactMobileTimeWindow()}</div>
                    <div className="hidden lg:block">{renderTimeWindowControl(true)}</div>
                  </>
                ) : null}
              </div>
              <div className="flex min-w-0 items-center justify-end gap-1">
                {weekActionsHost ? createPortal(availabilityMenuAction, weekActionsHost) : availabilityMenuAction}
                {weekPrimaryActionHost
                  ? createPortal(availabilityAddAction, weekPrimaryActionHost)
                  : availabilityAddAction}
              </div>
            </div>
          </div>

          <div className={compactBodyClass}>
          {(() => {
            const renderSlotButton = (ds: string, slotIdx: number) => {
              const key = dateSlotKey(ds, slotIdx);
              const active = publishedActiveSlots.has(key);
              const vendorAvailabilityState = active ? "open" : "empty";
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
              // A run merges same-kind-set contiguous open cells into one visual
              // block (PLAN-0914-1710 §1) — only ever set for a painted or
              // default-open cell, mutually exclusive with meeting/coManagerOpen.
              const run = active || defaultOpen ? findOpenRun(ds, slotIdx) : undefined;
              const isRunFirstCell = Boolean(run && run.startSlot === slotIdx);
              const isRunLastCell = Boolean(run && run.endSlotExclusive === slotIdx + 1);
              const runTint = run ? (run.isDefault ? CALENDAR_DEFAULT_OPEN_RUN_TINT : CALENDAR_OPEN_RUN_TINTS[run.kinds[0] ?? "tours"]) : undefined;
              const runLabel = run
                ? vendorViewer
                  ? "Available"
                  : run.isDefault
                    ? "Tours"
                    : formatOpenRunKindsLabel(run.kinds)
                : "";
              // Super plan item 43: a small × on the first cell of an open run
              // (not a chip). Week toolbar icons stay; Delete block in the
              // dialog remains as the longer edit path.
              return (
                <div
                  key={key}
                  className={cn(
                    "group/slot relative min-h-9 min-w-0",
                    // Pull a continuation cell up over the grid's `gap-px` row gap so
                    // the run's fill reads as one continuous block instead of a
                    // stack of 30-min cells with a hairline between each.
                    run && !isRunFirstCell && "-mt-px",
                  )}
                >
                  <button
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
                      if (vendorViewer && !meeting && !coManagerOpen) {
                        onVendorAvailabilityEdit?.(ds, slotIdx);
                        return;
                      }
                      if (defaultOpen) {
                        if (canEditAvailability) removeDefaultSlot(ds, slotIdx);
                        return;
                      }
                      if (!readOnly && !meeting && !active && !coManagerOpen) {
                        const drag = lastMultiDragRef.current;
                        if (
                          drag &&
                          drag.dateStr === ds &&
                          slotIdx >= drag.startSlot &&
                          slotIdx < drag.endSlotExclusive
                        ) {
                          lastMultiDragRef.current = null;
                          return;
                        }
                        if (canEditAvailability) {
                          if (vendorMode) {
                            openBlockModalForSlot(
                              ds,
                              mondayBasedDayIndex(new Date(`${ds}T12:00:00`)),
                              slotIdx,
                            );
                          } else {
                            addAvailabilitySlot(ds, slotIdx);
                          }
                        }
                        return;
                      }
                      openSlotDetails(ds, slotIdx, e.currentTarget, meeting);
                    }}
                    className={cn(
                      "portal-calendar-grid-slot relative h-full min-h-9 w-full px-2 text-center text-[11px] font-semibold transition",
                      meeting
                        ? `${meeting.color} ring-1 ring-inset`
                        : selected
                          ? "bg-primary/[0.14] text-primary ring-2 ring-inset ring-primary/35"
                          : run
                            ? cn(
                                runTint!.fill,
                                "border-x",
                                runTint!.border,
                                isRunFirstCell ? cn("border-t", "rounded-t-lg") : "border-t-0",
                                isRunLastCell ? cn("border-b", "rounded-b-lg") : "border-b-0",
                              )
                            : coManagerOpen
                              ? CALENDAR_CO_MANAGER_SLOT
                              : CALENDAR_EMPTY_SLOT,
                    )}
                    title={
                      defaultOpen
                        ? canEditAvailability
                          ? "Open for tours by default — click to remove this time"
                          : "Open for tours by default. Select one house to edit availability."
                        : meeting
                          ? `${meetingCalendarGridTooltip(meeting)} · ${formatRangeLabel(meeting.startIso, meeting.endIso)}`
                          : undefined
                    }
                    aria-label={
                      vendorViewer && !meeting && !coManagerOpen
                        ? `${active ? "Available" : "Unavailable"} at ${formatAvailabilitySlotLabel(slotIdx)} on ${ds}. Set availability.`
                        : defaultOpen
                        ? canEditAvailability
                          ? `Open for tours by default. Remove ${formatAvailabilitySlotLabel(slotIdx)} on ${ds}`
                          : `Open for tours by default at ${formatAvailabilitySlotLabel(slotIdx)} on ${ds}. Select one house to edit availability.`
                        : meeting || active || coManagerOpen
                          ? `Open details for ${formatAvailabilitySlotLabel(slotIdx)} on ${ds}`
                          : canEditAvailability
                            ? `Add ${formatAvailabilitySlotLabel(slotIdx)} on ${ds}`
                            : `Select ${formatAvailabilitySlotLabel(slotIdx)} on ${ds}`
                    }
                    data-availability-state={vendorViewer ? vendorAvailabilityState : undefined}
                    data-availability-date={vendorViewer ? ds : undefined}
                    data-availability-slot={vendorViewer ? slotIdx : undefined}
                  >
                    {meeting ? (
                      isMeetingStart ? (
                        <span className="block truncate">{meetingCalendarGridLabel(meeting)}</span>
                      ) : (
                        <span className="block truncate opacity-70">
                          {isGoogleCalendarPrivateBlock(meeting)
                            ? googleBusyBlockStatusLabel(meeting)
                            : meeting.statusLabel}
                        </span>
                      )
                    ) : selected ? (
                      "Selected"
                    ) : run ? (
                      isRunFirstCell ? (
                        <span className="flex flex-col items-center justify-center leading-tight">
                          <span className="block truncate">
                            {runLabel}
                          </span>
                          <span className="block truncate text-[9px] font-medium opacity-80">
                            {formatOpenRunTimeRangeLabel(run.startSlot, run.endSlotExclusive)}
                          </span>
                        </span>
                      ) : null
                    ) : coManagerOpen ? (
                      `${coManagerOverlay!.label}`
                    ) : (
                      // A faint "+" that only reveals on hover of a genuinely
                      // empty cell (the fill/colour comes from CALENDAR_EMPTY_SLOT).
                      // Previously this rendered the word "Add", which the empty
                      // cell's hover style turned into a stray blue label mid-grid
                      // (PLAN-0916-0041).
                      readOnly ? "" : <span aria-hidden className="text-base leading-none">+</span>
                    )}
                  </button>
                  {isRunFirstCell && run && canEditAvailability && !readOnly ? (
                    <button
                      type="button"
                      data-attr="calendar-remove-availability-slot"
                      aria-label={`Remove ${runLabel} block on ${ds}`}
                      className="absolute right-0.5 top-0.5 z-10 flex h-4 w-4 items-center justify-center rounded-sm text-current/70 hover:bg-foreground/10 hover:text-foreground"
                      onClick={(event) => {
                        event.preventDefault();
                        event.stopPropagation();
                        if (run.isDefault) {
                          removeDefaultRun(ds, run.startSlot, run.endSlotExclusive);
                        } else {
                          removeOpenRun(ds, run.startSlot, run.endSlotExclusive, run.kinds);
                        }
                      }}
                    >
                      <X className="h-3 w-3" strokeWidth={2} aria-hidden />
                    </button>
                  ) : null}
                </div>
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
                <div className={cn(compactMobileTopGap, "min-w-0 lg:hidden", CALENDAR_WEEK_DAY_STRIP)}>
                  <div className="grid w-full min-w-0 grid-cols-7 gap-0.5 px-0.5 pb-1 pt-1">
                    {activeBlockDates.map((d, idx) => {
                      const ds = toLocalDateStr(d);
                      const isActive = idx === mobileDayIndex;
                      return (
                        <button
                          key={ds}
                          type="button"
                          onClick={() => {
                            setMobileDayIndex(idx);
                            setAnchorDate(activeBlockDates[idx]!);
                          }}
                          className={`flex min-w-0 w-full flex-col items-center justify-center rounded-lg px-0.5 py-1 text-center transition ${
                            isActive ? "bg-primary text-primary-foreground" : "bg-accent/40 text-muted"
                          }`}
                        >
                          <span className="text-[8px] font-bold uppercase leading-none tracking-[0.06em]">
                            {d.toLocaleDateString(undefined, { weekday: "short" })}
                          </span>
                          <span className="text-[10px] font-semibold leading-tight">
                            {d.toLocaleDateString(undefined, { month: "short", day: "numeric" })}
                          </span>
                          <span className="text-[8px] font-medium leading-tight opacity-80">
                            {dayHeaderCountLabel(ds)}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                  {vendorDayFlexibility ? (
                    <div className="mt-2 flex justify-center">{renderFlexibleToggle(mobileDate.getDay())}</div>
                  ) : null}
                  <div className={bareSurface ? "mt-2" : "mt-2 overflow-hidden rounded-2xl border border-border bg-card"}>
                    {/* Same overflow, same fix, on the single-day (mobile) grid. */}
                    <div className={`grid grid-cols-[4rem_1fr] text-[10px] ${CALENDAR_GRID_GAP}`}>
                      <div className={`px-1 py-1.5 text-[9px] font-semibold uppercase tracking-wide ${bareSurface ? "bg-transparent" : ""} ${CALENDAR_HEADER_CELL}`}>
                        Time
                      </div>
                      <div className={`flex items-center justify-center gap-1.5 px-1 py-1.5 text-[9px] font-semibold uppercase tracking-wide ${CALENDAR_HEADER_CELL}`}>
                        <span>{mobileDate.toLocaleDateString(undefined, { weekday: "short" })}</span>
                        <span className="text-muted">
                          {mobileDate.toLocaleDateString(undefined, { month: "short", day: "numeric" })}
                        </span>
                      </div>
                      {visibleSlotIndices.map((slotIdx) => (
                        <Fragment key={slotIdx}>
                          <div className={`flex min-h-8 items-center bg-card px-1 text-[9px] ${CALENDAR_TIME_CELL}`}>
                            {formatAvailabilitySlotLabel(slotIdx)}
                          </div>
                          {renderSlotButton(mobileDs, slotIdx)}
                        </Fragment>
                      ))}
                    </div>
                  </div>
                </div>

                {/* Desktop: full-week grid — day strip sits above slots so headers never collide with "Add". */}
                <div className={`${compactGridTopGap} hidden min-w-0 lg:block`}>
                  <div className={bareSurface ? "min-w-0" : "min-w-0 overflow-hidden rounded-2xl border border-border bg-card"}>
                    <div
                      className={cn(
                        "grid w-full min-w-0 grid-cols-[64px_repeat(7,minmax(0,1fr))] gap-px bg-accent/40 text-[10px]",
                        CALENDAR_WEEK_DAY_STRIP,
                      )}
                    >
                      <div
                        className={`flex items-center justify-center bg-card px-1 py-2 sm:px-1.5 ${CALENDAR_HEADER_CELL}`}
                        aria-hidden
                      >
                        <span className="text-[9px] font-semibold uppercase tracking-wide text-muted">Time</span>
                      </div>
                      {activeBlockDates.map((d) => {
                        const ds = toLocalDateStr(d);
                        return (
                          <div
                            key={ds}
                            className={`bg-card px-0.5 py-2 text-center sm:px-1 ${CALENDAR_HEADER_CELL}`}
                          >
                            <p className="text-[10px] font-bold uppercase tracking-[0.08em] text-muted">
                              {d.toLocaleDateString(undefined, { weekday: "short" })}
                            </p>
                            <p className="mt-0.5 text-xs font-semibold leading-tight text-foreground">
                              {d.toLocaleDateString(undefined, { month: "short", day: "numeric" })}
                            </p>
                            <p className={`mt-0.5 text-[9px] font-medium uppercase leading-tight ${CALENDAR_OPEN_COUNT}`}>
                              {dayHeaderCountLabel(ds)}
                            </p>
                            {renderFlexibleToggle(d.getDay())}
                          </div>
                        );
                      })}
                    </div>

                    <div className="min-w-0 overflow-x-auto" onMouseLeave={cancelDragSelection} onMouseUp={finishDragSelection}>
                      {/*
                        64px, not 44px (AXI-161). `CALENDAR_TIME_CELL` is
                        `whitespace-nowrap`, so a label that does not fit does not
                        wrap — it OVERFLOWS into the first day column. "11:30 am" at
                        11px is about 47px of text, and 44px minus its own padding
                        left roughly 28px, which is where the "overlap with am"
                        came from. Every half-hour past 10 o'clock collided.
                      */}
                      <div className={`grid w-full min-w-0 grid-cols-[64px_repeat(7,minmax(0,1fr))] text-[10px] ${CALENDAR_GRID_GAP}`}>
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
            setBlockOccurrencesDraft(null);
          }}
          footer={
            <ModalFooter>
              <Button
                type="button"
                variant="primary"
                className="rounded-full"
                onClick={() => applyRecurringBlock()}
                disabled={
                  blockWeekdays.length === 0 ||
                  blockEndSlotExclusive <= blockStartSlot ||
                  (showAppliesTo && blockKinds.length === 0)
                }
              >
                Create block
              </Button>
            </ModalFooter>
          }
        >
          <RecurringBlockModalFormFields
            blockSummary={blockSummary}
            blockWeekdays={blockWeekdays}
            toggleBlockWeekday={toggleBlockWeekday}
            blockStartSlot={blockStartSlot}
            setBlockStartSlot={setBlockStartSlot}
            blockEndSlotExclusive={blockEndSlotExclusive}
            setBlockEndSlotExclusive={setBlockEndSlotExclusive}
            blockCadence={blockCadence}
            setBlockCadence={setBlockCadence}
            blockOccurrences={blockOccurrences}
            setBlockOccurrences={setBlockOccurrences}
            blockOccurrencesDraft={blockOccurrencesDraft}
            setBlockOccurrencesDraft={setBlockOccurrencesDraft}
            slotRowIndices={slotRowIndices}
            showAppliesTo={showAppliesTo}
            blockKinds={blockKinds}
            setBlockKinds={setBlockKinds}
          />
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
            {vendorViewer ? null : (
              <p className="text-xs font-bold uppercase tracking-[0.16em] text-muted">
                {viewMode === "day" ? "Day view" : viewMode === "week" ? "Week view" : "Month view"}
              </p>
            )}
            <h2 className={cn("truncate text-xl font-semibold text-foreground", vendorViewer ? "" : "mt-1")}>{formatNavTitle(anchorDate, viewMode)}</h2>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <div className="flex items-center gap-1 rounded-full border border-border bg-card p-0.5">
              <Button type="button" variant="outline" className="h-9 rounded-full px-3 text-xs" onClick={jumpToToday}>
                Today
              </Button>
              <Button type="button" variant="outline" className="h-9 rounded-full px-3 text-xs" onClick={() => shiftAnchor(-1)} aria-label={`Previous ${viewMode}`}>
                ←
              </Button>
              <Button type="button" variant="outline" className="h-9 rounded-full px-3 text-xs" onClick={() => shiftAnchor(1)} aria-label={`Next ${viewMode}`}>
                →
              </Button>
            </div>
            {hideViewModeControl ? null : (
              <PortalSegmentedControl<CalendarMode>
                options={[
                  { id: "day", label: "Day" },
                  { id: "week", label: "Week" },
                  { id: "month", label: "Month" },
                ]}
                value={viewMode}
                onChange={setViewMode}
              />
            )}
            {vendorViewer ? null : (
              <div className="rounded-full bg-accent/30 px-4 py-2 text-sm font-semibold text-muted">
                {viewMode === "month" ? monthBlocksCount : gridPaintedMeetings.length} blocks
              </div>
            )}
            {!vendorViewer && viewMode !== "month" ? renderTimeWindowControl() : null}
            {!vendorViewer ? (
              <Button type="button" variant="outline" className="h-9 rounded-full px-3 text-xs" onClick={openBlockModal}>
                Create block
              </Button>
            ) : null}
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
          <div className="mt-1 grid grid-cols-7 gap-1" data-slot="calendar-month-grid">
            {monthCells.map((day, i) => {
              if (!day) return <div key={`pad-${i}`} className="aspect-square" />;
              const cellDate = new Date(monthYear, monthIndex, day, 12, 0, 0, 0);
              const ds = toLocalDateStr(cellDate);
              const picked = pinMonthSchedule && isInMonthPickRange(ds, monthPick);
              const hasAvail = dateHasAvailability(cellDate, vendorViewer ? activeSlots : offeredSlots);
              return (
                <button
                  key={`${monthYear}-${monthIndex}-${day}`}
                  type="button"
                  onClick={() => {
                    setAnchorDate(cellDate);
                    if (vendorViewer) {
                      onVendorAvailabilityEdit?.(ds);
                      return;
                    }
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
                  aria-label={
                    vendorViewer
                      ? `${hasAvail ? "Available" : "Unavailable"} on ${ds}. Set availability.`
                      : undefined
                  }
                  data-availability-state={vendorViewer ? (hasAvail ? "open" : "empty") : undefined}
                  data-availability-date={vendorViewer ? ds : undefined}
                >
                  <span>{day}</span>
                  {vendorViewer && hasAvail ? <span className="text-[9px] font-semibold text-primary">Available</span> : null}
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
                <div key={ds} className="overflow-hidden rounded-2xl border border-border bg-card" data-slot="calendar-week-date">
                  <div className={`bg-accent/30 px-4 py-3 [html[data-theme=dark]_&]:portal-calendar-week-banner`}>
                    <p className="text-sm font-semibold text-foreground">{d.toLocaleDateString(undefined, { weekday: "long" })}</p>
                    <p className="text-xs text-muted">{d.toLocaleDateString(undefined, { month: "short", day: "numeric" })}</p>
                  </div>
                  <div className="grid grid-cols-[72px_minmax(0,1fr)] gap-px bg-accent/30">
                    {visibleSlotIndices.map((slotIdx) => {
                      const meeting = meetings.find(
                        (m) => m.dateStr === ds && m.startSlot === slotIdx && meetingPaintsCalendarGrid(m),
                      );
                      const active = activeSlots.has(dateSlotKey(ds, slotIdx));
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
                            ) : vendorViewer ? (
                              <button
                                type="button"
                                className={cn(
                                  "h-full w-full rounded-xl border",
                                  active ? "border-primary/30 bg-primary/[0.08]" : "border-dashed border-border",
                                )}
                                aria-label={`${active ? "Edit open availability" : "Edit availability"} at ${formatAvailabilitySlotLabel(slotIdx)} on ${ds}`}
                                data-availability-state={active ? "open" : "empty"}
                                data-availability-date={ds}
                                data-availability-slot={slotIdx}
                                onClick={() => onVendorAvailabilityEdit?.(ds, slotIdx)}
                              />
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
            <div className={`col-span-2 px-3 py-3 text-center ${CALENDAR_HEADER_CELL}`} data-slot="calendar-day-header">
              <p className="text-sm font-semibold text-foreground">{anchorDate.toLocaleDateString(undefined, { weekday: "long" })}</p>
              <p className="text-xs text-muted">{anchorDate.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}</p>
            </div>
            {visibleSlotIndices.map((slotIdx) => {
              const ds = toLocalDateStr(anchorDate);
              const meeting = meetings.find(
                (m) => m.dateStr === ds && m.startSlot === slotIdx && meetingPaintsCalendarGrid(m),
              );
              const active = activeSlots.has(dateSlotKey(ds, slotIdx));
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
                    ) : vendorViewer ? (
                      <button
                        type="button"
                        className={cn(
                          "h-full w-full rounded-xl border",
                          active ? "border-primary/30 bg-primary/[0.08]" : "border-dashed border-border",
                        )}
                        aria-label={`${active ? "Edit open availability" : "Edit availability"} at ${formatAvailabilitySlotLabel(slotIdx)} on ${ds}`}
                        data-availability-state={active ? "open" : "empty"}
                        data-availability-date={ds}
                        data-availability-slot={slotIdx}
                        onClick={() => onVendorAvailabilityEdit?.(ds, slotIdx)}
                      />
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
                  const active = publishedActiveSlots.has(key);
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
      <div className={cn("grid gap-4", vendorViewer ? "" : "xl:grid-cols-[1.25fr_0.95fr]")}>
        {scheduleCard}
        {vendorViewer ? null : availabilityCard}
      </div>

      <Modal
        open={blockModalOpen}
        title="Create recurring availability block"
        onClose={() => {
          setBlockModalOpen(false);
          setDragSelection(null);
          setBlockOccurrencesDraft(null);
        }}
        footer={
          <ModalFooter>
            <Button
              type="button"
              variant="primary"
              className="rounded-full"
              onClick={() => applyRecurringBlock()}
              disabled={blockWeekdays.length === 0 || blockEndSlotExclusive <= blockStartSlot}
            >
              Create block
            </Button>
          </ModalFooter>
        }
      >
        <RecurringBlockModalFormFields
          blockSummary={blockSummary}
          blockWeekdays={blockWeekdays}
          toggleBlockWeekday={toggleBlockWeekday}
          blockStartSlot={blockStartSlot}
          setBlockStartSlot={setBlockStartSlot}
          blockEndSlotExclusive={blockEndSlotExclusive}
          setBlockEndSlotExclusive={setBlockEndSlotExclusive}
          blockCadence={blockCadence}
          setBlockCadence={setBlockCadence}
          blockOccurrences={blockOccurrences}
          setBlockOccurrences={setBlockOccurrences}
          blockOccurrencesDraft={blockOccurrencesDraft}
          setBlockOccurrencesDraft={setBlockOccurrencesDraft}
          slotRowIndices={slotRowIndices}
          showAppliesTo={showAppliesTo}
          blockKinds={blockKinds}
          setBlockKinds={setBlockKinds}
        />
      </Modal>
      {selectedBlockModal}
      {userId && !isVendorViewer && !readOnly ? (
        <ManagerTaskFormModal
          open={taskFormOpen}
          onClose={() => {
            setTaskFormOpen(false);
            setTaskEditId(null);
          }}
          managerUserId={userId}
          editingId={taskEditId}
          onSaved={() => {
            showToast("Task updated.");
            setSelectedBlock(null);
            setMeetingRefresh((n) => n + 1);
            onMeetingsChanged?.();
            reloadAvailability();
          }}
        />
      ) : null}
      {tourGuestNotifyPreviewModal}
      {guestMessageModal}
    </>
  );
}
