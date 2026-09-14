import type { ManagerAutomationSettings } from "./payment-automation-settings";
import { formatStandardReminderSchedule } from "./payment-automation-settings";

export type ReminderPresetId = "basics" | "standard" | "gentle" | "minimal" | "custom";

export type ReminderPreset = {
  id: Exclude<ReminderPresetId, "custom">;
  label: string;
  description: string;
  recommended?: boolean;
  settings: Pick<
    ManagerAutomationSettings,
    "preDueReminderDays" | "sameDayReminderEnabled" | "overdueDailyEnabled" | "overdueDailyStartDays" | "postDueReminderDays"
  >;
};

export const PAYMENT_REMINDER_PRESETS: ReminderPreset[] = [
  {
    id: "basics",
    label: "Basics",
    description: "1 week, 2 days, and 1 day before due, then every day late until paid.",
    recommended: true,
    settings: {
      preDueReminderDays: [7, 2, 1],
      sameDayReminderEnabled: false,
      overdueDailyEnabled: true,
      overdueDailyStartDays: 1,
      postDueReminderDays: [],
    },
  },
  {
    id: "standard",
    label: "Standard",
    description: "3, 2, and 1 days before, on the due date, then daily until paid.",
    settings: {
      preDueReminderDays: [3, 2, 1],
      sameDayReminderEnabled: true,
      overdueDailyEnabled: true,
      overdueDailyStartDays: 1,
      postDueReminderDays: [],
    },
  },
  {
    id: "gentle",
    label: "Gentle",
    description: "One reminder 3 days before and on the due date.",
    settings: {
      preDueReminderDays: [3],
      sameDayReminderEnabled: true,
      overdueDailyEnabled: false,
      overdueDailyStartDays: 1,
      postDueReminderDays: [],
    },
  },
  {
    id: "minimal",
    label: "Due date only",
    description: "A single reminder on the day payment is due.",
    settings: {
      preDueReminderDays: [],
      sameDayReminderEnabled: true,
      overdueDailyEnabled: false,
      overdueDailyStartDays: 1,
      postDueReminderDays: [],
    },
  },
];

function sortedDays(days: number[]): number[] {
  return [...days].sort((a, b) => b - a);
}

function reminderCadenceMatches(
  settings: ManagerAutomationSettings,
  preset: ReminderPreset,
): boolean {
  return (
    JSON.stringify(sortedDays(settings.preDueReminderDays)) ===
      JSON.stringify(sortedDays(preset.settings.preDueReminderDays)) &&
    settings.sameDayReminderEnabled === preset.settings.sameDayReminderEnabled &&
    settings.overdueDailyEnabled === preset.settings.overdueDailyEnabled &&
    (settings.postDueReminderDays?.length ?? 0) === 0
  );
}

export function detectReminderPreset(settings: ManagerAutomationSettings): ReminderPresetId {
  for (const preset of PAYMENT_REMINDER_PRESETS) {
    if (reminderCadenceMatches(settings, preset)) return preset.id;
  }
  return "custom";
}

export function applyReminderPreset(
  current: ManagerAutomationSettings,
  presetId: ReminderPresetId,
): ManagerAutomationSettings {
  if (presetId === "custom") return current;
  const preset = PAYMENT_REMINDER_PRESETS.find((row) => row.id === presetId);
  if (!preset) return current;
  return {
    ...current,
    ...preset.settings,
  };
}

export function buildReminderPreviewLines(
  settings: Pick<
    ManagerAutomationSettings,
    "preDueReminderDays" | "sameDayReminderEnabled" | "overdueDailyEnabled"
  >,
): string[] {
  const lines: string[] = [];
  const pre = [...settings.preDueReminderDays].sort((a, b) => b - a);
  for (const days of pre) {
    lines.push(`${days} day${days === 1 ? "" : "s"} before due`);
  }
  if (settings.sameDayReminderEnabled) lines.push("On the due date");
  if (settings.overdueDailyEnabled) lines.push("Every day after the due date until paid");
  if (!lines.length) lines.push("No automatic reminders");
  return lines;
}

export function formatFriendlyReminderSchedule(settings: ManagerAutomationSettings): string {
  const preset = detectReminderPreset(settings);
  if (preset !== "custom") {
    const match = PAYMENT_REMINDER_PRESETS.find((row) => row.id === preset);
    if (match) return match.label;
  }
  return formatStandardReminderSchedule(settings);
}

