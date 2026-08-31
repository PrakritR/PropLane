/**
 * Per-manager reminder rules — the configurable half of the reminder spine.
 *
 * Stored in `manager_automation_settings.row_data.reminderRules`, beside
 * `taskAutomation` and `applicationAutomation`, so this needs no schema
 * migration and no second settings store.
 *
 * A rule answers three questions for one kind of thing that can be reminded
 * about: is it on, how far ahead do we send, and who hears about it. The
 * dispatcher (`queue.server.ts`) is the only sender; this file is pure so the
 * Settings UI can import it in the browser.
 *
 * Lead times are MINUTES throughout, including "1 day" (1440). Payments and
 * tours historically used two different units — days for one, minutes for the
 * other — which is why a single reminder could not be expressed for both. One
 * unit is what lets the same control drive every subject.
 */

/**
 * Bookings are deliberately absent: they are a calendar VIEW over the same
 * planned events tours come from, not a record type of their own, so a
 * "Bookings" rule could never fire. A Settings row that can never do anything
 * is worse than no row at all.
 */
import { normalizeTimings } from "@/lib/reminders/timings";

export const REMINDER_SUBJECT_KINDS = [
  "tour",
  "task",
  "service_order",
  "work_order",
] as const;

export type ReminderSubjectKind = (typeof REMINDER_SUBJECT_KINDS)[number];

/**
 * Who a reminder reaches.
 *
 * `counterparty` is the person outside the management company — the tour
 * guest, the resident whose service visit it is, the vendor assigned the work
 * order. `manager` is the assignee/owner inside it. Both are independently
 * switchable because "remind the resident but not me" and "remind me but do
 * not bother the resident" are both real preferences.
 */
export type ReminderAudience = {
  manager: boolean;
  counterparty: boolean;
};

export type ReminderRule = {
  enabled: boolean;
  /** Minutes before the anchor moment. Sorted furthest-out first, deduped. */
  leadMinutes: number[];
  /**
   * Directional timings ("before:1440", "after:15"). Supersedes `leadMinutes`,
   * which could only count backwards — so "15 minutes after submitted" was
   * inexpressible. `leadMinutes` is kept so a rule saved before directions
   * existed still resolves instead of reading as an empty selection.
   */
  timings?: string[];
  audience: ReminderAudience;
  /**
   * Delivery channels.
   *
   * `inbox` is the in-house Communication thread — the place a person already
   * reads and replies — and `email` mirrors it outward. Both ship on by default
   * and are delivered by one call, so a recipient's own notification
   * preferences still gate the outward copy. `sms` rides the same path and is
   * reserved for when a work number is wired.
   */
  inbox: boolean;
  email: boolean;
  sms: boolean;
};

export type ReminderRules = Record<ReminderSubjectKind, ReminderRule>;

/**
 * Quiet hours, per manager, in the manager's local wall clock.
 *
 * A sub-daily dispatcher makes 3 a.m. mail possible for the first time — the
 * old once-a-day crons could not produce it. A send that lands inside the
 * window is pushed forward to `endHour`, never dropped: a late reminder is
 * recoverable, a silently discarded one is not.
 */
export type QuietHours = {
  enabled: boolean;
  /** Inclusive start hour, 0-23. */
  startHour: number;
  /** Exclusive end hour, 0-23. */
  endHour: number;
};

export type ReminderSettings = {
  rules: ReminderRules;
  quietHours: QuietHours;
};

/** Floor: below five minutes a reminder cannot beat its own dispatch tick. */
export const MIN_LEAD_MINUTES = 5;
/** Ceiling: 30 days. Beyond this a "reminder" is really a scheduled campaign. */
export const MAX_LEAD_MINUTES = 30 * 24 * 60;
/** More than this many per subject is a mailing list, not a reminder. */
export const MAX_LEADS_PER_RULE = 6;

export const MINUTE = 1;
export const HOUR = 60;
export const DAY = 24 * 60;

/** Offered in the Settings picker. A manager may still store any clamped value. */
export const LEAD_MINUTE_PRESETS = [
  15 * MINUTE,
  30 * MINUTE,
  1 * HOUR,
  2 * HOUR,
  4 * HOUR,
  1 * DAY,
  2 * DAY,
  3 * DAY,
  7 * DAY,
] as const;

export function clampLeadMinutes(value: number): number {
  if (!Number.isFinite(value)) return MIN_LEAD_MINUTES;
  return Math.max(MIN_LEAD_MINUTES, Math.min(MAX_LEAD_MINUTES, Math.round(value)));
}

/**
 * Clamp, dedupe, and order a lead-time list furthest-out first.
 *
 * Order is load-bearing rather than cosmetic: the dispatcher walks the list to
 * decide which reminders are still in the future, and the Settings summary
 * reads "1 day, 30 minutes before" the way a person would say it.
 */
