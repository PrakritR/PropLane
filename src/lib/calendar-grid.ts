/**
 * Pure layout math for the manager Calendar's Week / Day time grid
 * (studio-redesign-0929: C2-CALP2, CALP3, CALP4, CALA4, CALA6).
 *
 * Nothing here touches React or storage: the grid component hands in meetings
 * and open runs and gets pixel geometry back, so the rules (lanes, the 8 am to
 * 7 pm fit, the drag snap, which bands a tab shows) are unit-testable.
 */
import type { CSSProperties } from "react";
import { weekdayOfDateStr } from "@/lib/calendar-availability-window";
import {
  AVAILABILITY_KINDS,
  AVAILABILITY_KIND_LABELS,
  isEverythingKinds,
  type AvailabilityKind,
} from "@/lib/manager-availability-kinds";

/** Pixels per hour of the time grid. */
export const GRID_HOUR_PX = 52;
/** A block is never shorter than this, so time + title + house always fit. */
export const GRID_MIN_BLOCK_PX = 50;
/** Default visible window: 8 am to 7 pm. */
export const GRID_DEFAULT_FROM = 8 * 60;
export const GRID_DEFAULT_TO = 19 * 60;
/** Availability and drag both snap to half hours. */
export const GRID_STEP_MINUTES = 30;
export const GRID_DAY_END = 24 * 60;

/** Inspections, move-ins/outs and every house task are `task` here: the calendar has three kinds. */
export type CalendarItemKind = "tour" | "service" | "task" | "busy";

/** Type colours (the tab dots are the legend). Hex so they read in light and dark. */
export const CALENDAR_KIND_COLOR: Record<CalendarItemKind, string> = {
  tour: "#2863f0",
  service: "#e8890c",
  task: "#12805c",
  busy: "#94a3b8",
};

export const CALENDAR_KIND_LABEL: Record<CalendarItemKind, string> = {
  tour: "Tour",
  service: "Service",
  task: "Task",
  busy: "Busy",
};

/** Availability stripe colours: Tours blue, Services orange, Tasks green. */
export const AVAILABILITY_KIND_COLOR: Record<AvailabilityKind, string> = {
  tours: "#2a78d6",
  services: "#eb6834",
  tasks: "#1baf7a",
};

/** The kinds a typed band can show a stripe for. */
export const AVAILABILITY_STRIPE_ORDER: readonly AvailabilityKind[] = ["tours", "services", "tasks"];

export function calendarItemKind(meeting: {
  kind?: "partner" | "tour" | "service" | "task";
  title?: string;
  googleCalendarPrivate?: boolean;
}): CalendarItemKind {
  if (meeting.googleCalendarPrivate) return "busy";
  if (meeting.kind === "service") return "service";
  if (meeting.kind === "task") return "task";
  if (meeting.kind === "tour" || meeting.kind === "partner") return "tour";
  return "service";
}

/** "9 am", "9:30 am", "12 pm" — minutes after midnight. */
export function formatClock(minutes: number): string {
  const total = Math.max(0, Math.min(GRID_DAY_END, Math.round(minutes)));
  const hour24 = Math.floor(total / 60) % 24;
  const mm = total % 60;
  const suffix = hour24 < 12 ? "am" : "pm";
  const hour12 = hour24 % 12 === 0 ? 12 : hour24 % 12;
  return `${hour12}${mm ? `:${String(mm).padStart(2, "0")}` : ""} ${suffix}`;
}

/** "9 – 11 am" when the meridiem matches, "11 am – 1 pm" when it does not. */
export function formatClockRange(from: number, to: number): string {
  const a = formatClock(from);
  const b = formatClock(to);
  return a.slice(-2) === b.slice(-2) ? `${a.slice(0, -3)} – ${b}` : `${a} – ${b}`;
}

export type GridEvent = { id: string; startMin: number; durationMin: number };
export type PlacedGridEvent = { id: string; lane: number; lanes: number };

