import { chargeDueLabel, isUnpaidHouseholdCharge, type HouseholdCharge } from "@/lib/household-charges";
import { formatPacificDateTime } from "@/lib/pacific-time";
import { appendManualPaymentInstructions } from "@/lib/manual-payment-instructions";
import { sendPushToUser } from "@/lib/push-notifications.server";
import type { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { canSendResidentOutboundSms, sendResidentOutboundSms } from "@/lib/resident-outbound-sms.server";
import {
  DEFAULT_NOTIFICATION_PREFERENCES,
  resolveChannels,
  type NotificationCategory,
} from "@/lib/notification-preferences";
import { deliverPortalMessageThreadSide } from "@/lib/portal-inbox-delivery";
import { notifyManagerFromAgent } from "@/lib/agent-notify.server";

type ServiceDb = ReturnType<typeof createSupabaseServiceRoleClient>;

export async function deliverPaymentReminder(input: {
  db: ServiceDb;
  charge: HouseholdCharge;
  managerId: string | null;
  dedupId: string;
  managerName: string;
  managerSmsFromNumber: string;
  apiKey: string;
  from: string;
  subject: string;
  text: string;
  html: string;
  slotLabel: string;
  /** Defaults to 'payments'. Email/SMS follow the resident's per-category preference. */
  eventCategory?: NotificationCategory;
  /** Manager-level channel gates from reminder settings. */
  managerDeliverViaEmail?: boolean;
  managerDeliverViaSms?: boolean;
  /** Combined reminders already include portal pay copy — skip per-charge Zelle/Venmo blocks. */
  skipManualPaymentInstructions?: boolean;
  /** Extra dedup rows to record when one send covers several charges. */
  bundledDedupEntries?: { dedupId: string; chargeId: string }[];
}): Promise<{ sent: boolean; error?: string }> {
  const { db, charge, managerId, dedupId, managerName, managerSmsFromNumber, apiKey, from, subject, slotLabel } =
    input;
  const text = input.skipManualPaymentInstructions
    ? input.text
    : appendManualPaymentInstructions(input.text, charge);
  const html = reminderHtmlFromText(text);
  if (!isUnpaidHouseholdCharge(charge)) {
    return { sent: false, error: "charge_paid" };
  }
  const residentLower = charge.residentEmail.trim().toLowerCase();

  // Resolve the resident's account + saved preferences once. Account-less
  // residents (no profile row) fall back to the category default (email ON,
  // never SMS). Inbox is always written regardless.
  const category: NotificationCategory = input.eventCategory ?? "payments";
  const { data: residentProfile } = await db
    .from("profiles")
    .select("id, phone, phone_verified_at")
    .eq("email", residentLower)
    .maybeSingle();
  const residentUserId = String(residentProfile?.id ?? "").trim() || null;
  const channels = residentUserId
    ? await resolveChannels(db, residentUserId, category, {
        phone: (residentProfile?.phone as string | null) ?? null,
        phone_verified_at: (residentProfile?.phone_verified_at as string | null) ?? null,
      })
    : { inbox: true, email: DEFAULT_NOTIFICATION_PREFERENCES[category].email, sms: false };

  const managerDeliverViaEmail = input.managerDeliverViaEmail !== false;
  const managerDeliverViaSms = input.managerDeliverViaSms === true;
  const emailAllowed = managerDeliverViaEmail && channels.email;
  const smsAllowed = managerDeliverViaSms && channels.sms;

  let emailSent = false;
  if (apiKey && emailAllowed) {
    try {
      const res = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ from, to: [residentLower], subject, text, html }),
      });
      emailSent = res.ok;
      // Soft-fail: still write Axis inbox + SMS when Resend rejects the address.
    } catch {
      emailSent = false;
    }
  }

  const ts = Date.now();
  const rand = crypto.randomUUID().slice(0, 8);
  const when = formatPacificDateTime(new Date());
  const preview = text.slice(0, 100).replace(/\n/g, " ");
  const managerEmail = from.match(/<([^>]+)>/)?.[1] ?? from;

  try {
    await deliverPortalMessageThreadSide(db, {
      scope: "axis_portal_inbox_resident_v1",
      folder: "inbox",
      ownerUserId: residentUserId,
      participantEmail: residentLower,
      otherPartyEmail: managerEmail.trim().toLowerCase(),
      fallbackId: `payment_auto_reminder_inbox_${ts}_${rand}`,
      fromName: managerName,
      subject,
      body: text,
      preview,
      when,
      unread: true,
      outbound: false,
    });
  } catch {
    /* non-critical */
  }

  try {
    if (managerId && process.env.SMS_RUNTIME_ENABLED?.trim() !== "1") {
      await deliverPortalMessageThreadSide(db, {
        scope: "axis_portal_inbox_manager_v1",
        folder: "sent",
        ownerUserId: managerId,
        participantEmail: null,
        otherPartyEmail: residentLower,
        fallbackId: `payment_auto_reminder_sent_${ts}_${rand}`,
        fromName: managerName,
        subject,
        body: text,
        preview,
        when,
        unread: false,
        outbound: true,
      });
    }
  } catch {
    /* non-critical */
  }

  const dedupEntries = [{ dedupId, chargeId: charge.id }, ...(input.bundledDedupEntries ?? [])];

  try {
    const sentAt = new Date().toISOString();
    await db.from("portal_outbound_mail_records").upsert(
      dedupEntries.map((entry) => ({
        id: entry.dedupId,
        recipient_email: residentLower,
        subject,
        channel: "email",
        row_data: {
          id: entry.dedupId,
          to: residentLower,
          subject,
          body: text,
          sentAt,
          emailSent,
          chargeId: entry.chargeId,
          slot: slotLabel,
        },
      })),
      { onConflict: "id" },
    );
  } catch {
    if (!emailSent && !apiKey) {
      return { sent: false, error: "Could not record the reminder send." };
    }
  }

  let smsDelivered = false;
  if (canSendResidentOutboundSms(managerSmsFromNumber) && smsAllowed) {
    try {
      const residentPhone = String(residentProfile?.phone ?? "").trim();
      if (residentPhone) {
        const smsBody = `(${subject})\n${text.slice(0, 300)}`;
        const smsResult = await sendResidentOutboundSms({
          to: residentPhone,
          text: smsBody,
          fromNumber: managerSmsFromNumber,
          linkKind: category === "leases" ? "lease" : "payments",
          openThread: managerId
            ? {
                managerUserId: managerId,
                residentUserId,
                residentEmail: residentLower,
                topic: category === "leases" ? "lease" : "payment",
              }
            : null,
        });
        if (smsResult.sent) {
          smsDelivered = true;
          const smsLogId = `${dedupId}_sms`;
          await db.from("portal_outbound_mail_records").upsert(
            {
              id: smsLogId,
              recipient_email: residentLower,
              subject,
              channel: "sms",
              row_data: {
                id: smsLogId,
                to: residentPhone,
                subject,
                body: smsBody,
                sentAt: new Date().toISOString(),
                smsSent: true,
                smsChannel: smsResult.channel ?? null,
                chargeId: charge.id,
                slot: slotLabel,
              },
            },
            { onConflict: "id" },
          );
        }
      }
    } catch {
      /* non-critical */
    }
  }

  try {
    if (managerId) {
      await notifyManagerFromAgent(db, {
        landlordId: managerId,
        subject: "Payment reminder sent",
        text: `${subject} was sent to ${residentLower}.`,
        category: "payment_reminders",
        url: "/portal/payments",
      });
    }
  } catch {
    /* non-critical */
  }

  try {
    if (residentUserId) {
      const pushBody = text.replace(/\s+/g, " ").trim().slice(0, 180);
      await sendPushToUser(residentUserId, {
        title: subject,
        body: pushBody || `Payment reminder for ${charge.title}`,
        url: "/resident/payments",
        data: { chargeId: charge.id, slot: slotLabel },
      });
    }
  } catch {
    /* non-critical — no-ops when FCM is not configured */
  }

  // An account-less resident (no profile row) can't see the portal inbox — if
  // the email failed and no SMS went out, nothing actually reached them. Drop
  // every dedup row this send wrote (a bundle records one per charge, and the
  // cron skips the whole bundle if ANY of them survives) so the next run
  // retries instead of recording a phantom send.
  if (!emailSent && !smsDelivered && !residentUserId) {
    try {
      await db
        .from("portal_outbound_mail_records")
        .delete()
        .in(
          "id",
          dedupEntries.map((entry) => entry.dedupId),
        );
    } catch {
      /* keep the row — a duplicate reminder beats silently never retrying */
    }
    return { sent: false, error: "email_failed_no_other_channel" };
  }

  return { sent: true };
}

function escapeHtmlText(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function reminderHtmlFromText(text: string): string {
  const htmlBody = text
    .split("\n")
    .map((line) => (line.trim() ? `<p>${escapeHtmlText(line)}</p>` : ""))
    .join("\n");
  return `<!DOCTYPE html><html><body style="font-family:sans-serif;max-width:560px;margin:0 auto;padding:24px;color:#1e293b">\n${htmlBody}\n</body></html>`;
}

export function chargeDueLabelSafe(charge: HouseholdCharge): string {
  return chargeDueLabel(charge);
}
