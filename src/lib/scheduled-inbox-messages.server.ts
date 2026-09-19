import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  isResidentOriginatedScheduledRow,
  type ScheduledInboxMessageRecord,
  type ScheduledInboxMessageStatus,
  RESIDENT_SCHEDULED_MESSAGE_CONTENT_FORBIDDEN,
} from "@/lib/scheduled-inbox-messages";
import { captureSmsTestDelivery, currentSmsTestTransport } from "@/lib/sms/sms-test-transport.server";
import { stampSmsTestProvenance } from "@/lib/sms/sms-test-provenance.server";

export type {
  ScheduledInboxMessageRecord,
  ScheduledInboxMessageStatus,
} from "@/lib/scheduled-inbox-messages";
export {
  isResidentOriginatedScheduledMessage,
  isResidentOriginatedScheduledRow,
  RESIDENT_SCHEDULED_MESSAGE_CONTENT_FORBIDDEN,
  RESIDENT_SCHEDULED_MESSAGE_DELETE_FORBIDDEN,
} from "@/lib/scheduled-inbox-messages";

type DbRow = { id: string; manager_user_id: string; send_at: string; status: string; row_data: unknown; created_at: string };
const SELECT = "id, manager_user_id, send_at, status, row_data, created_at";
function rowFromDb(row: DbRow): ScheduledInboxMessageRecord {
  const data = (row.row_data ?? {}) as Record<string, unknown>;
  return {
    id: row.id, managerUserId: row.manager_user_id, sendAt: row.send_at, status: row.status as ScheduledInboxMessageStatus,
    subject: String(data.subject ?? ""), body: String(data.body ?? ""), recipientEmail: String(data.recipientEmail ?? "").trim().toLowerCase(),
    recipientName: String(data.recipientName ?? "").trim() || String(data.recipientEmail ?? ""), recipientUserId: typeof data.recipientUserId === "string" ? data.recipientUserId : null,
    broadcastCategories: Array.isArray(data.broadcastCategories) ? data.broadcastCategories.filter((value): value is "management" | "resident" => value === "management" || value === "resident") : undefined,
    deliverViaEmail: data.deliverViaEmail !== false, deliverViaSms: data.deliverViaSms === true, deliverViaInbox: data.deliverViaInbox !== false,
    senderPortal: data.senderPortal === "resident" || data.senderPortal === "manager" ? data.senderPortal : typeof data.senderUserId === "string" && data.senderUserId.trim() ? "resident" : undefined,
    senderUserId: typeof data.senderUserId === "string" ? data.senderUserId : null, senderName: typeof data.senderName === "string" ? data.senderName : undefined, senderEmail: typeof data.senderEmail === "string" ? data.senderEmail : undefined,
    createdAt: row.created_at, sentAt: typeof data.sentAt === "string" ? data.sentAt : null, cancelledAt: typeof data.cancelledAt === "string" ? data.cancelledAt : null,
    messageKind: typeof data.messageKind === "string" ? data.messageKind : undefined, tourPlannedEventId: typeof data.tourPlannedEventId === "string" ? data.tourPlannedEventId : undefined, tourStartIso: typeof data.tourStartIso === "string" ? data.tourStartIso : undefined,
    tourReminderMinutesBefore: typeof data.tourReminderMinutesBefore === "number" && Number.isFinite(data.tourReminderMinutesBefore) ? data.tourReminderMinutesBefore : undefined, smsTestSessionId: typeof data.smsTestSessionId === "string" ? data.smsTestSessionId : undefined,
  };
}
const mapRows = (data: DbRow[] | null) => (data ?? []).map(rowFromDb);
export function generateScheduledInboxMessageId(): string { return `sched_inbox_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`; }

