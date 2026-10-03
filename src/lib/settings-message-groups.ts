import type { AutomatedMessageCatalogEntry } from "@/lib/automated-messages-settings";
import type { ReminderSubjectKind } from "@/lib/reminders/rules";

export const SETTINGS_MESSAGE_GROUPS = ["Leasing", "Leases", "Payments", "Services", "Residents", "Vendors", "Account"] as const;
export type SettingsMessageGroup = typeof SETTINGS_MESSAGE_GROUPS[number];

export function eventSettingsGroup(entry: AutomatedMessageCatalogEntry): SettingsMessageGroup {
  if (entry.audiences.every((audience) => audience === "vendor")) return "Vendors";
  if (entry.area === "tours" || entry.area === "applications") return "Leasing";
  if (entry.area === "lease") return "Leases";
  if (entry.area === "payments") return "Payments";
  if (entry.area === "services") return "Services";
  if (entry.area === "inspections" || entry.area === "tasks") return "Residents";
  return "Account";
}
export function reminderSettingsGroup(kind: ReminderSubjectKind): SettingsMessageGroup {
  if (/^vendor_|^invoice_approval$/.test(kind)) return "Vendors";
  if (/^tour|^application|^cosigner|^group_application/.test(kind)) return "Leasing";
  if (/^lease|^move_|^deposit_|^renewal_|^countersign|^document_signature/.test(kind)) return "Leases";
  if (/payment|^delinquency/.test(kind)) return "Payments";
  if (/^work_order|^service_/.test(kind)) return "Services";
  if (/^resident_|^inspection|^task|^booking/.test(kind)) return "Residents";
  return "Account";
}
