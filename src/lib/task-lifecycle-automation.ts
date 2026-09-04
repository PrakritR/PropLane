/**
 * Auto-generated operational tasks across the resident journey.
 *
 * A resident moves tour → application → lease → rent, and each hand-off leaves
 * the manager something to do by a deadline. Previously only the application
 * half was automated (`task-automation-preferences`), and its deadlines were
 * whole DAYS — which cannot express "approve this tour request within an hour"
 * or "be ready three hours before the tour". Same unit problem the reminder
 * spine had, solved the same way: one unit, minutes, everywhere.
 *
 * Two anchors, because the two kinds of deadline are genuinely different:
 *
 * - `after_trigger` — a response deadline. The clock starts when the thing
 *   arrives ("approve within 1 hour of the request"), so it is only knowable
 *   once the trigger fires.
 * - `before_event` — a preparation deadline. The clock runs backwards from a
 *   known future moment ("be ready 3 hours before the tour"), so it needs the
 *   event time and is dropped if that time has already passed.
 *
 * Collapsing the two into one number is what makes a settings screen lie: "3"
 * would mean three days after for one row and three hours before for another.
 */

export const LIFECYCLE_TASK_KEYS = [
  "approve_tour_request",
  "prepare_for_tour",
  "review_application",
  "decide_application",
  "review_and_send_lease",
  "countersign_lease",
  "collect_rent",
] as const;

export type LifecycleTaskKey = (typeof LIFECYCLE_TASK_KEYS)[number];

/** Which part of the journey a task belongs to — the Settings grouping. */
export type LifecycleSection = "tours" | "applications" | "leases" | "payments";

export type LifecycleAnchor = "after_trigger" | "before_event";

export type LifecycleTaskConfig = {
  enabled: boolean;
  /**
   * Minutes from the anchor. Always positive: the anchor decides the direction,
   * so a negative here would be a second, contradictory way to say "before".
   */
  offsetMinutes: number;
  /** Team member user id; null = the property manager (owner). */
  defaultAssigneeUserId: string | null;
  /** Email the assignee when the task is created and again when it comes due. */
  sendEmailReminder: boolean;
  /** Additional reminder emails before the due time (minutes before due). */
  reminderMinutesBeforeList: number[];
};

export type LifecycleTaskAutomation = Record<LifecycleTaskKey, LifecycleTaskConfig>;

export type LifecycleTaskMeta = {
  key: LifecycleTaskKey;
  section: LifecycleSection;
  label: string;
  /** What starts the clock, in the manager's words. */
  triggerLabel: string;
  anchor: LifecycleAnchor;
  /** Title given to the generated task. */
  taskTitle: string;
};

export const LIFECYCLE_TASK_META: Record<LifecycleTaskKey, LifecycleTaskMeta> = {
  approve_tour_request: {
    key: "approve_tour_request",
    section: "tours",
    label: "Approve tour request",
    triggerLabel: "a tour is requested",
    anchor: "after_trigger",
    taskTitle: "Approve tour request",
  },
  prepare_for_tour: {
    key: "prepare_for_tour",
    section: "tours",
    label: "Prepare for tour",
    triggerLabel: "the tour starts",
    anchor: "before_event",
    taskTitle: "Prepare for tour",
  },
  review_application: {
    key: "review_application",
    section: "applications",
    label: "Review application",
    triggerLabel: "an application is submitted",
    anchor: "after_trigger",
    taskTitle: "Review application",
  },
  decide_application: {
    key: "decide_application",
    section: "applications",
    label: "Decide on application",
    triggerLabel: "an application is submitted",
    anchor: "after_trigger",
    taskTitle: "Approve or decline application",
  },
  review_and_send_lease: {
    key: "review_and_send_lease",
    section: "leases",
    label: "Review and send lease",
    triggerLabel: "an application is approved",
    anchor: "after_trigger",
    taskTitle: "Review and send lease",
  },
  countersign_lease: {
    key: "countersign_lease",
    section: "leases",
    label: "Countersign lease",
    triggerLabel: "the resident signs",
    anchor: "after_trigger",
    taskTitle: "Countersign lease",
  },
  collect_rent: {
    key: "collect_rent",
    section: "payments",
    // "Collect payment", not "Collect first rent": the same task covers the
    // deposit, the move-in fee and every later charge, and calling it rent sent
    // a manager looking for the others to a task that appeared to be about one.
    label: "Collect payment",
    triggerLabel: "an application is approved",
    anchor: "after_trigger",
    taskTitle: "Collect payment",
  },
};