/**
 * Side-by-side lanes for overlapping blocks. A cluster is a run of events that
 * chain-overlap; every event in a cluster shares the cluster's lane count so
 * widths line up. A block counts as at least `GRID_MIN_BLOCK_PX` tall because
 * that is what it draws.
 */
export function layoutDayEvents(events: readonly GridEvent[], from: number, to: number): PlacedGridEvent[] {
  const minDisplay = (GRID_MIN_BLOCK_PX / GRID_HOUR_PX) * 60;
  const shown = events
    .filter((event) => event.startMin + Math.max(event.durationMin, 1) > from && event.startMin < to)
    .sort((a, b) => a.startMin - b.startMin || a.id.localeCompare(b.id));
  const out: PlacedGridEvent[] = [];
  let cluster: Array<{ id: string; lane: number }> = [];
  let clusterEnd = -1;
  let ends: number[] = [];
  const flush = () => {
    const lanes = Math.max(1, ends.length);
    for (const placed of cluster) out.push({ id: placed.id, lane: placed.lane, lanes });
    cluster = [];
    ends = [];
    clusterEnd = -1;
  };
  for (const event of shown) {
    const display = Math.max(event.durationMin, minDisplay);
    const end = event.startMin + display;
    if (cluster.length > 0 && event.startMin >= clusterEnd) flush();
    let lane = ends.findIndex((laneEnd) => laneEnd <= event.startMin);
    if (lane < 0) {
      lane = ends.length;
      ends.push(end);
    } else {
      ends[lane] = end;
    }
    clusterEnd = Math.max(clusterEnd, end);
    cluster.push({ id: event.id, lane });
  }
  flush();
  return out;
}

export type GridWindow = { from: number; to: number; early: number; late: number };

/**
 * The hours the grid shows: 8 am to 7 pm, widened only when the manager asks
 * for the "N items earlier / later" rows (C2-CALP2). `early` / `late` count
 * the timed items that fall outside the default window so the quiet row can
 * name them; they are 0 (and the row is absent) when everything fits.
 */
export function fitGridWindow(
  events: ReadonlyArray<{ startMin: number; durationMin: number }>,
  expand: { early: boolean; late: boolean } = { early: false, late: false },
): GridWindow {
  let lo = GRID_DEFAULT_FROM;
  let hi = GRID_DEFAULT_TO;
  let early = 0;
  let late = 0;
  let minStart: number | null = null;
  let maxEnd: number | null = null;
  for (const event of events) {
    const end = event.startMin + Math.max(event.durationMin, GRID_STEP_MINUTES);
    if (event.startMin < GRID_DEFAULT_FROM) {
      early += 1;
      minStart = minStart === null ? event.startMin : Math.min(minStart, event.startMin);
    }
    if (end > GRID_DEFAULT_TO) {
      late += 1;
      maxEnd = maxEnd === null ? end : Math.max(maxEnd, end);
    }
  }
  if (expand.early && minStart !== null) lo = Math.floor(minStart / 60) * 60;
  if (expand.late && maxEnd !== null) hi = Math.min(GRID_DAY_END, Math.ceil(maxEnd / 60) * 60);
  return { from: lo, to: hi, early, late };
}

/** Minutes after midnight at a pointer height inside a column that starts at `from`. */
export function minutesAtOffset(offsetPx: number, from: number, to: number): number {
  const raw = from + (offsetPx / GRID_HOUR_PX) * 60;
  return Math.max(from, Math.min(to - 1, raw));
}

/**
 * The dashed band of a drag: both ends snap to 30 minutes and the band covers
 * the half hours under the pointer at either end (C2-CALA4). A press without
 * movement still yields one half hour — the caller decides that a click that
 * never moved does nothing.
 */
