/**
 * Notify property manager when a prospect sends a leasing message.
 */

import { resolveEmailLinkBaseUrl } from "@/lib/app-url";

import { appendManagerPropertyLeadInboxMessage } from "@/lib/property-manager-inbox-thread.server";
import {
  resolveManagerRecipientProfiles,
  resolvePropertyLeadRecipientIds,
} from "@/lib/co-manager-notification-recipients.server";
import { sendManagerNotificationSms } from "@/lib/manager-notification-routing.server";

type Db = ReturnType<typeof import("@/lib/supabase/service").createSupabaseServiceRoleClient>;

async function deliverEmail(to: string[], subject: string, text: string): Promise<void> {
  const recipients = to.map((e) => e.trim().toLowerCase()).filter((e) => e.includes("@"));
  if (recipients.length === 0) return;
  const apiKey = process.env.RESEND_API_KEY?.trim();
  if (!apiKey) return;
  const from = process.env.RESEND_FROM?.trim() || "PropLane <onboarding@resend.dev>";
  await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from, to: recipients, subject, text }),
  }).catch(() => undefined);
}

async function upsertManagerInbox(
  db: Db,
  managerUserId: string,
  input: {
    propertyId: string;
    propertyTitle: string;
    subject: string;
    body: string;
    fromName: string;
    fromEmail: string;
    topic: string;
  },
): Promise<void> {
  await appendManagerPropertyLeadInboxMessage(db, managerUserId, {
    propertyId: input.propertyId,
    propertyTitle: input.propertyTitle,
    prospectName: input.fromName,
    prospectEmail: input.fromEmail,
    topic: input.topic,
    subject: input.subject,
    body: input.body,
  });
}

export async function notifyManagerPropertyLeadMessage(input: {
  managerUserId: string;
  propertyId: string;
  propertyTitle?: string;
  name: string;
  email: string;
  phone?: string;
  topic: string;
  body: string;
}): Promise<void> {
  const db = (await import("@/lib/supabase/service")).createSupabaseServiceRoleClient();
  const recipientIds = await resolvePropertyLeadRecipientIds(db, {
    ownerManagerUserId: input.managerUserId,
    propertyId: input.propertyId,
  });
  const recipients = await resolveManagerRecipientProfiles(db, recipientIds);
  if (recipients.length === 0) return;

  const origin = resolveEmailLinkBaseUrl();
  const property = input.propertyTitle?.trim() || input.propertyId;
  const subject = `Leasing message — ${input.topic}`;
  const lines = [
    `New leasing message for ${property}.`,
    "",
    `From: ${input.name} (${input.email})`,
    input.phone?.trim() ? `Phone: ${input.phone.trim()}` : null,
    `Topic: ${input.topic}`,
    "",
    input.body,
    "",
    `Open your inbox: ${origin}/portal/communication/inbox/unopened`,
    "",
    "— PropLane",
  ].filter(Boolean);

  const text = lines.join("\n");
  await deliverEmail(
    recipients.map((recipient) => recipient.email),
    subject,
    text,
  );
  for (const recipient of recipients) {
    await upsertManagerInbox(db, recipient.userId, {
      propertyId: input.propertyId,
      propertyTitle: property,
      subject,
      body: text,
      fromName: input.name,
      fromEmail: input.email,
      topic: input.topic,
    });
    await sendManagerNotificationSms(db, {
      managerUserId: recipient.userId,
      category: "leasing",
      subject,
      text: `New message from ${input.name} about ${property}. Open PropLane to reply.`,
      purpose: "property_lead_manager_notification",
    }).catch(() => undefined);
  }
}
