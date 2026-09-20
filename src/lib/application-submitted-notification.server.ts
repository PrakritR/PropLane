/**
 * Notify property managers when an applicant submits a rental application:
 * Resend email + a Communication inbox thread with the applicant (same person-thread
 * model as portal messaging).
 */

import type { DemoApplicantRow } from "@/data/demo-portal";
import { formatPacificDateTime } from "@/lib/pacific-time";
import {
  resolveManagerRecipientProfiles,
  resolvePropertyLeadRecipientIds,
} from "@/lib/co-manager-notification-recipients.server";
import { resolveEmailLinkBaseUrl } from "@/lib/app-url";
import { deliverPortalMessageThreadSide } from "@/lib/portal-inbox-delivery";
import { getBundleChoiceLabel, getPropertyById, getRoomChoiceLabel } from "@/lib/rental-application/data";
import { isSubmittedPendingApplicationRow } from "@/lib/rental-application/in-progress-application";
import { sendManagerNotificationSms } from "@/lib/manager-notification-routing.server";
import { fetchManagerSmsConversations } from "@/lib/manager-sms-messages.server";
import { resolveExistingSmsConversation } from "@/lib/sms/existing-conversation.server";
import { postResendEmail } from "@/lib/resend-delivery.server";

const MANAGER_INBOX_SCOPE = "axis_portal_inbox_manager_v1";

type Db = ReturnType<typeof import("@/lib/supabase/service").createSupabaseServiceRoleClient>;

async function deliverEmail(to: string[], subject: string, text: string, actorUserId: string): Promise<{ sent: boolean; skipped: boolean }> {
  const recipients = to.map((e) => e.trim().toLowerCase()).filter((e) => e.includes("@") && !e.endsWith("@axis.local"));
  if (recipients.length === 0) return { sent: false, skipped: true };
  const apiKey = process.env.RESEND_API_KEY?.trim();
  if (!apiKey) return { sent: false, skipped: true };
  const from = process.env.RESEND_FROM?.trim() || "PropLane <onboarding@resend.dev>";
  const res = await postResendEmail({
    apiKey,
    actorUserId,
    payload: { from, to: recipients, subject, text },
    effectSummary: "Application submitted email captured for the test workspace.",
  });
  if (!res.ok) return { sent: false, skipped: false };
  return { sent: true, skipped: false };
}

export function applicationSubmittedManagerSubject(propertyLabel: string): string {
  const property = propertyLabel.trim() || "your listing";
  return `New rental application — ${property}`;
}

export function buildApplicationSubmittedManagerBody(input: {
  row: DemoApplicantRow;
  origin: string;
}): string {
  const row = input.row;
  const name = row.name?.trim() || "Applicant";
  const email = row.email?.trim() || "";
  const phone = row.application?.phone?.trim() || "";
  const propertyId = row.assignedPropertyId?.trim() || row.propertyId?.trim() || row.application?.propertyId?.trim() || "";
  const propertyRecord = propertyId ? getPropertyById(propertyId) : undefined;
  const propertyTitle =
    row.property?.trim() ||
    propertyRecord?.title?.trim() ||
    propertyRecord?.address?.trim() ||
    propertyId ||
    "Property";
  const roomChoice = row.application?.roomChoice1?.trim() || row.assignedRoomChoice?.trim() || "";
  const bundleId = row.application?.bundleId?.trim() || "";
  const room =
    (roomChoice ? getRoomChoiceLabel(roomChoice) : "") ||
    (bundleId && propertyId ? getBundleChoiceLabel(propertyId, bundleId) : "") ||
    "";
  const placement = [propertyTitle, room].filter(Boolean).join(" · ");
  const applicationsUrl = `${input.origin.replace(/\/$/, "")}/portal/applications`;
  const communicationUrl = `${input.origin.replace(/\/$/, "")}/portal/communication/active`;

  const lines = [
    `A rental application was submitted for ${placement}.`,
    "",
    `Applicant: ${name}`,
    email ? `Email: ${email}` : null,
    phone ? `Phone: ${phone}` : null,
    `Application ID: ${row.id.trim()}`,
    "",
    "Review the full application in PropLane:",
    applicationsUrl,
    "",
    "This message also starts (or continues) your Communication thread with this applicant — reply there to keep everything in one place.",
    communicationUrl,
    "",
    "— PropLane",
  ].filter((line): line is string => Boolean(line));

  return lines.join("\n");
}