export function normalizeLeadMinutesList(raw: unknown, fallback: readonly number[]): number[] {
  const source = Array.isArray(raw) ? raw : [];
  const cleaned = source
    .map((value) => clampLeadMinutes(Number(value)))
    .filter((value) => Number.isFinite(value));
  const unique = [...new Set(cleaned.length > 0 ? cleaned : fallback.map(clampLeadMinutes))];
  return unique.sort((a, b) => b - a).slice(0, MAX_LEADS_PER_RULE);
}

/** "15 minutes before", "1 hour before", "2 days before". */
export function formatLeadLabel(minutes: number): string {
  const value = clampLeadMinutes(minutes);
  if (value % DAY === 0) {
    const days = value / DAY;
    return `${days} ${days === 1 ? "day" : "days"} before`;
  }
  if (value % HOUR === 0) {
    const hours = value / HOUR;
    return `${hours} ${hours === 1 ? "hour" : "hours"} before`;
  }
  return `${value} ${value === 1 ? "minute" : "minutes"} before`;
}

/** "1 day, 30 minutes before" — one line for a Settings row summary. */
export function formatLeadSummary(leadMinutes: readonly number[]): string {
  if (leadMinutes.length === 0) return "No reminders";
  const parts = leadMinutes.map((minutes) => formatLeadLabel(minutes).replace(/ before$/, ""));
  return `${parts.join(", ")} before`;
}

export type ReminderSubjectMeta = {
  kind: ReminderSubjectKind;
  label: string;
  /** What the lead time counts back from, in the manager's words. */
  anchorLabel: string;
  /** Who `counterparty` means for this subject. */
  counterpartyLabel: string;
};

export const REMINDER_SUBJECT_META: Record<ReminderSubjectKind, ReminderSubjectMeta> = {
  tour: {
    kind: "tour",
    label: "Tours",
    anchorLabel: "the tour start time",
    counterpartyLabel: "guest",
  },
  task: {
    kind: "task",
    label: "Tasks",
    anchorLabel: "the task due date",
    counterpartyLabel: "assignee",
  },
  service_order: {
    kind: "service_order",
    label: "Service orders",
    anchorLabel: "the scheduled service date",
    counterpartyLabel: "resident",
  },
  work_order: {
    kind: "work_order",
    label: "Work orders",
    anchorLabel: "the maintenance visit",
    counterpartyLabel: "resident and vendor",
  },
};

/**
 * Defaults chosen to match how each thing actually goes wrong.
 *
 * A tour is missed by minutes, so it gets a same-hour nudge; a task is missed
 * by a day, so it does not. A booking is planned for, so its reminders sit days
 * out. `sms` is false everywhere because no SMS adapter is wired yet — the
 * field exists so adding one later is a delivery change, not a schema change.
 */
export const DEFAULT_REMINDER_RULES: ReminderRules = {
  tour: {
    enabled: true,
    leadMinutes: [1 * DAY, 30 * MINUTE],
    audience: { manager: true, counterparty: true },
    inbox: true,
    email: true,
    sms: false,
  },
  task: {
    enabled: true,
    leadMinutes: [1 * DAY],
    audience: { manager: false, counterparty: true },
    inbox: true,
    email: true,
    sms: false,
  },
  service_order: {
    enabled: true,
    leadMinutes: [1 * DAY, 1 * HOUR],
    audience: { manager: true, counterparty: true },
    inbox: true,
    email: true,
    sms: false,
  },
  work_order: {
    enabled: true,
    leadMinutes: [1 * DAY, 30 * MINUTE],
    audience: { manager: false, counterparty: true },
    inbox: true,
    email: true,
    sms: false,
  },
};

export const DEFAULT_QUIET_HOURS: QuietHours = {
  enabled: true,
  startHour: 21,
  endHour: 8,
};

export const DEFAULT_REMINDER_SETTINGS: ReminderSettings = {
  rules: DEFAULT_REMINDER_RULES,
  quietHours: DEFAULT_QUIET_HOURS,
};

function normalizeBoolean(raw: unknown, fallback: boolean): boolean {
  return typeof raw === "boolean" ? raw : fallback;
}

function normalizeHour(raw: unknown, fallback: number): number {
  if (typeof raw !== "number" || !Number.isFinite(raw)) return fallback;
  const rounded = Math.round(raw);
  if (rounded < 0 || rounded > 23) return fallback;
  return rounded;
}

function normalizeRule(raw: unknown, fallback: ReminderRule): ReminderRule {
  const row = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const audienceRaw =
    row.audience && typeof row.audience === "object" && !Array.isArray(row.audience)
      ? (row.audience as Record<string, unknown>)
      : {};
  return {
    enabled: normalizeBoolean(row.enabled, fallback.enabled),
    leadMinutes: normalizeLeadMinutesList(row.leadMinutes, fallback.leadMinutes),
    audience: {
      manager: normalizeBoolean(audienceRaw.manager, fallback.audience.manager),
      counterparty: normalizeBoolean(audienceRaw.counterparty, fallback.audience.counterparty),
    },
    timings: Array.isArray(row.timings)
      ? normalizeTimings(row.timings, [])
      : fallback.timings,
    inbox: normalizeBoolean(row.inbox, fallback.inbox),
    email: normalizeBoolean(row.email, fallback.email),
    sms: normalizeBoolean(row.sms, fallback.sms),
  };
}