export const LIFECYCLE_SECTION_LABELS: Record<LifecycleSection, string> = {
  tours: "Tours",
  applications: "Applications",
  leases: "Leases",
  payments: "Payments",
};

export const LIFECYCLE_SECTIONS: LifecycleSection[] = ["tours", "applications", "leases", "payments"];

export const MINUTE = 1;
export const HOUR = 60;
export const DAY = 24 * 60;

/** Below 5 minutes a deadline lands before the manager has seen the task. */
export const MIN_OFFSET_MINUTES = 5;
/** 30 days. Past this it is not a deadline, it is a someday list. */
export const MAX_OFFSET_MINUTES = 30 * DAY;

/** Offered in Settings. A stored value outside these is still honoured if clamped. */
export const OFFSET_PRESETS = [
  10 * MINUTE,
  15 * MINUTE,
  30 * MINUTE,
  1 * HOUR,
  3 * HOUR,
  6 * HOUR,
  1 * DAY,
  2 * DAY,
  3 * DAY,
  7 * DAY,
] as const;

/** Reminder emails before the task due time — offered in Tasks settings. */
export const TASK_REMINDER_TIMING_PRESETS = [10, 15, 30, 60, 120, 1440] as const;

export function normalizeTaskReminderMinutesBeforeList(raw: unknown, fallback: number[]): number[] {
  if (!Array.isArray(raw)) return [...fallback];
  const out = raw
    .filter((n): n is number => typeof n === "number" && Number.isFinite(n))
    .map((n) => Math.round(n))
    .filter((n) => n >= 5 && n <= 1440);
  return [...new Set(out)].sort((a, b) => a - b);
}

export function formatTaskReminderTimingLabel(minutes: number): string {
  if (minutes < 60) return `${minutes} minutes before due`;
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  if (remainder === 0) return `${hours} hour${hours === 1 ? "" : "s"} before due`;
  return `${hours}h ${remainder}m before due`;
}

export function clampOffsetMinutes(value: number): number {
  if (!Number.isFinite(value)) return MIN_OFFSET_MINUTES;
  return Math.max(MIN_OFFSET_MINUTES, Math.min(MAX_OFFSET_MINUTES, Math.round(value)));
}

/**
 * Defaults chosen from how each hand-off actually fails.
 *
 * A tour request goes cold in hours, so it gets an hour. An application is a
 * considered decision, so it gets days. Preparing for a tour is only useful
 * while there is still time to act, so it sits three hours ahead of the visit.
 */
export const DEFAULT_LIFECYCLE_AUTOMATION: LifecycleTaskAutomation = {
  approve_tour_request: {
    enabled: true,
    offsetMinutes: 1 * HOUR,
    defaultAssigneeUserId: null,
    sendEmailReminder: true,
    reminderMinutesBeforeList: [],
  },
  prepare_for_tour: {
    enabled: true,
    offsetMinutes: 3 * HOUR,
    defaultAssigneeUserId: null,
    sendEmailReminder: true,
    reminderMinutesBeforeList: [60],
  },
  review_application: {
    enabled: true,
    offsetMinutes: 1 * DAY,
    defaultAssigneeUserId: null,
    sendEmailReminder: true,
    reminderMinutesBeforeList: [],
  },
  decide_application: {
    enabled: true,
    offsetMinutes: 2 * DAY,
    defaultAssigneeUserId: null,
    sendEmailReminder: true,
    reminderMinutesBeforeList: [],
  },
  review_and_send_lease: {
    enabled: true,
    offsetMinutes: 2 * DAY,
    defaultAssigneeUserId: null,
    sendEmailReminder: true,
    reminderMinutesBeforeList: [],
  },
  countersign_lease: {
    enabled: true,
    offsetMinutes: 1 * DAY,
    defaultAssigneeUserId: null,
    sendEmailReminder: true,
    reminderMinutesBeforeList: [],
  },
  collect_rent: {
    enabled: true,
    offsetMinutes: 3 * DAY,
    defaultAssigneeUserId: null,
    sendEmailReminder: true,
    reminderMinutesBeforeList: [],
  },
};