export async function loadScheduledInboxMessagesForManager(db: SupabaseClient, managerUserId: string) {
  const { data, error } = await db.from("portal_scheduled_inbox_message_records").select(SELECT).eq("manager_user_id", managerUserId).order("send_at", { ascending: true }).limit(500);
  if (error) throw error; return mapRows(data as DbRow[] | null);
}
export async function loadScheduledInboxMessagesForResident(db: SupabaseClient, senderUserId: string, managerUserId?: string) {
  let query = db.from("portal_scheduled_inbox_message_records").select(SELECT).eq("row_data->>senderPortal", "resident").eq("row_data->>senderUserId", senderUserId);
  if (managerUserId) query = query.eq("manager_user_id", managerUserId);
  const { data, error } = await query.order("send_at", { ascending: true }).limit(200);
  if (error) throw error; return mapRows(data as DbRow[] | null);
}
export async function loadDueScheduledInboxMessages(db: SupabaseClient, now = new Date()) {
  const { data, error } = await db.from("portal_scheduled_inbox_message_records").select(SELECT).eq("status", "scheduled").is("row_data->>smsTestSessionId", null).lte("send_at", now.toISOString()).order("send_at", { ascending: true }).limit(200);
  if (error) throw error; return mapRows(data as DbRow[] | null);
}
export async function createScheduledInboxMessage(db: SupabaseClient, input: Omit<ScheduledInboxMessageRecord, "createdAt" | "sentAt" | "cancelledAt" | "deliverViaInbox"> & { deliverViaInbox?: boolean }): Promise<ScheduledInboxMessageRecord> {
  const now = new Date().toISOString(); const smsTest = currentSmsTestTransport();
  const rowData = stampSmsTestProvenance({ subject: input.subject, body: input.body, recipientEmail: input.recipientEmail, recipientName: input.recipientName, recipientUserId: input.recipientUserId ?? null, broadcastCategories: input.broadcastCategories ?? [], deliverViaEmail: input.deliverViaEmail, deliverViaSms: input.deliverViaSms, deliverViaInbox: input.deliverViaInbox !== false, ...(input.senderPortal ? { senderPortal: input.senderPortal } : {}), ...(input.senderUserId ? { senderUserId: input.senderUserId } : {}), ...(input.senderName ? { senderName: input.senderName } : {}), ...(input.senderEmail ? { senderEmail: input.senderEmail } : {}), ...(input.messageKind ? { messageKind: input.messageKind } : {}), ...(input.tourPlannedEventId ? { tourPlannedEventId: input.tourPlannedEventId } : {}), ...(input.tourStartIso ? { tourStartIso: input.tourStartIso } : {}), ...(input.tourReminderMinutesBefore != null ? { tourReminderMinutesBefore: input.tourReminderMinutesBefore } : {}) });
  const { error } = await db.from("portal_scheduled_inbox_message_records").insert({ id: input.id, manager_user_id: input.managerUserId, send_at: input.sendAt, status: input.status, row_data: rowData, created_at: now, updated_at: now });
  if (error) throw error;
  if (smsTest) captureSmsTestDelivery({ kind: "reminder", summary: "Scheduled message delivery captured in the test conversation.", status: "captured", metadata: { scheduledMessageId: input.id } });
  return { ...input, ...(smsTest ? { smsTestSessionId: smsTest.sessionId ?? "request_scoped" } : {}), deliverViaInbox: input.deliverViaInbox !== false, createdAt: now, sentAt: null, cancelledAt: null };
}
type UpdatePatch = Partial<Pick<ScheduledInboxMessageRecord, "sendAt" | "status" | "subject" | "body" | "recipientEmail" | "recipientName" | "recipientUserId" | "deliverViaEmail" | "deliverViaSms" | "deliverViaInbox">> & { sentAt?: string | null; cancelledAt?: string | null; tourReminderMinutesBefore?: number };
function managerContentPatchAttempted(patch: UpdatePatch) { return patch.subject != null || patch.body != null || patch.sendAt != null || patch.recipientEmail != null || patch.recipientName != null || patch.recipientUserId !== undefined || patch.deliverViaEmail != null || patch.deliverViaSms != null || patch.deliverViaInbox != null; }
export async function updateScheduledInboxMessage(db: SupabaseClient, managerUserId: string, id: string, patch: UpdatePatch): Promise<void> {
  const { data: existing } = await db.from("portal_scheduled_inbox_message_records").select("row_data, status").eq("id", id).eq("manager_user_id", managerUserId).maybeSingle();
  if (!existing) throw new Error("Scheduled message not found."); const prev = (existing.row_data ?? {}) as Record<string, unknown>;
  if (isResidentOriginatedScheduledRow(prev) && managerContentPatchAttempted(patch)) throw new Error(RESIDENT_SCHEDULED_MESSAGE_CONTENT_FORBIDDEN);
  const row_data = stampSmsTestProvenance({ ...prev, ...(patch.subject != null ? { subject: patch.subject } : {}), ...(patch.body != null ? { body: patch.body } : {}), ...(patch.recipientEmail != null ? { recipientEmail: patch.recipientEmail.trim().toLowerCase() } : {}), ...(patch.recipientName != null ? { recipientName: patch.recipientName } : {}), ...(patch.recipientUserId !== undefined ? { recipientUserId: patch.recipientUserId } : {}), ...(patch.deliverViaEmail != null ? { deliverViaEmail: patch.deliverViaEmail } : {}), ...(patch.deliverViaSms != null ? { deliverViaSms: patch.deliverViaSms } : {}), ...(patch.deliverViaInbox != null ? { deliverViaInbox: patch.deliverViaInbox } : {}), ...(patch.tourReminderMinutesBefore != null ? { tourReminderMinutesBefore: patch.tourReminderMinutesBefore } : {}), ...(patch.sentAt !== undefined ? { sentAt: patch.sentAt } : {}), ...(patch.cancelledAt !== undefined ? { cancelledAt: patch.cancelledAt } : {}) });
  const { error } = await db.from("portal_scheduled_inbox_message_records").update({ ...(patch.sendAt != null ? { send_at: patch.sendAt } : {}), ...(patch.status != null ? { status: patch.status } : {}), row_data, updated_at: new Date().toISOString() }).eq("id", id).eq("manager_user_id", managerUserId);
  if (error) throw error;
}
export async function updateScheduledInboxMessageForResident(db: SupabaseClient, senderUserId: string, id: string, patch: { status?: ScheduledInboxMessageStatus; cancelledAt?: string | null }, managerUserId?: string): Promise<void> {
  let readQuery = db.from("portal_scheduled_inbox_message_records").select("row_data, status").eq("id", id).eq("row_data->>senderPortal", "resident").eq("row_data->>senderUserId", senderUserId);
  if (managerUserId) readQuery = readQuery.eq("manager_user_id", managerUserId);
  const { data: existing } = await readQuery.maybeSingle(); if (!existing) throw new Error("Scheduled message not found.");
  let updateQuery = db.from("portal_scheduled_inbox_message_records").update({ ...(patch.status != null ? { status: patch.status } : {}), row_data: { ...((existing.row_data ?? {}) as Record<string, unknown>), ...(patch.cancelledAt !== undefined ? { cancelledAt: patch.cancelledAt } : {}) }, updated_at: new Date().toISOString() }).eq("id", id).eq("row_data->>senderPortal", "resident").eq("row_data->>senderUserId", senderUserId);
  if (managerUserId) updateQuery = updateQuery.eq("manager_user_id", managerUserId);
  const { error } = await updateQuery; if (error) throw error;
}