/** Parse comma- or space-separated day counts for custom reminder schedules. */
export function parsePreDueReminderDaysInput(raw: string): number[] {
  const days = raw
    .split(/[,\s]+/)
    .map((part) => Math.round(Number(part.trim())))
    .filter((day) => Number.isFinite(day) && day >= 1 && day <= 60);
  return [...new Set(days)].sort((a, b) => b - a);
}

export function formatPreDueReminderDaysInput(days: number[]): string {
  return [...days].sort((a, b) => b - a).join(", ");
}

export const REMINDER_BEFORE_DUE_DAY_OPTIONS = [30, 21, 14, 7, 3, 2, 1] as const;

export type ReminderScheduleToken = `before:${number}` | "due_date" | "every_day_late";

export function reminderScheduleTokensFromSettings(
  settings: Pick<
    ManagerAutomationSettings,
    "preDueReminderDays" | "sameDayReminderEnabled" | "overdueDailyEnabled"
  >,
): ReminderScheduleToken[] {
  const tokens: ReminderScheduleToken[] = settings.preDueReminderDays.map(
    (day) => `before:${day}` as ReminderScheduleToken,
  );
  if (settings.sameDayReminderEnabled) tokens.push("due_date");
  if (settings.overdueDailyEnabled) tokens.push("every_day_late");
  return tokens;
}

export function settingsPatchFromReminderScheduleTokens(
  selected: ReminderScheduleToken[],
): Pick<
  ManagerAutomationSettings,
  "preDueReminderDays" | "sameDayReminderEnabled" | "overdueDailyEnabled" | "overdueDailyStartDays" | "postDueReminderDays"
> {
  const preDueReminderDays = [
    ...new Set(
      selected
        .filter((token): token is `before:${number}` => token.startsWith("before:"))
        .map((token) => Math.round(Number(token.slice("before:".length))))
        .filter((day) => Number.isFinite(day) && day >= 1 && day <= 60),
    ),
  ].sort((a, b) => b - a);

  const overdueDailyEnabled = selected.includes("every_day_late");

  return {
    preDueReminderDays,
    sameDayReminderEnabled: selected.includes("due_date"),
    overdueDailyEnabled,
    overdueDailyStartDays: 1,
    postDueReminderDays: overdueDailyEnabled ? [] : [],
  };
}

export function labelForReminderScheduleToken(token: ReminderScheduleToken): string {
  if (token === "due_date") return "Due date";
  if (token === "every_day_late") return "Every day late";
  const days = Number(token.slice("before:".length));
  return `${days} day${days === 1 ? "" : "s"} before due`;
}

function joinHuman(parts: string[]): string {
  if (parts.length <= 1) return parts.join("");
  return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

/**
 * One plain sentence for a reminder schedule — "Sends 21, 14, 3 and 2 days
 * before, and on the due date." It is generated from the same tokens the save
 * uses, so it can never disagree with what is stored; the chip control shows
 * it under the chips and the payments list shows it as the settings summary.
 * An empty schedule is a legal setting, and its sentence says what that means.
 */
export const EMPTY_REMINDER_SCHEDULE_SUMMARY =
  "No automatic reminders — residents only hear from you when you message them.";

export function summarizeReminderSchedule(tokens: ReminderScheduleToken[]): string {
  const days = [
    ...new Set(
      tokens
        .filter((token): token is `before:${number}` => token.startsWith("before:"))
        .map((token) => Number(token.slice("before:".length)))
        .filter((day) => Number.isFinite(day) && day >= 1),
    ),
  ].sort((a, b) => b - a);
  const bits: string[] = [];
  if (days.length) {
    const unit = days.length === 1 && days[0] === 1 ? "day" : "days";
    bits.push(`${joinHuman(days.map(String))} ${unit} before`);
  }
  if (tokens.includes("due_date")) bits.push("on the due date");
  if (tokens.includes("every_day_late")) bits.push("every day it's late");
  if (!bits.length) return EMPTY_REMINDER_SCHEDULE_SUMMARY;
  return `Sends ${joinHuman(bits)}.`;
}
