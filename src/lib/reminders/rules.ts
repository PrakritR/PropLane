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
 * `booking` was deliberately ABSENT until PRP-333, on the reasoning that
 * bookings were a calendar VIEW over the planned events tours come from and so
 * a rule could never fire. That premise no longer holds: a booking is now a
 * real dated stay — an imported channel range on
 * `external_calendar_connections`, or a signed PropLane lease's move-in — and
 * `subjects/bookings.server.ts` sweeps both, so the rule has something to
 * anchor on.
 *
 * It stays MANAGER-side only. A channel iCal feed carries no guest contact (the
 * summary is "Airbnb (Not available)"), so a guest-facing booking reminder
 * would be the very thing the original note warned about: a Settings control
 * that can never send. Adding one is a change to the import, not to this file.
 */
import { normalizeTimings, parseTimingKey, timingSendAt } from "@/lib/reminders/timings";

export const REMINDER_SUBJECT_KINDS = [
  "tour",
  "task",
  "service_order",
  "work_order",
  "application",
  "application_manager",
  "application_post_tour",
  "lease",
  "lease_manager",
  "payment_manager",
  "outgoing_payment",
  "booking",
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
  team: boolean;
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
  /** Co-manager user ids to notify when `audience.team` is on. Empty = all team members. */
  teamUserIds: string[];
  /** Optional custom copy; dispatcher falls back to `renderReminder` when absent. */
  template?: { subject: string; body: string };
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
  application: {
    kind: "application",
    label: "Applications",
    anchorLabel: "the application was started",
    counterpartyLabel: "applicant",
  },
  application_manager: {
    kind: "application_manager",
    label: "Application alerts",
    anchorLabel: "the application was started",
    counterpartyLabel: "applicant",
  },
  application_post_tour: {
    kind: "application_post_tour",
    label: "Post-tour follow-ups",
    anchorLabel: "the tour ended",
    counterpartyLabel: "prospect",
  },
  lease: {
    kind: "lease",
    label: "Leases",
    anchorLabel: "the lease was sent for signature",
    counterpartyLabel: "resident",
  },
  lease_manager: {
    kind: "lease_manager",
    label: "Lease alerts",
    anchorLabel: "the lease needs attention",
    counterpartyLabel: "resident",
  },
  payment_manager: {
    kind: "payment_manager",
    label: "Payment alerts",
    anchorLabel: "the rent due date",
    counterpartyLabel: "resident",
  },
  outgoing_payment: {
    kind: "outgoing_payment",
    label: "Outgoing payments",
    anchorLabel: "the payment due date",
    counterpartyLabel: "payee",
  },
  booking: {
    kind: "booking",
    label: "Bookings",
    anchorLabel: "the guest checks in",
    counterpartyLabel: "guest",
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
    // Guest copies ride the legacy tour-reminder path; this rule is manager-only.
    audience: { manager: true, counterparty: false, team: false },
    teamUserIds: [],
    inbox: true,
    email: true,
    sms: false,
  },
  task: {
    enabled: true,
    leadMinutes: [1 * DAY],
    audience: { manager: true, counterparty: true, team: false },
    teamUserIds: [],
    inbox: true,
    email: true,
    sms: false,
  },
  service_order: {
    enabled: true,
    leadMinutes: [1 * DAY, 1 * HOUR],
    audience: { manager: true, counterparty: true, team: false },
    teamUserIds: [],
    inbox: true,
    email: true,
    sms: false,
  },
  work_order: {
    enabled: true,
    leadMinutes: [1 * DAY, 30 * MINUTE],
    audience: { manager: true, counterparty: true, team: false },
    teamUserIds: [],
    inbox: true,
    email: true,
    sms: false,
  },
  application: {
    enabled: true,
    leadMinutes: [3 * DAY, 1 * DAY],
    timings: ["after:1440", "after:4320"],
    audience: { manager: false, counterparty: true, team: false },
    teamUserIds: [],
    inbox: true,
    email: true,
    sms: false,
  },
  application_manager: {
    enabled: true,
    leadMinutes: [7 * DAY, 3 * DAY],
    timings: ["after:4320", "after:10080"],
    audience: { manager: true, counterparty: false, team: false },
    teamUserIds: [],
    inbox: true,
    email: true,
    sms: false,
  },
  application_post_tour: {
    enabled: true,
    leadMinutes: [3 * DAY, 1 * DAY],
    timings: ["after:1440", "after:4320"],
    audience: { manager: false, counterparty: true, team: false },
    teamUserIds: [],
    inbox: true,
    email: true,
    sms: false,
  },
  lease: {
    enabled: true,
    leadMinutes: [3 * DAY, 1 * DAY],
    timings: ["after:1440", "after:4320"],
    audience: { manager: false, counterparty: true, team: false },
    teamUserIds: [],
    inbox: true,
    email: true,
    sms: false,
  },
  lease_manager: {
    enabled: true,
    leadMinutes: [3 * DAY, 1 * DAY],
    timings: ["after:1440", "after:4320"],
    audience: { manager: true, counterparty: false, team: false },
    teamUserIds: [],
    inbox: true,
    email: true,
    sms: false,
  },
  payment_manager: {
    enabled: true,
    leadMinutes: [3 * DAY, 1 * DAY],
    timings: ["after:1440", "after:4320"],
    audience: { manager: true, counterparty: false, team: false },
    teamUserIds: [],
    inbox: true,
    email: true,
    sms: false,
  },
  outgoing_payment: {
    enabled: true,
    leadMinutes: [3 * DAY, 1 * DAY],
    timings: ["before:4320", "before:1440"],
    // team defaults OFF, as every other subject does. A bill reminder carries
    // payee, amount, due date and property — the accounts-payable data the read
    // API hands to no co-manager at all — so a broad audience has to be a
    // deliberate choice, never something a manager inherits by not looking.
    audience: { manager: true, counterparty: false, team: false },
    teamUserIds: [],
    inbox: true,
    email: true,
    sms: false,
  },
  booking: {
    enabled: true,
    // A stay is prepared for over days — keys, cleaning, a room turn — not
    // minutes, so the lead times sit further out than a tour's.
    leadMinutes: [3 * DAY, 1 * DAY],
    timings: ["before:4320", "before:1440"],
    // Manager-side only: an imported channel booking carries no guest contact,
    // so `counterparty` has nobody to reach. See the note at the top of this file.
    audience: { manager: true, counterparty: false, team: false },
    teamUserIds: [],
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

function normalizeTeamUserIds(raw: unknown, fallback: readonly string[]): string[] {
  if (!Array.isArray(raw)) return [...fallback];
  const ids = raw
    .filter((value): value is string => typeof value === "string")
    .map((value) => value.trim())
    .filter(Boolean);
  return [...new Set(ids)];
}

function normalizeTemplate(
  raw: unknown,
  fallback: ReminderRule["template"],
): ReminderRule["template"] {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return fallback;
  const row = raw as Record<string, unknown>;
  const subject = typeof row.subject === "string" ? row.subject.trim() : "";
  const body = typeof row.body === "string" ? row.body.trim() : "";
  if (!subject && !body) return fallback;
  return { subject, body };
}

export function normalizeRule(raw: unknown, fallback: ReminderRule): ReminderRule {
  const row = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const audienceRaw =
    row.audience && typeof row.audience === "object" && !Array.isArray(row.audience)
      ? (row.audience as Record<string, unknown>)
      : {};
  const timings = Array.isArray(row.timings)
    ? normalizeTimings(row.timings, fallback.timings ?? [])
    : fallback.timings;
  const template = normalizeTemplate(row.template, fallback.template);

  const normalized: ReminderRule = {
    enabled: normalizeBoolean(row.enabled, fallback.enabled),
    leadMinutes: normalizeLeadMinutesList(row.leadMinutes, fallback.leadMinutes),
    audience: {
      manager: normalizeBoolean(audienceRaw.manager, fallback.audience.manager),
      counterparty: normalizeBoolean(audienceRaw.counterparty, fallback.audience.counterparty),
      team: normalizeBoolean(audienceRaw.team, fallback.audience.team),
    },
    teamUserIds: normalizeTeamUserIds(row.teamUserIds, fallback.teamUserIds),
    inbox: normalizeBoolean(row.inbox, fallback.inbox),
    email: normalizeBoolean(row.email, fallback.email),
    sms: normalizeBoolean(row.sms, fallback.sms),
  };
  if (timings) normalized.timings = timings;
  if (template) normalized.template = template;
  return normalized;
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
  return { rules: migrateLegacyReminderRules(rules), quietHours: normalizeQuietHours(row.quietHours) };
}

/**
 * Split the old combined application rule (manager + applicant on one toggle) into
 * separate applicant, manager-alert, and post-tour rules on read.
 */
function migrateLegacyReminderRules(rules: ReminderRules): ReminderRules {
  const application = rules.application;
  if (application.audience.manager && application.audience.counterparty) {
    rules.application_manager = normalizeRule(
      {
        enabled: application.enabled,
        leadMinutes: application.leadMinutes,
        timings: application.timings,
        audience: { manager: true, counterparty: false, team: application.audience.team },
        teamUserIds: application.teamUserIds,
        template: application.template,
        inbox: application.inbox,
        email: application.email,
        sms: application.sms,
      },
      DEFAULT_REMINDER_RULES.application_manager,
    );
    rules.application = normalizeRule(
      {
        ...application,
        audience: { manager: false, counterparty: true, team: false },
      },
      DEFAULT_REMINDER_RULES.application,
    );
  }

  const lease = rules.lease;
  if (lease.audience.manager && lease.audience.counterparty) {
    rules.lease_manager = normalizeRule(
      {
        enabled: lease.enabled,
        leadMinutes: lease.leadMinutes,
        timings: lease.timings,
        audience: { manager: true, counterparty: false, team: lease.audience.team },
        teamUserIds: lease.teamUserIds,
        template: lease.template,
        inbox: lease.inbox,
        email: lease.email,
        sms: lease.sms,
      },
      DEFAULT_REMINDER_RULES.lease_manager,
    );
    rules.lease = normalizeRule(
      {
        ...lease,
        audience: { manager: false, counterparty: true, team: false },
      },
      DEFAULT_REMINDER_RULES.lease,
    );
  }

  return rules;
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

  const anchor = new Date(anchorMs);
  const out: { leadMinutes: number; sendAt: Date }[] = [];

  const timingKeys = rule.timings?.length ? rule.timings : null;
  if (timingKeys) {
    for (const key of timingKeys) {
      const timing = parseTimingKey(key);
      if (!timing) continue;
      const raw = timingSendAt(timing, anchor);
      const sendAt = applyQuietHours(raw, quietHours);
      if (timing.direction === "before" && sendAt.getTime() >= anchorMs) continue;
      if (timing.direction === "after" && sendAt.getTime() <= anchorMs) continue;
      if (sendAt.getTime() <= now.getTime()) continue;
      const leadMinutes = timing.direction === "before" ? timing.minutes : -timing.minutes;
      out.push({ leadMinutes, sendAt });
    }
    return out.sort((a, b) => a.sendAt.getTime() - b.sendAt.getTime());
  }

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
