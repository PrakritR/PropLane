/** Client-safe scheduled inbox types and display helpers. Persistence is server-only. */
export type ScheduledInboxMessageStatus = "scheduled" | "sending" | "sent" | "cancelled";

export function isUpcomingScheduledInboxMessage(sendAt: string, status: string): boolean {
  if (status === "sending") return true;
  if (status === "sent") return false;
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return new Date(sendAt).getTime() >= startOfToday.getTime();
}

export type ScheduledInboxMessageRecord = {
  id: string; managerUserId: string; sendAt: string; status: ScheduledInboxMessageStatus;
  subject: string; body: string; recipientEmail: string; recipientName: string;
  recipientUserId?: string | null; broadcastCategories?: ("management" | "resident")[];
  deliverViaEmail: boolean; deliverViaSms: boolean; deliverViaInbox: boolean;
  senderPortal?: "resident" | "manager"; senderUserId?: string | null; senderName?: string; senderEmail?: string;
  createdAt: string; sentAt?: string | null; cancelledAt?: string | null; messageKind?: string;
  tourPlannedEventId?: string; tourStartIso?: string; tourReminderMinutesBefore?: number; smsTestSessionId?: string;
  /**
   * The workspace the manager composed this in. Stamped at schedule time because
   * delivery runs in a cron with no browser cookie to read one from: without it
   * an "All residents" broadcast scheduled in one workspace went out to the
   * residents of every workspace the manager owns. Absent on legacy rows and on
   * resident-composed messages.
   */
  workspaceId?: string | null;
};

export const RESIDENT_SCHEDULED_MESSAGE_CONTENT_FORBIDDEN = "Managers cannot edit resident-scheduled message content.";
export const RESIDENT_SCHEDULED_MESSAGE_DELETE_FORBIDDEN = "Managers cannot delete resident-scheduled messages.";

/** Includes legacy rows that stored senderUserId before senderPortal existed. */
export function isResidentOriginatedScheduledRow(rowData: Record<string, unknown>): boolean {
  if (rowData.senderPortal === "resident") return true;
  if (rowData.senderPortal === "manager") return false;
  return Boolean(String(rowData.senderUserId ?? "").trim());
}
export function isResidentOriginatedScheduledMessage(message: Pick<ScheduledInboxMessageRecord, "senderPortal" | "senderUserId">): boolean {
  return isResidentOriginatedScheduledRow(message);
}

export type InboxScheduleRow = {
  id: string; source: "manual" | "automation"; sendAt: string; recipientName: string; recipientEmail: string;
  topic: string; subject: string; body: string; status: ScheduledInboxMessageStatus; timingLabel: string;
  propertyLabel?: string; manualId?: string; automationId?: string;
};
