/**
 * Preset auto-sends: the ten predictable moments PropLane texts without anyone typing (captain,
 * 2026-10-18, texting plan "Preset auto-sends"), plus the two booking presets claude-2 registers
 * through the same spine (`arrival_guide`, `checkout_reminder`).
 *
 * Pure and client-safe: the catalog, the per-workspace mode vocabulary and the defaults. The
 * wording lives in `templates.ts`; what fires them lives in `sweep.server.ts`; the send in
 * `fire.server.ts`.
 *
 * Two engines, deliberately:
 *   - `existing` presets are moments the product already handles (rent reminders, the resident's
 *     service visit notice, the move-out checklist). The preset row is the manager's on/off for
 *     them: `off` is honoured by the existing sender, nothing else about today's behaviour moves,
 *     and `draft` is not offered (the account-wide "approval first" switch already decides that).
 *   - `automation` presets are the new texts this spine sends. Each is auto, draft or off per
 *     workspace, and a workspace that has never picked keeps the preset's default (draft for every
 *     new one: the manager approves each send until they flip it).
 */

export type AutomationMode = "auto" | "draft" | "off";

export const AUTOMATION_MODES: readonly AutomationMode[] = ["auto", "draft", "off"] as const;

export type AutomationPresetId =
  | "welcome"
  | "move_in_3d"
  | "move_in_day"
  | "rent_due_3d"
  | "rent_due_day"
  | "rent_late_3d"
  | "announcement"
  | "house_reminders"
  | "maintenance_booked"
  | "move_out"
  | "arrival_guide"
  | "checkout_reminder";

/** Where a preset's text goes. `group` is the house group chat; everything else is one person. */
export type AutomationAudience = "resident" | "group";

export type AutomationPreset = {
  id: AutomationPresetId;
  /** The row's name in Settings. A plain noun phrase, no subtext. */
  label: string;
  audience: AutomationAudience;
  engine: "existing" | "automation";
  defaultMode: AutomationMode;
  /** The modes the dropdown offers. An `existing` preset is auto or off only. */
  modes: readonly AutomationMode[];
  /**
   * The editable text this spine sends. For an `existing` preset that also has a new house-wide
   * half (maintenance booked, move out) this is the house text; the resident's own message stays
   * the existing one.
   */
  template: string;
  /** Variables the template may use (the "Insert" dropdown offers exactly these). */
  variables: readonly AutomationVariable[];
  /**
   * Booking presets are fired by the booking times code through `fireAutomation`, not by the
   * sweep. They draw in Settings only once `EXTERNAL_PRESETS_LIVE` names them.
   */
  external?: boolean;
  /** A group preset that must never name a person or carry money. Enforced on every render. */
  houseWideOnly?: boolean;
  /**
   * False when this preset only gates a message the product already writes elsewhere (the rent
   * reminders keep their own wording in Payments), so Settings offers no template for it.
   */
  hasOwnText: boolean;
};

/**
 * Everything a template can say. A group preset may use none of the personal or money variables
 * (`GROUP_FORBIDDEN_VARIABLES`): the renderer refuses, the editor does not offer them.
 */
export type AutomationVariable =
  | "first_name"
  | "house"
  | "room"
  | "move_in_date"
  | "move_out_date"
  | "amount"
  | "due_date"
  | "pay_link"
  | "guide_link"
  | "door_code"
  | "wifi_name"
  | "wifi_password"
  | "parking"
  | "service_title"
  | "service_window"
  | "announcement"
  | "trash_day"
  | "recycling_day"
  | "check_in_time"
  | "check_out_time"
  | "arrival_link";

export const VARIABLE_LABELS: Record<AutomationVariable, string> = {
  first_name: "First name",
  house: "House",
  room: "Room",
  move_in_date: "Move-in date",
  move_out_date: "Move-out date",
  amount: "Amount",
  due_date: "Due date",
  pay_link: "Pay link",
  guide_link: "Move-in guide link",
  door_code: "Door code",
  wifi_name: "Wi-Fi name",
  wifi_password: "Wi-Fi password",
  parking: "Parking",
  service_title: "Service",
  service_window: "Visit window",
  announcement: "Announcement",
  trash_day: "Trash day",
  recycling_day: "Recycling day",
  check_in_time: "Check-in time",
  check_out_time: "Check-out time",
  arrival_link: "Arrival guide link",
};

