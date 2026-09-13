import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { materializeReminders, resolveReminder, type ReminderQueueRow } from "../queue.server";
import { loadReminderSettings } from "../settings.server";
import { TOUR_INTEREST_BODY, TOUR_INTEREST_DELAY_MS, TOUR_INTEREST_PURPOSE, tourInterestProperty } from "../tour-interest";
import { normalizeE164 } from "@/lib/phone-e164";
import { loadAssignableConversationHouses } from "@/lib/sms/conversation-house-access.server";
import { resolveTourSmsEligibility } from "@/lib/sms/tour-sms-eligibility.server";

async function latestInbound(db: SupabaseClient, owner: string, phone: string) {
  const { data, error } = await db.from("manager_sms_messages").select("id, created_at")
    .eq("manager_user_id", owner).eq("resident_phone", phone).eq("direction", "inbound")
    .order("created_at", { ascending: false }).order("id", { ascending: false }).limit(1).maybeSingle();
  if (error) throw error;
  return data;
}

/** Called only after the outbox has submitted and persisted the response. */
export async function materializeTourInterestFromOutbox(db: SupabaseClient, outboxId: string, now = new Date()) {
  const { data: sent, error } = await db.from("sms_outbox")
    .select("id, manager_user_id, actor_user_id, recipient_phone, recipient_email, conversation_key, prospect_burst_id, purpose, created_at, dispatch_started_at, status, property_id")
    .eq("id", outboxId).maybeSingle();
  if (error) throw error;
  if (!sent || !["submitted", "sent", "delivered"].includes(sent.status) || sent.purpose === TOUR_INTEREST_PURPOSE || !sent.conversation_key) return 0;
  const anchor = String(sent.dispatch_started_at ?? "");
  const anchorMs = Date.parse(anchor);
  // Recovery is nonretroactive: never create an already overdue nudge.
  if (!Number.isFinite(anchorMs) || now.getTime() - anchorMs >= TOUR_INTEREST_DELAY_MS) return 0;
  const settings = await loadReminderSettings(db, sent.manager_user_id);
  if (!settings.rules.tour_interest.enabled) return 0;
  const inbound = await latestInbound(db, sent.manager_user_id, sent.recipient_phone);
  if (!inbound || Date.parse(inbound.created_at) > anchorMs) return 0;
  let propertyId: string | null = null;
  if (sent.prospect_burst_id) {
    const { data: burst, error: burstError } = await db.from("prospect_sms_bursts")
      .select("history_snapshot, candidate_context").eq("id", sent.prospect_burst_id).maybeSingle();
    if (burstError) throw burstError;
    propertyId = tourInterestProperty(burst?.candidate_context ?? burst?.history_snapshot, inbound.created_at);
  }
  if (!propertyId) return 0;
  const payload = {
    conversationKey: sent.conversation_key, propertyId, actorUserId: sent.actor_user_id ?? sent.manager_user_id,
    inboundId: String(inbound.id), responseOutboxId: sent.id, anchorIso: anchor,
    customBody: settings.rules.tour_interest.template?.body?.trim() || TOUR_INTEREST_BODY,
  };
  const row: ReminderQueueRow = { id: "", managerUserId: sent.manager_user_id, kind: "tour_interest",
    subjectId: `${sent.conversation_key}:${inbound.id}`, leadMinutes: -1440,
    recipientEmail: sent.recipient_email ?? "", recipientPhone: sent.recipient_phone,
    recipientRole: "counterparty", sendAt: new Date(anchorMs + TOUR_INTEREST_DELAY_MS).toISOString(), attempts: 0, payload };
  if (!(await tourInterestIsCurrent(db, row))) return 0;
  return materializeReminders(db, { managerUserId: row.managerUserId, kind: row.kind, subjectId: row.subjectId,
    anchorIso: anchor, recipients: [{ email: row.recipientEmail, phone: row.recipientPhone, role: "counterparty" }], payload }, settings, now);
}