export function shouldNotifyManagerOfApplicationSubmit(
  previous: DemoApplicantRow | null | undefined,
  next: DemoApplicantRow,
): boolean {
  if (!isSubmittedPendingApplicationRow(next)) return false;
  if (!next.managerUserId?.trim()) return false;
  if (previous && isSubmittedPendingApplicationRow(previous)) return false;
  return true;
}

export async function notifyManagerApplicationSubmitted(
  db: Db,
  row: DemoApplicantRow,
): Promise<{ ok: boolean; skipped?: boolean }> {
  const managerUserId = row.managerUserId?.trim();
  const applicantEmail = row.email?.trim().toLowerCase();
  if (!managerUserId || !applicantEmail?.includes("@")) {
    return { ok: false, skipped: true };
  }

  const propertyId = row.assignedPropertyId?.trim() || row.propertyId?.trim() || row.application?.propertyId?.trim() || "";
  const recipientIds = await resolvePropertyLeadRecipientIds(db, {
    ownerManagerUserId: managerUserId,
    propertyId: propertyId || undefined,
  });
  const recipients = await resolveManagerRecipientProfiles(db, recipientIds);
  if (recipients.length === 0) return { ok: false, skipped: true };

  const origin = resolveEmailLinkBaseUrl();
  const applicantName = row.name?.trim() || applicantEmail;
  const propertyRecord = propertyId ? getPropertyById(propertyId) : undefined;
  const propertyLabel =
    row.property?.trim() ||
    propertyRecord?.title?.trim() ||
    propertyRecord?.address?.trim() ||
    "your listing";
  const subject = applicationSubmittedManagerSubject(propertyLabel);
  const text = buildApplicationSubmittedManagerBody({ row, origin });
  const when = formatPacificDateTime(new Date());
  const preview = text.slice(0, 100).replace(/\n/g, " ");
  const messageId = `application-submitted-${row.id.trim()}`;
  const applicantPhone = row.application?.phone?.trim() || "";

  for (const recipient of recipients) {
    let smsConversationKey: string | undefined;
    // A resolved native conversation owns its role forever. An application may
    // change the directory label to Applicant, but it must not rewrite a
    // prospect conversation's relationship provenance just to make the email
    // notice fold with it.
    let smsCounterpartyRole: string | undefined;
    if (applicantPhone) {
      try {
        const sms = await fetchManagerSmsConversations(db, recipient.userId, {
          scopeManagerIdsOverride: [recipient.userId],
          visibility: "none",
          provisionWorkNumber: false,
        });
        const resolution = resolveExistingSmsConversation(sms.residents, {
          managerUserId: recipient.userId,
          recipientPhone: applicantPhone,
          workNumber: sms.workNumber,
          allowedRoles: ["prospect", "applicant"],
        });
        if (resolution.kind === "matched") {
          smsConversationKey = resolution.conversation.conversationKey;
          smsCounterpartyRole = resolution.conversation.counterpartyRole;
        }
      } catch {
        // Inbox/email notification is durable without an SMS binding. A failed
        // lookup must never borrow another recipient's owner-scoped key.
      }
    }
    await deliverPortalMessageThreadSide(db, {
      scope: MANAGER_INBOX_SCOPE,
      folder: "inbox",
      ownerUserId: recipient.userId,
      participantEmail: recipient.email,
      otherPartyEmail: applicantEmail,
      fallbackId: `app_submit_${row.id}_${recipient.userId}`,
      fromName: applicantName,
      subject,
      body: text,
      preview,
      when,
      unread: true,
      outbound: false,
      messageId,
      threadIdentity: {
        managerUserId: recipient.userId,
        ...(propertyId ? { propertyId, propertyTitle: propertyLabel } : {}),
        // Keep relationship provenance separate from the applicant's current
        // directory status. A matched prospect key remains a prospect key.
        counterpartyRole: smsCounterpartyRole ?? "applicant",
        ...(smsConversationKey ? { smsConversationKey } : {}),
      },
    });
  }

  await deliverEmail(
    recipients.map((r) => r.email),
    subject,
    text,
    managerUserId,
  );

  await Promise.all(
    recipients.map((recipient) =>
      sendManagerNotificationSms(db, {
        managerUserId: recipient.userId,
        category: "applications",
        subject,
        text: `A new application from ${applicantName} is ready to review in PropLane.`,
        purpose: "application_submitted_manager_notification",
      }).catch(() => undefined),
    ),
  );

  return { ok: true };
}