export function snapDragRange(anchorMin: number, currentMin: number, to: number): { from: number; to: number } {
  const a = Math.floor(anchorMin / GRID_STEP_MINUTES) * GRID_STEP_MINUTES;
  const c = Math.floor(currentMin / GRID_STEP_MINUTES) * GRID_STEP_MINUTES;
  return { from: Math.min(a, c), to: Math.min(Math.max(a, c) + GRID_STEP_MINUTES, to) };
}

/** A painted run, as the panel computes it per day (slot indices are 30-minute half hours). */
export type GridOpenRun = {
  startSlot: number;
  endSlotExclusive: number;
  kinds: readonly AvailabilityKind[];
  isDefault?: boolean;
};

export type GridBand = {
  startMin: number;
  endMin: number;
  kinds: AvailabilityKind[];
  /** `typed` is something the manager painted; `default` is the implicit 9 to 5 (not clickable). */
  source: "typed" | "default";
};

export type CalendarTabId = "all" | "tours" | "services" | "tasks";

/**
 * Which bands a tab draws (C2-CALA6): All shows every band, Tours only windows
 * that include Tours, Services only those with Services, Tasks only those
 * with Tasks. The default 9 to 5 is a
 * tours concept, so it shows on All and Tours.
 */
export function bandsForTab(runs: readonly GridOpenRun[], tab: CalendarTabId): GridBand[] {
  const out: GridBand[] = [];
  for (const run of runs) {
    const kinds = AVAILABILITY_KINDS.filter((kind) => run.kinds.includes(kind));
    const include =
      tab === "all" ||
      (tab === "tours" && kinds.includes("tours")) ||
      (tab === "services" && kinds.includes("services")) ||
      (tab === "tasks" && kinds.includes("tasks"));
    if (!include) continue;
    out.push({
      startMin: run.startSlot * GRID_STEP_MINUTES,
      endMin: run.endSlotExclusive * GRID_STEP_MINUTES,
      kinds,
      source: run.isDefault ? "default" : "typed",
    });
  }
  return out.sort((a, b) => a.startMin - b.startMin);
}

export type BandPaint = {
  /** Everything (or nothing specific) is the plain hatch. */
  plain: boolean;
  /** One stripe per specific type, in the tab-dot colours. */
  stripes: Array<{ kind: AvailabilityKind; color: string }>;
};

export function bandPaint(kinds: readonly AvailabilityKind[]): BandPaint {
  if (kinds.length === 0 || isEverythingKinds(kinds)) return { plain: true, stripes: [] };
  const stripes = AVAILABILITY_STRIPE_ORDER.filter((kind) => kinds.includes(kind)).map((kind) => ({
    kind,
    color: AVAILABILITY_KIND_COLOR[kind]!,
  }));
  return stripes.length === 0 ? { plain: true, stripes: [] } : { plain: false, stripes };
}

/** The named types, e.g. "Tours, Services" (all three read "Tours, Services, Tasks"). */
export function bandKindsLabel(kinds: readonly AvailabilityKind[], _long = true): string {
  const names = AVAILABILITY_STRIPE_ORDER.filter((kind) => kinds.includes(kind)).map(
    (kind) => AVAILABILITY_KIND_LABELS[kind],
  );
  return names.length === 0 ? "Open hours" : names.join(", ");
}

/** Distinct band type labels on screen, for the legend under the grid. */
export function legendKinds(bands: readonly GridBand[]): string[] {
  const seen = new Set<string>();
  for (const band of bands) seen.add(bandKindsLabel(band.kinds, false));
  return [...seen];
}

/** Merge half-hour starts into contiguous { from, to } minute runs. */
export function runsFromStartMinutes(starts: readonly number[]): Array<{ from: number; to: number }> {
  const runs: Array<{ from: number; to: number }> = [];
  for (const start of [...starts].sort((a, b) => a - b)) {
    const last = runs[runs.length - 1];
    if (last && last.to === start) last.to = start + GRID_STEP_MINUTES;
    else if (!last || start >= last.to) runs.push({ from: start, to: start + GRID_STEP_MINUTES });
  }
  return runs;
}

