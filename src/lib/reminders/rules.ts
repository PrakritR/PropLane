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
  "tour_interest",
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
  "inspection",
  "inspection_manager",
  // ---- Services: escalations and the vendor loop (PLAN-0915) ----
  "work_order_unassigned",
  "work_order_unassigned_emergency",
  "work_order_no_on_my_way",
  "vendor_offer_expiry",
  "vendor_invoice_nudge",
  "invoice_approval",
  "service_request_decision",
  "service_request_unpaid",
  "vendor_document_expiry",
  // ---- Leases, move-in, move-out ----
  "lease_ending",
  "lease_ending_manager",
  "renewal_offer_expiry",
  "countersign_overdue",
  "move_in",
  "move_in_payment_method",
  "move_out",
  "move_out_inspection_manager",
  "deposit_accounting",
  // ---- Applications ----
  "application_documents",
  "application_decision_manager",
  "application_no_lease_manager",
  "cosigner",
  "group_application",
  // ---- Tours ----
  "tour_request_unanswered",
  "tour_request_reoffer",
  "tour_no_show_manager",
  "tour_feedback",
  // ---- Payments, communication, documents, tasks, residents, inspections ----
  "delinquency_manager",
  "message_unanswered",
  "document_signature",
  "task_overdue",
  "resident_welcome",
  "inspection_acknowledge",
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
  /**
   * The vendor dispatched to the work. Only service kinds render a control for
   * it; every other kind normalises it to `false` so a saved rule from before
   * vendors were an audience keeps meaning exactly what it did.
   */
  vendor: boolean;
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
/** Ceiling: 90 days, so a lease-ending notice can fire at 90 and 60. Beyond this a "reminder" is really a scheduled campaign. */
export const MAX_LEAD_MINUTES = 90 * 24 * 60;
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

/**
 * Kinds whose rule may fan out to the dispatched vendor. Everything else
 * normalises `audience.vendor` to false, so the control never appears on a
 * subject that has nobody to reach.
 */
export const VENDOR_AUDIENCE_KINDS: ReadonlySet<ReminderSubjectKind> = new Set<ReminderSubjectKind>([
  "work_order",
  "vendor_offer_expiry",
  "vendor_invoice_nudge",
  "vendor_document_expiry",
]);

/**
 * Kinds that must not wait for quiet hours to end. An emergency that is still
 * unassigned at 2 a.m. is exactly the thing the manager wants woken for; the
 * `applyQuietHours` push-forward is skipped for these and nothing else.
 */
export const URGENT_REMINDER_KINDS: ReadonlySet<ReminderSubjectKind> = new Set<ReminderSubjectKind>([
  "work_order_unassigned_emergency",
]);

/** Kinds whose control is a single row (toggle + one timing) rather than the full panel. */
export const COMPACT_RULE_KINDS: ReadonlySet<ReminderSubjectKind> = new Set<ReminderSubjectKind>([
  "work_order_unassigned",
  "work_order_unassigned_emergency",
  "work_order_no_on_my_way",
  "vendor_offer_expiry",
  "vendor_invoice_nudge",
  "invoice_approval",
  "service_request_decision",
  "service_request_unpaid",
  "vendor_document_expiry",
  "lease_ending",
  "lease_ending_manager",
  "renewal_offer_expiry",
  "countersign_overdue",
  "move_in",
  "move_in_payment_method",
  "move_out",
  "move_out_inspection_manager",
  "deposit_accounting",
  "application_documents",
  "application_decision_manager",
  "application_no_lease_manager",
  "cosigner",
  "group_application",
  "tour_request_unanswered",
  "tour_request_reoffer",
  "tour_no_show_manager",
  "tour_feedback",
  "delinquency_manager",
  "message_unanswered",
  "document_signature",
  "task_overdue",
  "resident_welcome",
  "inspection_acknowledge",
]);

type RuleShape = {
  enabled?: boolean;
  timings: string[];
  audience: Partial<ReminderAudience>;
  email?: boolean;
  sms?: boolean;
};

