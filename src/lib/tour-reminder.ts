import {
  DEFAULT_MANAGER_AUTOMATION_SETTINGS,
  DEFAULT_TOUR_REMINDER_TEMPLATE,
  normalizeTourReminderMinutesBeforeList,
  type ManagerAutomationSettings,
  type ReminderTemplate,
} from "@/lib/payment-automation-settings";

export { DEFAULT_TOUR_REMINDER_TEMPLATE };

export const TOUR_REMINDER_MESSAGE_KIND = "tour_reminder" as const;

export type TourReminderTemplateContext = {
  guestName: string;
  propertyTitle: string;
  tourTime: string;
  managerName: string;
  instructions: string;
};

export const DEFAULT_TOUR_REMINDER_MINUTES_BEFORE =
  DEFAULT_MANAGER_AUTOMATION_SETTINGS.tourReminderMinutesBefore;

export function fillTourReminderTemplate(
  template: ReminderTemplate,
  ctx: TourReminderTemplateContext,
): { subject: string; body: string } {
  const propertyLine = ctx.propertyTitle.trim() ? `Property: ${ctx.propertyTitle.trim()}` : "";
  const instructionsLine = ctx.instructions.trim() ? `Details: ${ctx.instructions.trim()}` : "";
  const replacements: Record<string, string> = {
    "{guestName}": ctx.guestName.trim() || "there",
    "{propertyTitle}": ctx.propertyTitle.trim() || "the property",
    "{tourTime}": ctx.tourTime.trim() || "your scheduled time",
    "{managerName}": ctx.managerName.trim() || "Your property manager",
    "{instructions}": ctx.instructions.trim(),
    "{propertyLine}": propertyLine,
    "{instructionsLine}": instructionsLine,
  };
  const apply = (text: string) =>
    Object.entries(replacements).reduce((acc, [key, value]) => acc.replaceAll(key, value), text);
  return {
    subject: apply(template.subject),
    body: apply(template.body)
      .replace(/\n{3,}/g, "\n\n")
      .replace(/^\s*\n/gm, "")
      .trim(),
  };
}

export function tourReminderSendAtIso(tourStartIso: string, minutesBefore: number, now = new Date()): string | null {
  const startMs = new Date(tourStartIso).getTime();
  if (!Number.isFinite(startMs)) return null;
  const minutes = Math.max(5, Math.min(24 * 60, Math.round(minutesBefore) || DEFAULT_TOUR_REMINDER_MINUTES_BEFORE));
  const sendMs = startMs - minutes * 60_000;
  if (sendMs <= now.getTime()) return null;
  return new Date(sendMs).toISOString();
}

export function tourReminderSettingsFromAutomation(settings: ManagerAutomationSettings) {
  const minutesBeforeList = normalizeTourReminderMinutesBeforeList(
    settings.tourReminderMinutesBeforeList,
    settings.tourReminderMinutesBefore,
  );
  return {
    enabled: settings.tourReminderEnabled !== false,
    minutesBefore: minutesBeforeList[minutesBeforeList.length - 1] ?? DEFAULT_TOUR_REMINDER_MINUTES_BEFORE,
    minutesBeforeList,
    deliverViaEmail: settings.tourReminderDeliverViaEmail !== false,
    deliverViaSms: settings.tourReminderDeliverViaSms === true,
    template: settings.templates.tourReminder,
  };
}
