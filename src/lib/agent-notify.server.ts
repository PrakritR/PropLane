/**
 * Inbox + push (+ optional SMS) notice to the owning manager, sent as "PropLane
 * Assistant". Direct thread-row write like executeSendRentReminder because
 * deliverPortalInboxMessage skips sender==recipient by design. Standalone
 * module so both the dispatch pipeline and the vendor agent's escalate tool
 * can use it without an import cycle.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { sendPushToUser } from "@/lib/push-notifications.server";
import { sendSms } from "@/lib/twilio";

const MANAGER_INBOX_SCOPE = "axis_portal_inbox_manager_v1";

export async function notifyManagerFromAgent(
  db: SupabaseClient,
  args: {
    landlordId: string;
    subject: string;
    text: string;
    threadType?: string;
    url?: string;
    notify?: { push: boolean; sms: boolean };
  },
): Promise<void> {
  const nowIso = new Date().toISOString();
  const threadId = `agent_notice_${args.landlordId}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  await db.from("portal_inbox_thread_records").upsert(
    {
      id: threadId,
      scope: MANAGER_INBOX_SCOPE,
      owner_user_id: args.landlordId,
      participant_email: null,
      thread_type: args.threadType ?? "agent_notice",
      row_data: {
        id: threadId,
        folder: "inbox",
        from: "PropLane Assistant",
        email: "",
        subject: args.subject,
        preview: args.text.slice(0, 100).replace(/\n/g, " "),
        body: args.text,
        unread: true,
        scope: MANAGER_INBOX_SCOPE,
      },
      updated_at: nowIso,
    },
    { onConflict: "id" },
  );

  if (args.notify?.push !== false) {
    try {
      await sendPushToUser(args.landlordId, {
        title: args.subject,
        body: args.text.slice(0, 120).replace(/\n/g, " "),
        url: args.url ?? "/portal/communication/inbox/unopened",
      });
    } catch {
      /* push is best-effort; the inbox row is the durable notice */
    }
  }

  if (args.notify?.sms) {
    const { data: profile } = await db
      .from("profiles")
      .select("phone, sms_from_number")
      .eq("id", args.landlordId)
      .maybeSingle();
    const phone = (profile?.phone as string | null)?.trim();
    const from = (profile?.sms_from_number as string | null)?.trim();
    if (phone && from) {
      try {
        const { sendPropLaneSms } = await import("@/lib/proplane-sms-transport.server");
        await sendPropLaneSms({
          to: phone,
          text: `${args.subject}\nOpen PropLane to respond.`,
          fromNumber: from,
          log: null,
        });
      } catch {
        if (process.env.SMS_RUNTIME_ENABLED?.trim() === "1") return;
        await sendSms(phone, `${args.subject}\nOpen PropLane to respond.`, from);
      }
    }
  }
}
