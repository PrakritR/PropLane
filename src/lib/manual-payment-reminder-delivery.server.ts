import "server-only";

import { formatPacificDateTime } from "@/lib/pacific-time";
import { deliverPortalMessageThreadSide } from "@/lib/portal-inbox-delivery";
import { claimPaymentReminderChannel, resolvePaymentReminderChannel } from "@/lib/payment-reminder-occurrence.server";
import { enqueueOwnerSms } from "@/lib/sms/owner-sms-dispatcher.server";
import type { createSupabaseServiceRoleClient } from "@/lib/supabase/service";

type ServiceDb = ReturnType<typeof createSupabaseServiceRoleClient>;
type Status = "submitted" | "failed" | "unknown" | "skipped" | "claimed";
type ChannelResult = { status: Status; providerReference?: string | null; errorCode?: string | null };

export type ManualPaymentReminderDeliveryResult = {
  occurrenceId: string;
  conflict: boolean;
  email: ChannelResult;
  sms: ChannelResult & { outboxId?: string | null; sent: boolean; queued: boolean };
  inbox: ChannelResult;
};

export type ManualPaymentReminderDeliveryInput = {
  db: ServiceDb;
  ownerUserId: string;
  actorUserId: string;
  requestId: string;
  chargeIds: string[];
  propertyId: string;
  /** Stable recipient identity; may be `sms:<E164>` for an SMS-only record. */
  recipientEmail: string;
  inboxEmail: string;
  recipientPhone: string;
  residentUserId: string | null;
  managerEmail: string;
  managerName: string;
  subject: string;
  text: string;
  smsText: string;
  wantEmail: boolean;
  wantSms: boolean;
  canEmailExternally: boolean;
  smsFromNumber: string | null;
  /** Resolved for the workspace owner immediately before provider submission. */
  from: string;
};

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function isConflict(outcome: string): boolean {
  return outcome === "revision_conflict" || outcome === "overlap";
}