/** A person, money or a secret: never in a text that a whole house reads. */
export const GROUP_FORBIDDEN_VARIABLES: ReadonlySet<AutomationVariable> = new Set<AutomationVariable>([
  "first_name",
  "room",
  "amount",
  "due_date",
  "pay_link",
  "guide_link",
  "door_code",
  "wifi_password",
  "arrival_link",
]);

/**
 * A booking preset lands in Settings only once its trigger exists. claude-2's check-in/out times
 * work adds its id here in the same change that calls `fireAutomation` for it; until then the row
 * would be a switch wired to nothing.
 */
export const EXTERNAL_PRESETS_LIVE: ReadonlySet<AutomationPresetId> = new Set<AutomationPresetId>();

export const AUTOMATION_PRESETS: readonly AutomationPreset[] = [
  {
    id: "welcome",
    hasOwnText: true,
    label: "Welcome (lease signed or booking confirmed)",
    audience: "resident",
    engine: "automation",
    defaultMode: "draft",
    modes: AUTOMATION_MODES,
    template: "Welcome, {first_name}! You're moving into {house} on {move_in_date}. Your move-in guide: {guide_link}",
    variables: ["first_name", "house", "room", "move_in_date", "guide_link"],
  },
  {
    id: "move_in_3d",
    hasOwnText: true,
    label: "Move-in details (3 days before)",
    audience: "resident",
    engine: "automation",
    defaultMode: "draft",
    modes: AUTOMATION_MODES,
    template:
      "Hi {first_name}, move-in is {move_in_date}. Door code {door_code}. Wi-Fi {wifi_name}, password {wifi_password}. Parking: {parking}. You'll join the house group chat on move-in day.",
    variables: ["first_name", "house", "move_in_date", "door_code", "wifi_name", "wifi_password", "parking", "guide_link"],
  },
  {
    id: "move_in_day",
    hasOwnText: true,
    label: "Move-in day (house group)",
    audience: "group",
    engine: "automation",
    defaultMode: "draft",
    modes: AUTOMATION_MODES,
    template: "A new housemate moves into {house} today. Please say hi. Reply LEAVE GROUP to get house texts one on one.",
    variables: ["house"],
    houseWideOnly: true,
  },
  {
    id: "rent_due_3d",
    hasOwnText: false,
    label: "Rent due (3 days before)",
    audience: "resident",
    engine: "existing",
    defaultMode: "auto",
    modes: ["auto", "off"],
    template: "Hi {first_name}, rent of {amount} for {house} is due {due_date}. Pay here: {pay_link}",
    variables: ["first_name", "house", "amount", "due_date", "pay_link"],
  },
  {
    id: "rent_due_day",
    hasOwnText: true,
    label: "Rent due today (house group)",
    audience: "group",
    engine: "automation",
    defaultMode: "draft",
    modes: AUTOMATION_MODES,
    template: "Friendly reminder: rent is due today. Check your texts for your pay link.",
    variables: ["house"],
    houseWideOnly: true,
  },
  {
    id: "rent_late_3d",
    hasOwnText: false,
    label: "Rent late (day 3, private)",
    audience: "resident",
    engine: "existing",
    defaultMode: "auto",
    modes: ["auto", "off"],
    template: "Hi {first_name}, your rent for {house} is 3 days late. Pay here: {pay_link}",
    variables: ["first_name", "house", "amount", "pay_link"],
  },
  {
    id: "announcement",
    hasOwnText: true,
    label: "Announcements (house group)",
    audience: "group",
    engine: "automation",
    // A manager typing "announce:" has already said send; the mode only decides whether it is held.
    defaultMode: "auto",
    modes: AUTOMATION_MODES,
    template: "{announcement}",
    variables: ["house", "announcement"],
    houseWideOnly: true,
  },
  {
    id: "house_reminders",
    hasOwnText: true,
    label: "Recurring house reminders (house group)",
    audience: "group",
    engine: "automation",
    defaultMode: "draft",
    modes: AUTOMATION_MODES,
    template: "Reminder: trash and recycling go out tonight for {trash_day} pickup.",
    variables: ["house", "trash_day", "recycling_day"],
    houseWideOnly: true,
  },
  {
    id: "maintenance_booked",
    hasOwnText: true,
    label: "Service visit booked (house-wide)",
    audience: "group",
    engine: "existing",
    defaultMode: "draft",
    modes: AUTOMATION_MODES,
    template: "Service visit booked at {house}: {service_title}, {service_window}. Please keep the area clear.",
    variables: ["house", "service_title", "service_window"],
    houseWideOnly: true,
  },
  {
    id: "move_out",
    hasOwnText: true,
    label: "Move-out (house group)",
    audience: "group",
    engine: "existing",
    defaultMode: "draft",
    modes: AUTOMATION_MODES,
    template: "A housemate moves out of {house} today. Thanks for keeping shared spaces tidy.",
    variables: ["house"],
    houseWideOnly: true,
  },
  {
    id: "arrival_guide",
    hasOwnText: true,
    label: "Arrival guide (24 hours before check-in)",
    audience: "resident",
    engine: "automation",
    defaultMode: "draft",
    modes: AUTOMATION_MODES,
    template: "Hi {first_name}, check-in at {house} is {check_in_time}. Door code {door_code}. Your arrival guide: {arrival_link}",
    variables: ["first_name", "house", "check_in_time", "door_code", "arrival_link"],
    external: true,
  },
  {
    id: "checkout_reminder",
    hasOwnText: true,
    label: "Check-out reminder (8 am on check-out day)",
    audience: "resident",
    engine: "automation",
    defaultMode: "draft",
    modes: AUTOMATION_MODES,
    template: "Good morning {first_name}. Check-out at {house} is {check_out_time} today. Thank you for staying with us.",
    variables: ["first_name", "house", "check_out_time"],
    external: true,
  },
];