/** "9 am - 5 pm · 8 h" for the Day panel's open-times line. */
export function openRunsSummary(starts: readonly number[]): string {
  if (starts.length === 0) return "";
  const hours = starts.length / 2;
  const runs = runsFromStartMinutes(starts).map((run) => formatClockRange(run.from, run.to));
  return `${runs.join(", ")} · ${Number.isInteger(hours) ? hours : hours.toFixed(1)} h`;
}

const PLAIN_BAND_COLOR = "#2a78d6";

/**
 * The hatch behind the blocks (C2-CALP3, CALA6). Everything is the plain light
 * hatch; a type is a tinted hatch with a stripe on the left in its tab-dot
 * colour, and more than one type gets one stripe each. `strength` is the grid
 * (quiet, behind blocks), the legend key and the popup's small week (a bit
 * denser so a 4 px band still reads).
 */
export function bandStyle(paint: BandPaint, strength: "grid" | "key" | "preview" = "grid"): CSSProperties {
  const tinted = !paint.plain && paint.stripes.length > 0;
  const base = tinted ? paint.stripes[0]!.color : PLAIN_BAND_COLOR;
  const hi = strength === "grid" ? (tinted ? 17 : 9) : strength === "key" ? 30 : 32;
  const lo = strength === "grid" ? (tinted ? 5 : 2.5) : strength === "key" ? 9 : 12;
  const step = strength === "key" ? 3 : strength === "preview" ? 4 : 5;
  const style: CSSProperties = {
    backgroundImage: `repeating-linear-gradient(135deg, color-mix(in srgb, ${base} ${hi}%, transparent) 0 ${step}px, color-mix(in srgb, ${base} ${lo}%, transparent) ${step}px ${step * 2}px)`,
  };
  if (tinted) {
    style.boxShadow = paint.stripes
      .map((stripe, index) => `inset ${3 * (index + 1)}px 0 0 ${stripe.color}`)
      .join(", ");
  }
  return style;
}

const MONTHS_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const MONTHS_LONG = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];
const WEEKDAYS_SHORT = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

function shortDay(dateStr: string): string {
  const [, m, d] = dateStr.split("-");
  return `${MONTHS_SHORT[Number(m) - 1] ?? ""} ${Number(d)}`;
}

/**
 * The header's range label (C2-CALP1, CALP7): "Sep 21 - Sep 27" for a week,
 * "October 2026" for a month, "Mon, Oct 5" for a day. The year appears only
 * when the range is not in the current year or crosses a year boundary, and a
 * phone shortens a same-month week to "Sep 21 - 27".
 */
export function calendarRangeLabel(args: {
  view: "day" | "week" | "month" | "agenda";
  /** First and last visible day, `YYYY-MM-DD`. */
  start: string;
  last: string;
  currentYear: number;
  phone?: boolean;
}): string {
  const { view, start, last, currentYear, phone = false } = args;
  const startYear = Number(start.slice(0, 4));
  const lastYear = Number(last.slice(0, 4));
  if (view === "month") return `${MONTHS_LONG[Number(start.slice(5, 7)) - 1] ?? ""} ${startYear}`;
  if (view === "day") {
    const weekday = WEEKDAYS_SHORT[weekdayOfDateStr(start)] ?? "";
    return `${weekday}, ${shortDay(start)}${startYear !== currentYear ? `, ${startYear}` : ""}`;
  }
  const withYear = startYear !== currentYear || lastYear !== startYear;
  if (phone && !withYear && start.slice(5, 7) === last.slice(5, 7)) return `${shortDay(start)} - ${Number(last.slice(8))}`;
  return `${shortDay(start)} - ${shortDay(last)}${withYear ? `, ${lastYear}` : ""}`;
}