/** Manual and scheduled reminders share the same atomic channel claim ledger. */
export async function deliverManualPaymentReminder(input: ManualPaymentReminderDeliveryInput): Promise<ManualPaymentReminderDeliveryResult> {
  const { db } = input;
  const recipientEmail = input.recipientEmail.trim().toLowerCase();
  const inboxEmail = input.inboxEmail.trim().toLowerCase();
  const chargeIds = [...new Set(input.chargeIds)].sort();
  const occurrenceId = `payment:manual:${input.ownerUserId}:${input.requestId}`;
  const occurrence = {
    id: occurrenceId,
    managerUserId: input.ownerUserId,
    recipientEmail,
    chargeIds,
    dedupIds: chargeIds.map((chargeId) => `${occurrenceId}:${chargeId}`),
    subject: input.subject,
    body: input.text,
  };
  const result: ManualPaymentReminderDeliveryResult = {
    occurrenceId,
    conflict: false,
    email: { status: "skipped" },
    sms: { status: "skipped", sent: false, queued: false },
    inbox: { status: "skipped" },
  };

  if (input.wantEmail) {
    const claim = await claimPaymentReminderChannel(db, occurrence, "email");
    if (isConflict(claim.outcome)) return { ...result, conflict: true };
    if (claim.outcome === "submitted") {
      result.email = { status: "submitted" };
    } else if (claim.outcome === "claimed" && claim.token) {
      if (!input.canEmailExternally) {
        await resolvePaymentReminderChannel(db, occurrenceId, "email", claim.token, "skipped", null, "external_email_suppressed");
        result.email = { status: "skipped", errorCode: "external_email_suppressed" };
      } else if (!process.env.RESEND_API_KEY?.trim()) {
        await resolvePaymentReminderChannel(db, occurrenceId, "email", claim.token, "failed", null, "resend_not_configured");
        result.email = { status: "failed", errorCode: "resend_not_configured" };
      } else {
        const html = `<p style="white-space:pre-wrap;font-family:sans-serif;font-size:15px;line-height:1.6;color:#1e293b">${escapeHtml(input.text)}</p><hr style="margin:24px 0;border:none;border-top:1px solid #e2e8f0"><p style="font-family:sans-serif;font-size:12px;color:#94a3b8">Sent via PropLane portal by ${escapeHtml(input.managerName)}</p>`;
        const apiKey = process.env.RESEND_API_KEY.trim();
        try {
          const response = await fetch("https://api.resend.com/emails", {
            method: "POST",
            headers: {
              Authorization: `Bearer ${apiKey}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              from: input.from,
              to: [inboxEmail], subject: input.subject, text: input.text, html,
            }),
            signal: AbortSignal.timeout(15_000),
          });
          if (response.ok) {
            const data = await response.json().catch(() => null) as { id?: string } | null;
            await resolvePaymentReminderChannel(db, occurrenceId, "email", claim.token, "submitted", data?.id ?? null);
            result.email = { status: "submitted", providerReference: data?.id ?? null };
          } else {
            const status: "failed" | "unknown" = response.status >= 500 ? "unknown" : "failed";
            const errorCode = `resend_http_${response.status}`;
            await resolvePaymentReminderChannel(db, occurrenceId, "email", claim.token, status, null, errorCode);
            result.email = { status, errorCode };
          }
        } catch {
          // A timeout after submission is unknowable: never convert it to a retry.
          await resolvePaymentReminderChannel(db, occurrenceId, "email", claim.token, "unknown", null, "resend_outcome_unknown");
          result.email = { status: "unknown", errorCode: "resend_outcome_unknown" };
        }
      }
    } else {
      result.email = { status: claim.outcome as Status };
    }
  }

  if (input.wantSms) {
    const claim = await claimPaymentReminderChannel(db, occurrence, "sms");
    if (isConflict(claim.outcome)) return { ...result, conflict: true };
    if (claim.outcome === "submitted") {
      result.sms = { status: "submitted", sent: false, queued: true };
    } else if (claim.outcome === "claimed" && claim.token) {
      if (!input.recipientPhone || !input.smsFromNumber) {
        await resolvePaymentReminderChannel(db, occurrenceId, "sms", claim.token, "failed", null, "sms_capability_changed");
        result.sms = { status: "failed", sent: false, queued: false, errorCode: "sms_capability_changed" };
      } else {
        try {
          const sms = await enqueueOwnerSms({
            managerUserId: input.ownerUserId,
            actorUserId: input.actorUserId,
            recipientPhone: input.recipientPhone,
            recipientUserId: input.residentUserId,
            recipientEmail: inboxEmail || null,
            body: input.smsText,
            sendClass: "transactional",
            purpose: "payment_reminder",
            counterpartyRole: "resident",
            propertyId: input.propertyId || null,
            dedupeKey: `${occurrenceId}:sms`,
          });
          if (sms.ok) {
            await resolvePaymentReminderChannel(db, occurrenceId, "sms", claim.token, "submitted");
            result.sms = { status: "submitted", outboxId: sms.outboxId, sent: sms.status === "sent", queued: true };
          } else {
            // A returned policy rejection is pre-submit. Unexpected failures
            // may follow an outbox insert, so hold them for reconciliation.
            const safeFailure = ["invalid_message", "invalid_dispatch_identity", "recipient_opted_out", "scoped_consent_missing", "allowance_exhausted", "runtime_env_paused", "outbox_scheduler_unready"].includes(sms.error);
            const status = safeFailure ? "failed" : "unknown";
            await resolvePaymentReminderChannel(db, occurrenceId, "sms", claim.token, status, null, sms.error);
            result.sms = { status, sent: false, queued: false, errorCode: sms.error };
          }
        } catch {
          await resolvePaymentReminderChannel(db, occurrenceId, "sms", claim.token, "unknown", null, "sms_outcome_unknown");
          result.sms = { status: "unknown", sent: false, queued: false, errorCode: "sms_outcome_unknown" };
        }
      }
    } else {
      result.sms = { status: claim.outcome as Status, sent: false, queued: false };
    }
  }

  if (inboxEmail) {
    const claim = await claimPaymentReminderChannel(db, occurrence, "inbox");
    if (isConflict(claim.outcome)) return { ...result, conflict: true };
    if (claim.outcome === "submitted") {
      result.inbox = { status: "submitted" };
    } else if (claim.outcome === "claimed" && claim.token) {
      const when = formatPacificDateTime(new Date());
      const preview = input.text.slice(0, 100).replace(/\n/g, " ");
      try {
        await deliverPortalMessageThreadSide(db, {
          scope: "axis_portal_inbox_manager_v1", folder: "sent", ownerUserId: input.ownerUserId,
          participantEmail: null, otherPartyEmail: inboxEmail,
          fallbackId: `${occurrenceId}:manager`, fromName: input.managerName,
          subject: input.subject, body: input.text, preview, when, unread: false, outbound: true,
        });
        if (inboxEmail !== input.managerEmail.trim().toLowerCase()) {
          await deliverPortalMessageThreadSide(db, {
            scope: "axis_portal_inbox_resident_v1", folder: "inbox", ownerUserId: input.residentUserId,
            participantEmail: inboxEmail, otherPartyEmail: input.managerEmail.trim().toLowerCase(),
            fallbackId: `${occurrenceId}:resident`, fromName: input.managerName,
            subject: input.subject, body: input.text, preview, when, unread: true, outbound: false,
          });
        }
        await resolvePaymentReminderChannel(db, occurrenceId, "inbox", claim.token, "submitted");
        result.inbox = { status: "submitted" };
      } catch {
        await resolvePaymentReminderChannel(db, occurrenceId, "inbox", claim.token, "unknown", null, "inbox_outcome_unknown");
        result.inbox = { status: "unknown", errorCode: "inbox_outcome_unknown" };
      }
    } else {
      result.inbox = { status: claim.outcome as Status };
    }
  }

  return result;
}