export function normalizeQuietHours(raw: unknown): QuietHours {
  const row = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const startHour = normalizeHour(row.startHour, DEFAULT_QUIET_HOURS.startHour);
  const endHour = normalizeHour(row.endHour, DEFAULT_QUIET_HOURS.endHour);
  return {
    // A zero-length window silences nothing, so treat it as off rather than
    // storing a rule that reads as enabled but never applies.
    enabled: normalizeBoolean(row.enabled, DEFAULT_QUIET_HOURS.enabled) && startHour !== endHour,
    startHour,
    endHour,
  };
}

export function normalizeReminderSettings(raw: unknown): ReminderSettings {
  const row = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const rulesRaw =
    row.rules && typeof row.rules === "object" && !Array.isArray(row.rules)
      ? (row.rules as Record<string, unknown>)
      : {};
  const rules = {} as ReminderRules;
  for (const kind of REMINDER_SUBJECT_KINDS) {
    rules[kind] = normalizeRule(rulesRaw[kind], DEFAULT_REMINDER_RULES[kind]);
  }
  return { rules, quietHours: normalizeQuietHours(row.quietHours) };
}

/** Is `hour` inside the quiet window? Handles a window that wraps midnight. */
export function isQuietHour(quietHours: QuietHours, hour: number): boolean {
  if (!quietHours.enabled) return false;
  const { startHour, endHour } = quietHours;
  if (startHour === endHour) return false;
  // 21 -> 8 wraps midnight: quiet when at/after 21 OR before 8.
  if (startHour > endHour) return hour >= startHour || hour < endHour;
  return hour >= startHour && hour < endHour;
}

/**
 * Push a send time forward out of the quiet window.
 *
 * Deliberately forward-only. Sending a 7 a.m. reminder early at 6 a.m. to dodge
 * a window would defeat the point of the window; delaying it to 8 a.m. keeps
 * the message but respects the hour. A reminder whose anchor has already passed
 * is the dispatcher's problem, not this function's.
 */
export function applyQuietHours(sendAt: Date, quietHours: QuietHours): Date {
  if (!isQuietHour(quietHours, sendAt.getHours())) return sendAt;
  const out = new Date(sendAt);
  // Walk hour by hour rather than jumping, so a window that wraps midnight
  // lands on the correct day without date arithmetic special cases.
  for (let i = 0; i < 24; i += 1) {
    out.setHours(out.getHours() + 1, 0, 0, 0);
    if (!isQuietHour(quietHours, out.getHours())) return out;
  }
  return sendAt;
}

/**
 * The send times a rule produces for one anchor, soonest first, future only.
 *
 * Returns `[]` for a disabled rule, a rule with no channel, an unparseable
 * anchor, or an anchor already past — every "nothing to schedule" case funnels
 * to one empty result so callers need no special-casing.
 */
export function reminderSendTimes(
  rule: ReminderRule,
  anchorIso: string,
  quietHours: QuietHours = DEFAULT_QUIET_HOURS,
  now: Date = new Date(),
): { leadMinutes: number; sendAt: Date }[] {
  if (!rule.enabled) return [];
  if (!rule.inbox && !rule.email && !rule.sms) return [];
  const anchorMs = new Date(anchorIso).getTime();
  if (!Number.isFinite(anchorMs)) return [];

  const out: { leadMinutes: number; sendAt: Date }[] = [];
  for (const leadMinutes of rule.leadMinutes) {
    const raw = new Date(anchorMs - leadMinutes * 60_000);
    const sendAt = applyQuietHours(raw, quietHours);
    // Quiet hours can push a send past the thing it was reminding about; that
    // reminder is no longer a reminder, so it is dropped rather than sent late.
    if (sendAt.getTime() >= anchorMs) continue;
    if (sendAt.getTime() <= now.getTime()) continue;
    out.push({ leadMinutes, sendAt });
  }
  return out.sort((a, b) => a.sendAt.getTime() - b.sendAt.getTime());
}

/**
 * Stable identity for one reminder.
 *
 * The dispatcher enforces this as a unique key, so re-materializing a subject
 * (a tour edited twice, a cron overlapping itself) can never queue a duplicate.
 * Recipient is part of the key because the manager and the guest each get their
 * own copy of the same reminder.
 */
export function reminderDedupeKey(input: {
  kind: ReminderSubjectKind;
  subjectId: string;
  leadMinutes: number;
  recipient: string;
}): string {
  const recipient = input.recipient.trim().toLowerCase();
  return `${input.kind}:${input.subjectId.trim()}:${input.leadMinutes}:${recipient}`;
}
