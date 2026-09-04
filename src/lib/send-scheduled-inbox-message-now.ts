import { deliverPortalInboxMessage } from "@/lib/portal-inbox-delivery";
import {
  updateScheduledInboxMessage,
  isResidentOriginatedScheduledMessage,
  type ScheduledInboxMessageRecord,
} from "@/lib/scheduled-inbox-messages";
import type { SupabaseClient } from "@supabase/supabase-js";

async function markScheduledInboxMessageSent(
  db: SupabaseClient,
  id: string,
  filter: { managerUserId?: string; senderUserId?: string },
): Promise<void> {
  let query = db.from("portal_scheduled_inbox_message_records").select("row_data").eq("id", id);
  if (filter.managerUserId) query = query.eq("manager_user_id", filter.managerUserId);
  if (filter.senderUserId) {
    query = query.eq("row_data->>senderPortal", "resident").eq("row_data->>senderUserId", filter.senderUserId);
  }
  const { data: existing } = await query.maybeSingle();
  if (!existing) throw new Error("Scheduled message not found.");

  const prev = (existing.row_data ?? {}) as Record<string, unknown>;
  let updateQuery = db
    .from("portal_scheduled_inbox_message_records")
    .update({
      status: "sent",
      row_data: { ...prev, sentAt: new Date().toISOString() },
      updated_at: new Date().toISOString(),
    })
    .eq("id", id);
  if (filter.managerUserId) updateQuery = updateQuery.eq("manager_user_id", filter.managerUserId);
  if (filter.senderUserId) {
    updateQuery = updateQuery
      .eq("row_data->>senderPortal", "resident")
      .eq("row_data->>senderUserId", filter.senderUserId);
  }
  const { error } = await updateQuery;
  if (error) throw error;
}

export async function sendScheduledInboxMessageNow(
  db: SupabaseClient,
  message: ScheduledInboxMessageRecord,
): Promise<{ ok: boolean; error?: string }> {
  if (message.status !== "scheduled") {
    return { ok: false, error: "Only scheduled messages can be sent now." };
  }

  try {
    if (isResidentOriginatedScheduledMessage(message) && message.senderUserId && message.senderEmail) {
      const result = await deliverPortalInboxMessage(db, {
        senderUserId: message.senderUserId,
        senderEmail: message.senderEmail,
        fromName: message.senderName?.trim() || "Resident",
        subject: message.subject,
        text: message.body,
        toEmails: [message.recipientEmail],
        toUserIds: message.recipientUserId ? [message.recipientUserId] : [],
        eventCategory: "messages",
        senderRole: "resident",
      });
      if (!result.ok) return { ok: false, error: result.error };
      await markScheduledInboxMessageSent(db, message.id, { senderUserId: message.senderUserId });
      return { ok: true };
    }

    const { data: profile } = await db
      .from("profiles")
      .select("email, full_name")
      .eq("id", message.managerUserId)
      .maybeSingle();
    const senderEmail = String(profile?.email ?? "").trim().toLowerCase();
    if (!senderEmail) return { ok: false, error: "Manager profile missing email." };
    const fromName = profile?.full_name?.trim() || "Property manager";

    const result = await deliverPortalInboxMessage(db, {
      senderUserId: message.managerUserId,
      senderEmail,
      fromName,
      subject: message.subject,
      text: message.body,
      toEmails: message.broadcastCategories?.length ? [] : [message.recipientEmail],
      toUserIds: message.recipientUserId ? [message.recipientUserId] : [],
      broadcastCategories: message.broadcastCategories,
      eventCategory: "messages",
      deliverViaEmail: message.deliverViaEmail,
      deliverViaSms: message.deliverViaSms,
      suppressInbox: message.deliverViaInbox === false,
    });
    if (!result.ok) return { ok: false, error: result.error };

    await updateScheduledInboxMessage(db, message.managerUserId, message.id, {
      status: "sent",
      sentAt: new Date().toISOString(),
    });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