/** One place for the shape every new rule shares, so a default reads as a sentence. */
function rule(shape: RuleShape): ReminderRule {
  const leadMinutes = shape.timings
    .map((key) => parseTimingKey(key))
    .filter((timing): timing is NonNullable<typeof timing> => Boolean(timing))
    .map((timing) => timing.minutes);
  // Pre-normalised: furthest-out first, deduped — the same order
  // `normalizeLeadMinutesList` produces, so defaults round-trip unchanged.
  const ordered = [...new Set(leadMinutes)].sort((a, b) => b - a);
  return {
    enabled: shape.enabled ?? true,
    leadMinutes: ordered.length ? ordered : [DAY],
    timings: shape.timings,
    audience: { manager: false, counterparty: false, team: false, vendor: false, ...shape.audience },
    teamUserIds: [],
    inbox: true,
    email: shape.email ?? true,
    sms: shape.sms ?? false,
  };
}

const MANAGER = { manager: true } as const;
const COUNTERPARTY = { counterparty: true } as const;
const VENDOR = { vendor: true } as const;

/**
 * Defaults for the PLAN-0915 kinds. Escalations are anchored on "created" and
 * count forward; notices count back from the thing they announce. Every one of
 * these is a single-timing row in Settings unless it lists several timings.
 */
const PLAN_0915_DEFAULT_RULES: Omit<
  ReminderRules,
  | "tour" | "tour_interest" | "task" | "service_order" | "work_order" | "application" | "application_manager"
  | "application_post_tour" | "lease" | "lease_manager" | "payment_manager" | "outgoing_payment" | "booking"
  | "inspection" | "inspection_manager"
> = {
  // Services
  work_order_unassigned: rule({ timings: ["after:1440"], audience: MANAGER }),
  work_order_unassigned_emergency: rule({ timings: ["after:60"], audience: MANAGER, sms: true }),
  work_order_no_on_my_way: rule({ enabled: false, timings: ["after:15"], audience: MANAGER }),
  vendor_offer_expiry: rule({ timings: ["before:240"], audience: VENDOR }),
  vendor_invoice_nudge: rule({ timings: ["after:4320"], audience: VENDOR }),
  invoice_approval: rule({ timings: ["after:4320"], audience: MANAGER }),
  service_request_decision: rule({ timings: ["after:2880"], audience: MANAGER }),
  service_request_unpaid: rule({ timings: ["after:4320"], audience: COUNTERPARTY }),
  vendor_document_expiry: rule({ timings: ["before:43200", "before:10080"], audience: { vendor: true, manager: true } }),
  // Leases, move-in, move-out
  // 60 and 30 days would be the natural pair, but the timing ceiling is 30
  // days (`MAX_TIMING_MINUTES`); the lease sweeper raises it for this kind.
  lease_ending: rule({ timings: ["before:86400", "before:43200"], audience: COUNTERPARTY }),
  lease_ending_manager: rule({ timings: ["before:129600", "before:86400", "before:43200"], audience: MANAGER }),
  renewal_offer_expiry: rule({ timings: ["before:4320"], audience: COUNTERPARTY }),
  countersign_overdue: rule({ timings: ["after:2880"], audience: MANAGER }),
  move_in: rule({ timings: ["before:10080", "before:1440"], audience: { counterparty: true, manager: true } }),
  move_in_payment_method: rule({ timings: ["before:7200"], audience: COUNTERPARTY }),
  move_out: rule({ timings: ["before:43200", "before:10080", "before:1440"], audience: COUNTERPARTY }),
  move_out_inspection_manager: rule({ timings: ["before:20160"], audience: MANAGER }),
  deposit_accounting: rule({ timings: ["before:20160", "before:4320"], audience: MANAGER }),
  // Applications
  application_documents: rule({ timings: ["after:2880"], audience: COUNTERPARTY }),
  application_decision_manager: rule({ timings: ["after:4320"], audience: MANAGER }),
  application_no_lease_manager: rule({ timings: ["after:2880"], audience: MANAGER }),
  cosigner: rule({ timings: ["after:2880"], audience: COUNTERPARTY }),
  group_application: rule({ timings: ["after:2880"], audience: COUNTERPARTY }),
  // Tours
  tour_request_unanswered: rule({ timings: ["after:240"], audience: MANAGER }),
  tour_request_reoffer: rule({ timings: ["after:1440"], audience: COUNTERPARTY }),
  tour_no_show_manager: rule({ timings: ["after:30"], audience: MANAGER }),
  tour_feedback: rule({ enabled: false, timings: ["after:120"], audience: COUNTERPARTY }),
  // Payments, communication, documents, tasks, residents, inspections
  delinquency_manager: rule({ timings: ["after:14400"], audience: MANAGER }),
  message_unanswered: rule({ timings: ["after:1440"], audience: MANAGER }),
  document_signature: rule({ timings: ["after:4320"], audience: COUNTERPARTY }),
  task_overdue: rule({ timings: ["after:1440"], audience: { counterparty: true, manager: true } }),
  resident_welcome: rule({ enabled: false, timings: ["after:5", "after:2880", "after:10080"], audience: COUNTERPARTY }),
  inspection_acknowledge: rule({ timings: ["after:7200"], audience: COUNTERPARTY }),
};

