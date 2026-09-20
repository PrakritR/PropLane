import { chargeDueLabel, isUnpaidHouseholdCharge, type HouseholdCharge } from "@/lib/household-charges";
import { formatPacificDateTime } from "@/lib/pacific-time";
import { sendPushToUser } from "@/lib/push-notifications.server";
import type { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { enqueueOwnerSms } from "@/lib/sms/owner-sms-dispatcher.server";
import {
  DEFAULT_NOTIFICATION_PREFERENCES,
  resolveChannels,
  type NotificationCategory,
} from "@/lib/notification-preferences";
import { deliverPortalMessageThreadSide } from "@/lib/portal-inbox-delivery";
import { notifyPropertyScopedManagersFromAgent } from "@/lib/co-manager-notification-recipients.server";
import { resolveShareableAppOrigin } from "@/lib/app-url";
import { traceSystemNotification } from "@/lib/observability/langfuse";
import { createHouseholdChargeCheckout } from "@/lib/stripe-household-charge-checkout.server";
import {
  claimPaymentReminderChannel,
  paymentReminderOccurrenceId,
  resolvePaymentReminderChannel,
  type PaymentReminderChannel,
} from "@/lib/payment-reminder-occurrence.server";

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
  managerDeliverViaInbox?: boolean;
  /** Extra dedup rows to record when one send covers several charges. */
  bundledDedupEntries?: { dedupId: string; chargeId: string }[];
}): Promise<{ sent: boolean; error?: string }> {
  const { db, charge, managerId, dedupId, managerName, managerSmsFromNumber, apiKey, from, subject, slotLabel } =
    input;
  const text = input.text;
  const html = reminderHtmlFromText(text);
  if (!isUnpaidHouseholdCharge(charge)) {
    return { sent: false, error: "charge_paid" };
  }
  if (!managerId) return { sent: false, error: "manager_missing" };
  const ownerManagerId = managerId;
  const residentLower = charge.residentEmail.trim().toLowerCase();
  const dedupEntries = [{ dedupId, chargeId: charge.id }, ...(input.bundledDedupEntries ?? [])];
  const occurrence = {
    id: paymentReminderOccurrenceId(ownerManagerId, dedupId),
    managerUserId: ownerManagerId,
    recipientEmail: residentLower,
    chargeIds: [...new Set(dedupEntries.map((entry) => entry.chargeId))],
    dedupIds: [...new Set(dedupEntries.map((entry) => entry.dedupId))],
    subject,
    body: text,
  };
  const states = new Map<PaymentReminderChannel, string>();
  const claim = async (channel: PaymentReminderChannel) => {
    const result = await claimPaymentReminderChannel(db, occurrence, channel);
    states.set(channel, result.outcome);
    return result;
  };
  const resolve = async (
    channel: PaymentReminderChannel,
    token: string,
    status: "submitted" | "failed" | "unknown" | "skipped",
    providerReference?: string | null,
    errorMessage?: string | null,
  ) => {
    await resolvePaymentReminderChannel(db, occurrence.id, channel, token, status, providerReference, errorMessage);
    states.set(channel, status);
  };

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
  const managerDeliverViaInbox = input.managerDeliverViaInbox !== false;
  const emailAllowed = managerDeliverViaEmail && channels.email;
  const smsAllowed = managerDeliverViaSms && channels.sms;
  const inboxAllowed = managerDeliverViaInbox && channels.inbox;

  let emailSent = false;
  if (apiKey && emailAllowed) {
    const emailClaim = await claim("email");
    if (emailClaim.outcome === "submitted") {
      emailSent = true;
    } else if (emailClaim.outcome === "claimed" && emailClaim.token) {
      try {
        const res = await fetch("https://api.resend.com/emails", {
          method: "POST",
          headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
          body: JSON.stringify({ from, to: [residentLower], subject, text, html }),
        });
        if (res.ok) {
          const response = await res.json().catch(() => null) as { id?: string } | null;
          await resolve("email", emailClaim.token, "submitted", response?.id ?? null);
          emailSent = true;
        } else {
          // Server errors can follow an accepted request. Hold for reconciliation.
          await resolve("email", emailClaim.token, res.status >= 500 ? "unknown" : "failed", null, `resend_http_${res.status}`);
        }
      } catch (error) {
        // Network timeouts do not prove non-submission. Never retry them blindly.
        await resolve("email", emailClaim.token, "unknown", null, error instanceof Error ? error.message : String(error));
      }
    }
  }

  const when = formatPacificDateTime(new Date());
  const preview = text.slice(0, 100).replace(/\n/g, " ");
  const managerEmail = from.match(/<([^>]+)>/)?.[1] ?? from;

  let inboxWritten = false;
  let inboxWrittenNow = false;
  if (inboxAllowed && residentUserId) {
    const inboxClaim = await claim("inbox");
    if (inboxClaim.outcome === "submitted") {
      inboxWritten = true;
    } else if (inboxClaim.outcome === "claimed" && inboxClaim.token) {
      try {
      await deliverPortalMessageThreadSide(db, {
        scope: "axis_portal_inbox_resident_v1",
        folder: "inbox",
        ownerUserId: residentUserId,
        participantEmail: residentLower,
        otherPartyEmail: managerEmail.trim().toLowerCase(),
        fallbackId: `payment_auto_reminder_inbox_${dedupId}`,
        fromName: managerName,
        subject,
        body: text,
        preview,
        when,
        unread: true,
        outbound: false,
      });
      await deliverPortalMessageThreadSide(db, {
        scope: "axis_portal_inbox_manager_v1",
        folder: "sent",
        ownerUserId: managerId,
        participantEmail: null,
        otherPartyEmail: residentLower,
        fallbackId: `payment_auto_reminder_sent_${dedupId}`,
        fromName: managerName,
        subject,
        body: text,
        preview,
        when,
        unread: false,
        outbound: true,
      });
      await resolve("inbox", inboxClaim.token, "submitted");
      inboxWritten = true;
      inboxWrittenNow = true;
      } catch (error) {
        // The thread write may have committed before its result was lost.
        await resolve("inbox", inboxClaim.token, "unknown", null, error instanceof Error ? error.message : String(error));
      }
    }
  }

  let smsDelivered = false;
  if (smsAllowed) {
    const smsClaim = await claim("sms");
    if (smsClaim.outcome === "submitted") {
      smsDelivered = true;
    } else if (smsClaim.outcome === "claimed" && smsClaim.token) {
      try {
      const residentPhone = String(residentProfile?.phone ?? "").trim();
      if (residentPhone && managerSmsFromNumber) {
        let checkoutUrl: string | null = null;
        if (category === "payments" && managerId && residentUserId) {
          try {
            const checkout = await createHouseholdChargeCheckout(db, {
              userId: residentUserId,
              userEmail: residentLower,
              chargeIds: [charge.id],
              mode: "hosted",
              paymentMethod: "ach",
              expectedManagerUserId: managerId,
              appOrigin: resolveShareableAppOrigin(),
            });
            if (checkout.ok && checkout.mode === "hosted") checkoutUrl = checkout.url;
          } catch {
            // A reminder remains useful when Stripe/Connect is unavailable.
            // Keep delivery on the existing text-only path and try again next cadence.
          }
        }

        const smsBody = [
          `(${subject})`,
          text.slice(0, 300),
          checkoutUrl ? `Pay securely: ${checkoutUrl}` : null,
        ]
          .filter((line): line is string => Boolean(line))
          .join("\n");
        const smsResult = await traceSystemNotification({
          domain: "payment_reminder",
          managerUserId: ownerManagerId,
          recipientUserId: residentUserId,
          entityId: charge.id,
          cadence: slotLabel,
          run: () => enqueueOwnerSms({
            managerUserId: managerId,
            actorUserId: managerId,
            recipientPhone: residentPhone,
            recipientUserId: residentUserId,
            recipientEmail: residentLower,
            body: smsBody,
            sendClass: "transactional",
            purpose: "payment_reminder",
            counterpartyRole: "resident",
            propertyId: charge.propertyId || null,
            dedupeKey: `${occurrence.id}:sms`,
          }),
          summarize: (result) => ({
            ok: result.ok,
            deliveredChannels: ["inbox", ...(emailSent ? ["email"] : []), ...(result.ok ? ["sms"] : [])],
            smsChannel: result.ok ? "outbox" : null,
            checkoutIncluded: Boolean(checkoutUrl),
          }),
        });
        if (smsResult.ok) {
          await resolve("sms", smsClaim.token, "submitted", smsResult.outboxId);
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
                smsSubmitted: true,
                smsOutboxId: smsResult.outboxId,
                chargeId: charge.id,
                slot: slotLabel,
              },
            },
            { onConflict: "id" },
          );
        } else {
          const safeFailure = ["invalid_message", "invalid_dispatch_identity", "recipient_opted_out", "scoped_consent_missing", "allowance_exhausted", "runtime_env_paused", "outbox_scheduler_unready"].includes(smsResult.error);
          await resolve("sms", smsClaim.token, safeFailure ? "failed" : "unknown", null, smsResult.error);
        }
      } else {
        await resolve("sms", smsClaim.token, "failed", null, residentPhone ? "number_missing" : "recipient_phone_missing");
      }
      } catch (error) {
        if (states.get("sms") === "claimed") {
          await resolve("sms", smsClaim.token, "unknown", null, error instanceof Error ? error.message : String(error));
        }
      }
    }
  }

  const inboxDelivered = inboxWritten && Boolean(residentUserId);
  const anyChannelEnabled = emailAllowed || smsAllowed || (inboxAllowed && Boolean(residentUserId));
  const deliveryComplete =
    (!emailAllowed || states.get("email") === "submitted") &&
    (!smsAllowed || states.get("sms") === "submitted") &&
    (!(inboxAllowed && residentUserId) || states.get("inbox") === "submitted");
  const anySubmitted = emailSent || smsDelivered || inboxDelivered;
  const sentAt = new Date().toISOString();
  const { error: dedupError } = await db.from("portal_outbound_mail_records").upsert(
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
        ...(anySubmitted ? { sentAt } : { attemptedAt: sentAt }),
        emailSent,
        smsSubmitted: smsDelivered,
        inboxWritten: inboxDelivered,
        deliveryComplete: deliveryComplete || !anyChannelEnabled,
        occurrenceId: occurrence.id,
        chargeId: entry.chargeId,
        slot: slotLabel,
      },
    })),
    { onConflict: "id" },
  );
  if (dedupError) {
    return { sent: anySubmitted, error: `Could not record the reminder send: ${dedupError.message}` };
  }

  try {
    if (anySubmitted) {
      await notifyPropertyScopedManagersFromAgent(db, {
        ownerManagerUserId: managerId,
        propertyId: charge.propertyId,
        module: "payments",
        subject: "Payment reminder sent",
        text: `${subject} was sent to ${residentLower}.`,
        category: "payment_reminders",
        url: "/portal/payments",
        idempotencyKey: dedupId,
      });
    }
  } catch {
    /* non-critical */
  }

  try {
    if (residentUserId && inboxWrittenNow) {
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

  // The inbox write sits in a swallowing try/catch, so "allowed" is not
  // "delivered" — reporting the former marked a throw as a successful send.
  // Nothing was even ATTEMPTED: the manager turned every channel off, or the
  // resident's own preferences leave none open. Retrying cannot change that, so
  // keep the dedup rows. Deleting them here made the cron re-process this same
  // charge on every run, forever, delivering nothing each time.
  if (!anyChannelEnabled) {
    return { sent: false, error: "no_channel_enabled" };
  }

  // A partial or failed occurrence retains its row with deliveryComplete=false.
  // The next run re-projects it, and only channels with a confirmed safe failure
  // are claimable again. Unknown provider outcomes stay held for reconciliation.
  if (!emailSent && !smsDelivered && !inboxDelivered) {
    return {
      sent: false,
      error: residentUserId ? "no_channel_delivered" : "email_failed_no_other_channel",
    };
  }
  return { sent: true, ...(deliveryComplete ? {} : { error: "partial_delivery" }) };
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