const BY_ID = new Map<AutomationPresetId, AutomationPreset>(AUTOMATION_PRESETS.map((p) => [p.id, p]));

export function getAutomationPreset(id: string): AutomationPreset | null {
  return BY_ID.get(id as AutomationPresetId) ?? null;
}

export function isAutomationPresetId(value: unknown): value is AutomationPresetId {
  return typeof value === "string" && BY_ID.has(value as AutomationPresetId);
}

export function isAutomationMode(value: unknown): value is AutomationMode {
  return value === "auto" || value === "draft" || value === "off";
}

/** The presets Settings draws: everything except a booking preset whose trigger is not live yet. */
export function visibleAutomationPresets(): AutomationPreset[] {
  return AUTOMATION_PRESETS.filter((p) => !p.external || EXTERNAL_PRESETS_LIVE.has(p.id));
}

/**
 * The mode a workspace runs a preset in: its saved pick when the preset offers that mode, else the
 * preset's default. A saved mode the preset no longer offers (auto-only preset saved as draft) reads
 * as the default rather than as something the manager never chose.
 */
export function effectiveAutomationMode(
  preset: AutomationPreset,
  saved: AutomationMode | null | undefined,
): AutomationMode {
  if (saved && preset.modes.includes(saved)) return saved;
  return preset.defaultMode;
}

export const MODE_LABELS: Record<AutomationMode, string> = {
  auto: "Send automatically",
  draft: "Draft for me to send",
  off: "Off",
};

/**
 * Which preset governs a rent reminder the existing payment-reminder cron is about to send.
 * `pre_due` is the lead-up (3 days before is the shipped default), `post_due` / `overdue_daily` the
 * late nudges. Same-day and set-date reminders are not a preset: they keep sending.
 */
export function presetForScheduledPaymentKind(kind: string): AutomationPresetId | null {
  if (kind === "pre_due") return "rent_due_3d";
  if (kind === "post_due" || kind === "overdue_daily") return "rent_late_3d";
  return null;
}