const PLAN_0915_SUBJECT_META: Record<keyof typeof PLAN_0915_DEFAULT_RULES, ReminderSubjectMeta> = {
  work_order_unassigned: { kind: "work_order_unassigned", label: "Escalate if unassigned", anchorLabel: "the request was filed", counterpartyLabel: "resident" },
  work_order_unassigned_emergency: { kind: "work_order_unassigned_emergency", label: "Escalate emergency if unassigned", anchorLabel: "the request was filed", counterpartyLabel: "resident" },
  work_order_no_on_my_way: { kind: "work_order_no_on_my_way", label: "Vendor has not tapped On my way", anchorLabel: "the visit window opened", counterpartyLabel: "resident" },
  vendor_offer_expiry: { kind: "vendor_offer_expiry", label: "Offer expiring soon", anchorLabel: "the offer expires", counterpartyLabel: "vendor" },
  vendor_invoice_nudge: { kind: "vendor_invoice_nudge", label: "Invoice nudge to vendor", anchorLabel: "the vendor marked it done", counterpartyLabel: "vendor" },
  invoice_approval: { kind: "invoice_approval", label: "Invoice approval reminder", anchorLabel: "the invoice arrived", counterpartyLabel: "vendor" },
  service_request_decision: { kind: "service_request_decision", label: "Add-on request awaiting decision", anchorLabel: "the request was submitted", counterpartyLabel: "resident" },
  service_request_unpaid: { kind: "service_request_unpaid", label: "Approved but unpaid", anchorLabel: "the request was approved", counterpartyLabel: "resident" },
  vendor_document_expiry: { kind: "vendor_document_expiry", label: "Vendor documents expiring", anchorLabel: "the document expires", counterpartyLabel: "vendor" },
  lease_ending: { kind: "lease_ending", label: "Tell the resident before the lease ends", anchorLabel: "the lease end date", counterpartyLabel: "resident" },
  lease_ending_manager: { kind: "lease_ending_manager", label: "Remind me before a lease ends", anchorLabel: "the lease end date", counterpartyLabel: "resident" },
  renewal_offer_expiry: { kind: "renewal_offer_expiry", label: "Renewal offer expiry reminder", anchorLabel: "the offer expires", counterpartyLabel: "resident" },
  countersign_overdue: { kind: "countersign_overdue", label: "Countersignature overdue", anchorLabel: "the resident signed", counterpartyLabel: "resident" },
  move_in: { kind: "move_in", label: "Move-in reminder", anchorLabel: "the move-in date", counterpartyLabel: "resident" },
  move_in_payment_method: { kind: "move_in_payment_method", label: "Payment method missing before first due", anchorLabel: "the first charge is due", counterpartyLabel: "resident" },
  move_out: { kind: "move_out", label: "Move-out checklist to resident", anchorLabel: "the move-out date", counterpartyLabel: "resident" },
  move_out_inspection_manager: { kind: "move_out_inspection_manager", label: "Remind me to schedule the move-out inspection", anchorLabel: "the move-out date", counterpartyLabel: "resident" },
  deposit_accounting: { kind: "deposit_accounting", label: "Deposit accounting due", anchorLabel: "the deposit deadline", counterpartyLabel: "resident" },
  application_documents: { kind: "application_documents", label: "Documents requested reminder", anchorLabel: "documents were requested", counterpartyLabel: "applicant" },
  application_decision_manager: { kind: "application_decision_manager", label: "Decision reminder", anchorLabel: "the application was submitted", counterpartyLabel: "applicant" },
  application_no_lease_manager: { kind: "application_no_lease_manager", label: "Approved, no lease sent", anchorLabel: "the application was approved", counterpartyLabel: "applicant" },
  cosigner: { kind: "cosigner", label: "Cosigner reminder", anchorLabel: "the cosigner was invited", counterpartyLabel: "cosigner" },
  group_application: { kind: "group_application", label: "Group members outstanding", anchorLabel: "the first member applied", counterpartyLabel: "applicant" },
  tour_request_unanswered: { kind: "tour_request_unanswered", label: "Tour request unanswered", anchorLabel: "the request came in", counterpartyLabel: "guest" },
  tour_request_reoffer: { kind: "tour_request_reoffer", label: "Offer the guest other times", anchorLabel: "the request came in", counterpartyLabel: "guest" },
  tour_no_show_manager: { kind: "tour_no_show_manager", label: "No-show prompt", anchorLabel: "the tour ended", counterpartyLabel: "guest" },
  tour_feedback: { kind: "tour_feedback", label: "Post-tour feedback", anchorLabel: "the tour ended", counterpartyLabel: "guest" },
  delinquency_manager: { kind: "delinquency_manager", label: "Delinquency reminder", anchorLabel: "the rent due date", counterpartyLabel: "resident" },
  message_unanswered: { kind: "message_unanswered", label: "Unanswered message reminder", anchorLabel: "the resident wrote", counterpartyLabel: "resident" },
  document_signature: { kind: "document_signature", label: "Signature reminder", anchorLabel: "the signature was requested", counterpartyLabel: "signer" },
  task_overdue: { kind: "task_overdue", label: "Overdue reminder", anchorLabel: "the task due date", counterpartyLabel: "assignee" },
  resident_welcome: { kind: "resident_welcome", label: "Welcome sequence", anchorLabel: "the account was created", counterpartyLabel: "resident" },
  inspection_acknowledge: { kind: "inspection_acknowledge", label: "Acknowledge reminder", anchorLabel: "the report was shared", counterpartyLabel: "resident" },
};