/** "1 hour", "3 hours", "2 days", "30 minutes". */
export function formatOffset(minutes: number): string {
  const value = clampOffsetMinutes(minutes);
  if (value % DAY === 0) {
    const days = value / DAY;
    return `${days} ${days === 1 ? "day" : "days"}`;
  }
  if (value % HOUR === 0) {
    const hours = value / HOUR;
    return `${hours} ${hours === 1 ? "hour" : "hours"}`;
  }
  return `${value} ${value === 1 ? "minute" : "minutes"}`;
}

/** The whole rule as one sentence, for a Settings row summary. */
export function describeLifecycleRule(key: LifecycleTaskKey, config: LifecycleTaskConfig): string {
  if (!config.enabled) return "Off";
  const meta = LIFECYCLE_TASK_META[key];
  return meta.anchor === "before_event"
    ? `Due ${formatOffset(config.offsetMinutes)} before ${meta.triggerLabel}`
    : `Due ${formatOffset(config.offsetMinutes)} after ${meta.triggerLabel}`;
}

function normalizeConfig(raw: unknown, fallback: LifecycleTaskConfig): LifecycleTaskConfig {
  const row = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  // Accept the legacy day-granularity field so a manager who configured the old
  // application automation keeps their intent instead of silently reverting to
  // a default they never chose.
  const legacyDays =
    typeof row.daysAfterTrigger === "number" && Number.isFinite(row.daysAfterTrigger)
      ? row.daysAfterTrigger * DAY
      : null;
  const offsetRaw =
    typeof row.offsetMinutes === "number" && Number.isFinite(row.offsetMinutes)
      ? row.offsetMinutes
      : (legacyDays ?? fallback.offsetMinutes);
  const assignee = typeof row.defaultAssigneeUserId === "string" ? row.defaultAssigneeUserId.trim() : "";
  return {
    enabled: typeof row.enabled === "boolean" ? row.enabled : fallback.enabled,
    offsetMinutes: clampOffsetMinutes(offsetRaw),
    defaultAssigneeUserId: assignee || null,
    sendEmailReminder:
      typeof row.sendEmailReminder === "boolean" ? row.sendEmailReminder : fallback.sendEmailReminder,
    reminderMinutesBeforeList: normalizeTaskReminderMinutesBeforeList(
      row.reminderMinutesBeforeList,
      fallback.reminderMinutesBeforeList,
    ),
  };
}

export function normalizeLifecycleAutomation(raw: unknown): LifecycleTaskAutomation {
  const row = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const out = {} as LifecycleTaskAutomation;
  for (const key of LIFECYCLE_TASK_KEYS) {
    out[key] = normalizeConfig(row[key], DEFAULT_LIFECYCLE_AUTOMATION[key]);
  }
  return out;
}

/**
 * The due date a rule produces, or null when there is nothing to schedule.
 *
 * A `before_event` rule needs the event time and returns null when the deadline
 * would already be in the past — a task due before it was created is noise, not
 * a deadline. An `after_trigger` rule always lands in the future by definition.
 */
export function lifecycleDueDate(
  key: LifecycleTaskKey,
  config: LifecycleTaskConfig,
  input: { triggeredAt?: Date; eventAt?: Date | null },
  now: Date = new Date(),
): Date | null {
  if (!config.enabled) return null;
  const meta = LIFECYCLE_TASK_META[key];
  const offsetMs = clampOffsetMinutes(config.offsetMinutes) * 60_000;

  if (meta.anchor === "before_event") {
    const eventMs = input.eventAt?.getTime();
    if (!eventMs || !Number.isFinite(eventMs)) return null;
    const due = new Date(eventMs - offsetMs);
    if (due.getTime() <= now.getTime()) return null;
    return due;
  }

  const from = input.triggeredAt ?? now;
  return new Date(from.getTime() + offsetMs);
}

/** Rules belonging to one Settings section, in journey order. */
export function lifecycleKeysForSection(section: LifecycleSection): LifecycleTaskKey[] {
  return LIFECYCLE_TASK_KEYS.filter((key) => LIFECYCLE_TASK_META[key].section === section);
}
