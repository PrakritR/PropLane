import { NextResponse } from "next/server";
import { isProductionRuntime } from "@/lib/server-env";
import { deliverPortalInboxMessage } from "@/lib/portal-inbox-delivery";
import { loadDueScheduledInboxMessages, isResidentOriginatedScheduledMessage, updateScheduledInboxMessage } from "@/lib/scheduled-inbox-messages";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";

export const runtime = "nodejs";

function isAuthorized(req: Request): boolean {
  const cronSecret = process.env.CRON_SECRET?.trim();
  if (!cronSecret) return !isProductionRuntime();
  return req.headers.get("authorization") === `Bearer ${cronSecret}`;
}

export async function GET(req: Request) {
  if (!isAuthorized(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const db = createSupabaseServiceRoleClient();
  const due = await loadDueScheduledInboxMessages(db);
  let sent = 0;
  let failed = 0;
  const errors: string[] = [];

  for (const message of due) {
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

        if (!result.ok) {
          failed++;
          errors.push(`${message.id}: ${result.error}`);
          continue;
        }

        await updateScheduledInboxMessage(db, message.managerUserId, message.id, {
          status: "sent",
          sentAt: new Date().toISOString(),
        });
        sent++;
        continue;
      }

      const { data: profile } = await db
        .from("profiles")
        .select("email, full_name")
        .eq("id", message.managerUserId)
        .maybeSingle();
      const senderEmail = String(profile?.email ?? "").trim().toLowerCase();
      if (!senderEmail) {
        failed++;
        errors.push(`${message.id}: manager profile missing email`);
        continue;
      }
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
        // With an eventCategory set, deliverViaEmail/deliverViaSms are IGNORED —
        // each recipient's own preference decides. The manager's explicit "off"
        // has to travel as a suppression, which is honoured in both modes, or
        // unticking Email still sent email. Leaving a channel on stays a
        // deferral to the recipient's preference rather than an override.
        suppressEmail: message.deliverViaEmail === false,
        suppressSms: message.deliverViaSms !== true,
        suppressInbox: message.deliverViaInbox === false,
      });

      if (!result.ok) {
        failed++;
        errors.push(`${message.id}: ${result.error}`);
        continue;
      }

      await updateScheduledInboxMessage(db, message.managerUserId, message.id, {
        status: "sent",
        sentAt: new Date().toISOString(),
      });
      sent++;
    } catch (e) {
      failed++;
      errors.push(`${message.id}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  return NextResponse.json({ ok: true, sent, failed, errors: errors.length ? errors : undefined });
}
