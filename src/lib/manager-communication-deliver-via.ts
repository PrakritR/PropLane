import type { NotificationCategory } from "@/lib/notification-preferences";
import type { ManagerAutomationSettings } from "@/lib/payment-automation-settings";

export type DeliverViaChannels = { viaEmail: boolean; viaSms: boolean; viaInbox?: boolean };

export type ManagerDeliverViaKind =
  | "inbox_default"
  | "payment_reminder"
  | "tour_reminder"
  | NotificationCategory;

export function deliverViaFromManagerSettings(
  settings: ManagerAutomationSettings,
  kind: ManagerDeliverViaKind,
): DeliverViaChannels {
  switch (kind) {
    case "inbox_default":
      return {
        viaEmail: settings.inboxDefaultDeliverViaEmail !== false,
        viaSms: settings.inboxDefaultDeliverViaSms === true,
      };
    case "payment_reminder":
    case "payments":
      return {
        viaEmail: settings.paymentReminderDeliverViaEmail !== false,
        viaSms: settings.paymentReminderDeliverViaSms === true,
        viaInbox: settings.paymentReminderDeliverViaInbox !== false,
      };
    case "tour_reminder":
      return {
        viaEmail: settings.tourReminderDeliverViaEmail !== false,
        viaSms: settings.tourReminderDeliverViaSms === true,
        viaInbox: settings.tourReminderDeliverViaInbox !== false,
      };
    case "messages":
      return {
        viaEmail: settings.messagesDeliverViaEmail !== false,
        viaSms: settings.messagesDeliverViaSms === true,
      };
    case "leases":
      return {
        viaEmail: settings.leasesDeliverViaEmail !== false,
        viaSms: settings.leasesDeliverViaSms === true,
      };
    case "applications":
      return {
        viaEmail: settings.applicationsDeliverViaEmail !== false,
        viaSms: settings.applicationsDeliverViaSms === true,
      };
    case "maintenance":
      return {
        viaEmail: settings.maintenanceDeliverViaEmail !== false,
        viaSms: settings.maintenanceDeliverViaSms === true,
      };
    case "account":
      return { viaEmail: true, viaSms: true, viaInbox: true };
    default:
      return { viaEmail: true, viaSms: false };
  }
}

export function portalMessageSelectionFromDeliverVia(
  channels: DeliverViaChannels,
  smsAvailable: boolean,
): string[] {
  const selected: string[] = [];
  if (channels.viaInbox !== false) selected.push("proplane");
  if (channels.viaEmail) selected.push("email");
  if (channels.viaSms && smsAvailable) selected.push("sms");
  if (selected.length > 0) return selected;
  // Every channel is off in the saved settings. The old fallback re-ticked
  // PropLane and preselected SMS, contradicting the manager's own choice and
  // pre-arming a channel they had switched off. PropLane alone is the least
  // surprising floor: the message still has somewhere to land, and nothing
  // leaves the product without the manager ticking it.
  return ["proplane"];
}

export const MANAGER_COMMUNICATION_SEND_VIA_SECTIONS = [
  {
    id: "inbox_default",
    label: "Default send via",
    description: "Pre-selects Email and SMS when you compose or reply in Communication.",
    kind: "inbox_default" as const,
  },
  {
    id: "messages",
    label: "Messages",
    description: "Resident broadcasts and general inbox notifications.",
    kind: "messages" as const,
  },
  {
    id: "leases",
    label: "Leases",
    description: "Lease sent for signature and lease lifecycle notices.",
    kind: "leases" as const,
  },
  {
    id: "applications",
    label: "Applications",
    description: "Application status updates and welcome messages.",
    kind: "applications" as const,
  },
  {
    id: "maintenance",
    label: "Property & maintenance",
    description: "Work orders, add-on services, and property updates.",
    kind: "maintenance" as const,
  },
  {
    id: "payment_reminder",
    label: "Payment reminders",
    description: "Automated rent and charge reminder schedules.",
    kind: "payment_reminder" as const,
  },
  {
    id: "tour_reminder",
    label: "Tour reminders",
    description: "Confirmed tour reminder messages.",
    kind: "tour_reminder" as const,
  },
] as const;

export function patchDeliverViaForKind(
  settings: ManagerAutomationSettings,
  kind: ManagerDeliverViaKind,
  channels: DeliverViaChannels,
): ManagerAutomationSettings {
  const viaEmail = channels.viaEmail;
  const viaSms = channels.viaSms;
  switch (kind) {
    case "inbox_default":
      return { ...settings, inboxDefaultDeliverViaEmail: viaEmail, inboxDefaultDeliverViaSms: viaSms };
    case "messages":
      return { ...settings, messagesDeliverViaEmail: viaEmail, messagesDeliverViaSms: viaSms };
    case "leases":
      return { ...settings, leasesDeliverViaEmail: viaEmail, leasesDeliverViaSms: viaSms };
    case "applications":
      return { ...settings, applicationsDeliverViaEmail: viaEmail, applicationsDeliverViaSms: viaSms };
    case "maintenance":
      return { ...settings, maintenanceDeliverViaEmail: viaEmail, maintenanceDeliverViaSms: viaSms };
    case "payment_reminder":
    case "payments":
      return {
        ...settings,
        paymentReminderDeliverViaEmail: viaEmail,
        paymentReminderDeliverViaSms: viaSms,
        paymentReminderDeliverViaInbox: channels.viaInbox !== false,
      };
    case "tour_reminder":
      return {
        ...settings,
        tourReminderDeliverViaEmail: viaEmail,
        tourReminderDeliverViaSms: viaSms,
        tourReminderDeliverViaInbox: channels.viaInbox !== false,
      };
    default:
      return settings;
  }
}