export type ReminderSubjectMeta = {
  kind: ReminderSubjectKind;
  label: string;
  /** What the lead time counts back from, in the manager's words. */
  anchorLabel: string;
  /** Who `counterparty` means for this subject. */
  counterpartyLabel: string;
};

export const REMINDER_SUBJECT_META: Record<ReminderSubjectKind, ReminderSubjectMeta> = {
  ...PLAN_0915_SUBJECT_META,
  inspection: { kind: "inspection", label: "Room photos", anchorLabel: "the move-in or move-out date", counterpartyLabel: "resident" },
  inspection_manager: { kind: "inspection_manager", label: "Missing room photos", anchorLabel: "the move-in or move-out date", counterpartyLabel: "resident" },
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
    counterpartyLabel: "resident",
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
  tour_interest: { kind: "tour_interest", label: "Tour interest follow-up", anchorLabel: "your tour response", counterpartyLabel: "prospect" },
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
  ...PLAN_0915_DEFAULT_RULES,
  // BOTH sides by default: a move-in or move-out condition report is somebody's job on the
  // day, and if only the resident is reminded nobody in the office knows it was missed.
  inspection: { enabled: true, leadMinutes: [DAY], timings: ["before:1440", "after:1440", "after:10080"], audience: { manager: true, counterparty: true, team: false, vendor: false }, teamUserIds: [], inbox: true, email: true, sms: false },
  // Anchored on the move date now, not on a report edit: the manager is told when the day is
  // here and nobody has photographed the room.
  inspection_manager: { enabled: true, leadMinutes: [DAY], timings: ["after:1440", "after:10080"], audience: { manager: true, counterparty: false, team: false, vendor: false }, teamUserIds: [], inbox: true, email: true, sms: false },
  tour: {
    enabled: true,
    leadMinutes: [1 * DAY, 30 * MINUTE],
    // Guest copies ride the legacy tour-reminder path; this rule is manager-only.
    audience: { manager: true, counterparty: false, team: false, vendor: false },
    teamUserIds: [],
    inbox: true,
    email: true,
    sms: false,
  },
  task: {
    enabled: true,
    leadMinutes: [1 * DAY],
    audience: { manager: true, counterparty: true, team: false, vendor: false },
    teamUserIds: [],
    inbox: true,
    email: true,
    sms: false,
  },
  service_order: {
    enabled: true,
    leadMinutes: [1 * DAY, 1 * HOUR],
    audience: { manager: true, counterparty: true, team: false, vendor: false },
    teamUserIds: [],
    inbox: true,
    email: true,
    sms: false,
  },
  work_order: {
    enabled: true,
    leadMinutes: [1 * DAY, 30 * MINUTE],
    // The vendor is reminded of their own visit by default: before PLAN-0915
    // a vendor heard about a visit once, when it was booked, and never again.
    audience: { manager: true, counterparty: true, team: false, vendor: true },
    teamUserIds: [],
    inbox: true,
    email: true,
    sms: false,
  },
  application: {
    enabled: true,
    leadMinutes: [3 * DAY, 1 * DAY],
    timings: ["after:1440", "after:4320"],
    audience: { manager: false, counterparty: true, team: false, vendor: false },
    teamUserIds: [],
    inbox: true,
    email: true,
    sms: false,
  },
  application_manager: {
    enabled: true,
    leadMinutes: [7 * DAY, 3 * DAY],
    timings: ["after:4320", "after:10080"],
    audience: { manager: true, counterparty: false, team: false, vendor: false },
    teamUserIds: [],
    inbox: true,
    email: true,
    sms: false,
  },
  tour_interest: {
    enabled: false, leadMinutes: [1440], timings: ["after:1440"],
    audience: { manager: false, counterparty: true, team: false, vendor: false }, teamUserIds: [],
    inbox: true, email: false, sms: true,
  },
  application_post_tour: {
    enabled: true,
    leadMinutes: [3 * DAY, 1 * DAY],
    timings: ["after:1440", "after:4320"],
    audience: { manager: false, counterparty: true, team: false, vendor: false },
    teamUserIds: [],
    inbox: true,
    email: true,
    sms: false,
  },
  lease: {
    enabled: true,
    leadMinutes: [3 * DAY, 1 * DAY],
    timings: ["after:1440", "after:4320"],
    audience: { manager: false, counterparty: true, team: false, vendor: false },
    teamUserIds: [],
    inbox: true,
    email: true,
    sms: false,
  },
  lease_manager: {
    enabled: true,
    leadMinutes: [3 * DAY, 1 * DAY],
    timings: ["after:1440", "after:4320"],
    audience: { manager: true, counterparty: false, team: false, vendor: false },
    teamUserIds: [],
    inbox: true,
    email: true,
    sms: false,
  },
  payment_manager: {
    enabled: true,
    leadMinutes: [3 * DAY, 1 * DAY],
    timings: ["after:1440", "after:4320"],
    audience: { manager: true, counterparty: false, team: false, vendor: false },
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
    audience: { manager: true, counterparty: false, team: false, vendor: false },
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
    audience: { manager: true, counterparty: false, team: false, vendor: false },
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

export function normalizeRule(raw: unknown, fallback: ReminderRule, kind?: ReminderSubjectKind): ReminderRule {
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
      // Without a kind (a caller normalising a bare rule) the fallback decides
      // whether a vendor audience is even possible.
      vendor: (kind ? VENDOR_AUDIENCE_KINDS.has(kind) : fallback.audience.vendor)
        ? normalizeBoolean(audienceRaw.vendor, fallback.audience.vendor)
        : false,
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
    rules[kind] = normalizeRule(rulesRaw[kind], DEFAULT_REMINDER_RULES[kind], kind);
    // Keeps stored settings equal to what the dispatcher actually does: these
    // fields are hardcoded in `subjects/tour-interest.server.ts` and can never
    // be honoured from a saved rule. See `fixed-rule-fields.ts` for the
    // declaration this overwrite must match, and its reason — the Settings UI
    // marks these fields read-only rather than letting them silently revert.
    if (kind === "tour_interest") rules[kind] = {
      ...rules[kind], leadMinutes: [1440], timings: ["after:1440"],
      audience: { manager: false, counterparty: true, team: false, vendor: false }, teamUserIds: [],
      inbox: true, email: false, sms: true,
    };
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
        audience: { manager: true, counterparty: false, team: application.audience.team, vendor: false },
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
        audience: { manager: false, counterparty: true, team: false, vendor: false },
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
        audience: { manager: true, counterparty: false, team: lease.audience.team, vendor: false },
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
        audience: { manager: false, counterparty: true, team: false, vendor: false },
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
 * The wall-clock hour (0-23) `at` reads as in `America/Los_Angeles`.
 *
 * Quiet hours are presented to the manager as their own clock, but
 * `Date.getHours()` / `setHours()` are the SERVER's local zone — UTC on
 * Vercel. Reading the zoned hour explicitly is what makes "9pm-8am" mean 9pm
 * Pacific rather than 9pm wherever the dispatcher happens to run.
 */
export function losAngelesHour(at: Date): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles",
    hour: "numeric",
    hourCycle: "h23",
  }).formatToParts(at);
  const hour = parts.find((part) => part.type === "hour")?.value;
  return hour ? Number(hour) : at.getHours();
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
  if (!isQuietHour(quietHours, losAngelesHour(sendAt))) return sendAt;
  let out = sendAt;
  // Walk hour by hour rather than jumping, so a window that wraps midnight
  // lands on the correct day without date arithmetic special cases. Each step
  // adds real elapsed time and re-reads the LA wall-clock hour — not
  // `setHours`, which would snap to the SERVER's local hour — so a DST
  // transition that skips an hour (spring forward) or repeats one (fall back)
  // is walked correctly rather than assumed to be 60 real minutes per step.
  for (let i = 0; i < 24; i += 1) {
    out = new Date(out.getTime() + 3_600_000);
    if (!isQuietHour(quietHours, losAngelesHour(out))) return out;
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
  options?: {
    /**
     * Skip the quiet-hours push. Only `URGENT_REMINDER_KINDS` pass this: an
     * unassigned emergency must not politely wait until 8 a.m.
     */
    urgent?: boolean;
  },
): { leadMinutes: number; sendAt: Date }[] {
  if (!rule.enabled) return [];
  if (!rule.inbox && !rule.email && !rule.sms) return [];
  const anchorMs = new Date(anchorIso).getTime();
  if (!Number.isFinite(anchorMs)) return [];
  const applyQuiet = (at: Date) => (options?.urgent ? at : applyQuietHours(at, quietHours));

  const anchor = new Date(anchorMs);
  const out: { leadMinutes: number; sendAt: Date }[] = [];

  const timingKeys = rule.timings?.length ? rule.timings : null;
  if (timingKeys) {
    for (const key of timingKeys) {
      const timing = parseTimingKey(key);
      if (!timing) continue;
      const raw = timingSendAt(timing, anchor);
      const sendAt = applyQuiet(raw);
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
    const sendAt = applyQuiet(raw);
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