/** Same check before enqueue and again immediately before provider submission. */
export async function tourInterestIsCurrent(db: SupabaseClient, row: ReminderQueueRow): Promise<boolean> {
  const phone = normalizeE164(row.recipientPhone ?? "");
  const propertyId = String(row.payload.propertyId ?? "");
  const actorId = String(row.payload.actorUserId ?? "");
  if (!phone || !propertyId || !actorId || !row.payload.inboundId || !row.payload.responseOutboxId) return false;
  const settings = await loadReminderSettings(db, row.managerUserId);
  if (!settings.rules.tour_interest.enabled) return false;
  const { data: enabled, error: enabledError } = await db.from("manager_automation_settings")
    .select("tour_interest_enabled_at").eq("manager_user_id", row.managerUserId).maybeSingle();
  if (enabledError) throw enabledError;
  const enabledAt = Date.parse(enabled?.tour_interest_enabled_at ?? "");
  const anchorAt = Date.parse(String(row.payload.anchorIso ?? ""));
  if (!Number.isFinite(enabledAt) || !Number.isFinite(anchorAt) || anchorAt < enabledAt) return false;
  const { data: controls, error: controlsError } = await db.from("manager_tour_followup_controls")
    .select("archived,updated_at").eq("manager_user_id", row.managerUserId)
    .eq("conversation_key", String(row.payload.conversationKey ?? "")).maybeSingle();
  if (controlsError) throw controlsError;
  if (controls?.archived || (controls && Date.parse(controls.updated_at) > anchorAt)) return false;
  const inbound = await latestInbound(db, row.managerUserId, phone);
  if (!inbound || String(inbound.id) !== row.payload.inboundId) return false;
  const access = await loadAssignableConversationHouses(db, actorId);
  if (access.assignable.get(propertyId)?.ownerUserId !== row.managerUserId) return false;
  const { data: response, error: responseError } = await db.from("sms_outbox")
    .select("manager_user_id, recipient_phone, status, conversation_key")
    .eq("id", String(row.payload.responseOutboxId)).maybeSingle();
  if (responseError) throw responseError;
  if (!response || response.manager_user_id !== row.managerUserId || response.recipient_phone !== phone ||
    response.conversation_key !== row.payload.conversationKey || !["submitted", "sent", "delivered"].includes(response.status)) return false;
  // The two authoritative tour singletons include pending requests and bookings.
  const { data: schedules, error: scheduleError } = await db.from("portal_schedule_records").select("row_data")
    .in("id", ["axis_admin_partner_inquiries_v1", "axis_admin_planned_events_v1"]);
  if (scheduleError) throw scheduleError;
  if (!schedules || schedules.length !== 2) throw new Error("Tour schedule is incomplete");
  for (const record of schedules ?? []) {
    const events = record.row_data?.payload;
    if (!Array.isArray(events)) throw new Error("Tour schedule is incomplete");
    if (events.some((event: Record<string, unknown>) => (event.managerUserId === row.managerUserId ||
      event.propertyId === propertyId || (Array.isArray(event.eligibleHostUserIds) && event.eligibleHostUserIds.includes(row.managerUserId))) &&
      normalizeE164(String(event.phone ?? event.attendeePhone ?? "")) === phone)) return false;
  }
  // Paginate the owner's applications: phone is inside validated row_data, not
  // a guessed identity join or an email fabricated for a phone-only prospect.
  for (let offset = 0; ; offset += 500) {
    const { data: apps, error: appError } = await db.from("manager_application_records").select("id, resident_email, row_data")
      .eq("manager_user_id", row.managerUserId).order("id").range(offset, offset + 499);
    if (appError) throw appError;
    if ((apps ?? []).some((app) => normalizeE164(String(app.row_data?.application?.phone ?? app.row_data?.phone ?? "")) === phone ||
      (row.recipientEmail && String(app.resident_email ?? "").toLowerCase() === row.recipientEmail.toLowerCase()))) return false;
    if ((apps ?? []).length < 500) break;
  }
  return true;
}

export async function tourInterestOutboxIsCurrent(db: SupabaseClient, reminderId: string, input?: {
  managerUserId: string; actorUserId: string; recipientPhone: string; conversationKey?: string | null;
  propertyId?: string | null; body: string;
}) {
  const { data, error } = await db.from("portal_reminder_records").select("*").eq("id", reminderId).eq("kind", "tour_interest").maybeSingle();
  if (error) throw error;
  if (!data || !["sending", "sent"].includes(data.status)) return false;
  if (input && (data.manager_user_id !== input.managerUserId || data.recipient_phone !== normalizeE164(input.recipientPhone) ||
    data.payload?.actorUserId !== input.actorUserId || data.payload?.conversationKey !== input.conversationKey ||
    data.payload?.propertyId !== input.propertyId || data.payload?.customBody !== input.body)) return false;
  return tourInterestIsCurrent(db, { id: data.id, managerUserId: data.manager_user_id, kind: "tour_interest",
    subjectId: data.subject_id, recipientEmail: data.recipient_email ?? "", recipientPhone: data.recipient_phone,
    recipientRole: "counterparty", leadMinutes: data.lead_minutes, sendAt: data.send_at, attempts: data.attempts, payload: data.payload });
}

export async function dispatchTourInterestReminder(db: SupabaseClient, workerId: string, row: ReminderQueueRow): Promise<"sent" | "failed" | "retried"> {
  if (!(await tourInterestIsCurrent(db, row))) {
    await resolveReminder(db, row.id, workerId, "cancelled", "Follow-up no longer needed");
    return "failed";
  }
  const consent = await resolveTourSmsEligibility(db, { managerUserId: row.managerUserId,
    guestPhone: row.recipientPhone, explicitOptIn: false, allowConversationEvidence: true, purpose: TOUR_INTEREST_PURPOSE });
  if (!consent.eligible) {
    await resolveReminder(db, row.id, workerId, "cancelled", consent.reason);
    return "failed";
  }
  const { enqueueOwnerSms } = await import("@/lib/sms/owner-sms-dispatcher.server");
  const outcome = await enqueueOwnerSms({ managerUserId: row.managerUserId, actorUserId: String(row.payload.actorUserId),
    recipientPhone: consent.phoneE164, recipientEmail: row.recipientEmail || null,
    body: String(row.payload.customBody ?? TOUR_INTEREST_BODY), sendClass: "transactional",
    purpose: TOUR_INTEREST_PURPOSE, conversationKey: String(row.payload.conversationKey), counterpartyRole: "prospect",
    propertyId: String(row.payload.propertyId), dedupeKey: `tour-interest:${row.id}` }, db);
  await resolveReminder(db, row.id, workerId, outcome.ok ? "sent" : "scheduled", outcome.ok ? undefined : outcome.error);
  return outcome.ok ? "sent" : "retried";
}
