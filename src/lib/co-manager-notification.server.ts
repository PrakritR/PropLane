/**
 * Email + Axis inbox notifications for co-manager invites and ownership transfers.
 */

import type { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { deliverPortalInboxMessage } from "@/lib/portal-inbox-delivery";
import { resolveEmailLinkBaseUrl } from "@/lib/app-url";
import { buildCoManagerInviteBody, coManagerInviteAcceptUrl, coManagerInviteSubject } from "@/lib/co-manager-link-email";
import { formatInviteMessageBody } from "@/lib/invite-message-body";

type Db = ReturnType<typeof createSupabaseServiceRoleClient>;

function appOrigin(): string {
  return resolveEmailLinkBaseUrl();
}

async function profileEmail(db: Db, userId: string): Promise<{ email: string; name: string } | null> {
  const { data } = await db.from("profiles").select("email, full_name").eq("id", userId).maybeSingle();
  const email = String(data?.email ?? "").trim().toLowerCase();
  if (!email.includes("@")) return null;
  const name = String(data?.full_name ?? "").trim() || email;
  return { email, name };
}

export async function notifyCoManagerInviteSent(input: {
  inviterUserId: string;
  inviteeUserId: string;
  inviterName: string;
  propertyLabels: string[];
  inviteId: string;
  /** The workspace the invite is into, for the text's first line. */
  workspaceName?: string;
}): Promise<void> {
  const db = (await import("@/lib/supabase/service")).createSupabaseServiceRoleClient();
  const invitee = await profileEmail(db, input.inviteeUserId);
  const inviter = await profileEmail(db, input.inviterUserId);
  if (!invitee) return;

  const subject = coManagerInviteSubject(input.inviterName);
  const text = buildCoManagerInviteBody({
    inviterName: input.inviterName,
    propertyLabels: input.propertyLabels,
    inviteId: input.inviteId,
  });

  await deliverPortalInboxMessage(db, {
    senderUserId: input.inviterUserId,
    senderEmail: inviter?.email ?? "noreply@axis.local",
    fromName: input.inviterName,
    subject,
    text,
    toEmails: [invitee.email],
    toUserIds: [input.inviteeUserId],
    // Real account/access invite — account-critical; SMS force-on for a verified invitee.
    eventCategory: "account",
  });
  await textCoManagerInvite(db, input).catch((error) => {
    console.error("co-manager invite text failed", error instanceof Error ? error.name : "unknown");
  });
}

/**
 * The invitee also gets a text from the inviter's WORK NUMBER when their phone is verified
 * (an invite that only lands in an inbox they have not opened is how a teammate stays unaware).
 * Same body as the Invite manager sheet's text (`formatInviteMessageBody`). A refusal (no work
 * number, STOP, quiet) is a quiet no; the email and inbox notice already went.
 */
async function textCoManagerInvite(
  db: Db,
  input: { inviterUserId: string; inviteeUserId: string; inviterName: string; propertyLabels: string[]; inviteId: string; workspaceName?: string },
): Promise<void> {
  const { data } = await db.from("profiles").select("phone, phone_verified_at").eq("id", input.inviteeUserId).maybeSingle();
  const phone = String((data as { phone?: unknown } | null)?.phone ?? "").trim();
  const verified = Boolean((data as { phone_verified_at?: unknown } | null)?.phone_verified_at);
  if (!phone || !verified) return;
  const { resolveManagerWorkNumber } = await import("@/lib/twilio-provisioning");
  const fromNumber = await resolveManagerWorkNumber(db, input.inviterUserId);
  if (!fromNumber) return;
  const { sendFromManagerWorkNumber } = await import("@/lib/proplane-sms-transport.server");
  await sendFromManagerWorkNumber({
    managerUserId: input.inviterUserId,
    to: phone,
    fromNumber,
    text: formatInviteMessageBody({
      kind: "workspace",
      inviterName: input.inviterName,
      workspaceName: input.workspaceName,
      propertyLabels: input.propertyLabels,
      inviteUrl: coManagerInviteAcceptUrl(input.inviteId),
    }),
    source: "work_number",
    counterpartyRole: "manager",
    purpose: "co_manager_invite_text",
    dedupeKey: `co-manager-invite-text:${input.inviteId}`,
  });
}

export async function notifyCoManagerInviteAccepted(input: {
  inviterUserId: string;
  inviteeUserId: string;
  inviteeName: string;
}): Promise<void> {
  const db = (await import("@/lib/supabase/service")).createSupabaseServiceRoleClient();
  const inviter = await profileEmail(db, input.inviterUserId);
  const invitee = await profileEmail(db, input.inviteeUserId);
  if (!inviter) return;

  const subject = `${input.inviteeName} accepted your co-manager invite`;
  const text = [
    `${input.inviteeName} accepted your co-manager link on PropLane.`,
    "",
    `Manage permissions in Co-managers: ${appOrigin()}/manager/relationships`,
    "",
    "— PropLane",
  ].join("\n");

  await deliverPortalInboxMessage(db, {
    senderUserId: input.inviteeUserId,
    senderEmail: invitee?.email ?? "noreply@axis.local",
    fromName: input.inviteeName,
    subject,
    text,
    toEmails: [inviter.email],
    toUserIds: [input.inviterUserId],
    // Informational status notice ("X accepted") — NOT account-critical, so SMS
    // stays suppressible (email default ON, SMS opt-in).
    eventCategory: "messages",
  });
}

export async function notifyPromotedToMainManager(input: {
  newManagerUserId: string;
  formerOwnerUserId: string;
  formerOwnerName: string;
  propertyLabel: string;
}): Promise<void> {
  const db = (await import("@/lib/supabase/service")).createSupabaseServiceRoleClient();
  const newManager = await profileEmail(db, input.newManagerUserId);
  const formerOwner = await profileEmail(db, input.formerOwnerUserId);
  if (!newManager) return;

  const subject = `You are now the main manager of ${input.propertyLabel}`;
  const text = [
    `${input.formerOwnerName} transferred ownership of ${input.propertyLabel} to you on PropLane.`,
    "",
    "You are now the main manager for this property. The former owner remains a co-manager with the permissions they chose.",
    "",
    `Open your portal: ${appOrigin()}/manager/properties`,
    "",
    "— PropLane",
  ].join("\n");

  await deliverPortalInboxMessage(db, {
    senderUserId: input.formerOwnerUserId,
    senderEmail: formerOwner?.email ?? "noreply@axis.local",
    fromName: input.formerOwnerName,
    subject,
    text,
    toEmails: [newManager.email],
    toUserIds: [input.newManagerUserId],
    // Informational ownership-change notice — suppressible category.
    eventCategory: "messages",
  });
}

export async function notifyDemotedToCoManager(input: {
  formerOwnerUserId: string;
  newManagerUserId: string;
  newManagerName: string;
  propertyLabel: string;
}): Promise<void> {
  const db = (await import("@/lib/supabase/service")).createSupabaseServiceRoleClient();
  const formerOwner = await profileEmail(db, input.formerOwnerUserId);
  const newManager = await profileEmail(db, input.newManagerUserId);
  if (!formerOwner) return;

  const subject = `Ownership transferred — ${input.propertyLabel}`;
  const text = [
    `You transferred main manager ownership of ${input.propertyLabel} to ${input.newManagerName}.`,
    "",
    "You remain a co-manager on this property with the permissions you selected.",
    "",
    `Manage your team: ${appOrigin()}/manager/relationships`,
    "",
    "— PropLane",
  ].join("\n");

  await deliverPortalInboxMessage(db, {
    senderUserId: input.newManagerUserId,
    senderEmail: newManager?.email ?? "noreply@axis.local",
    fromName: input.newManagerName,
    subject,
    text,
    toEmails: [formerOwner.email],
    toUserIds: [input.formerOwnerUserId],
    // Informational ownership-change notice — suppressible category.
    eventCategory: "messages",
  });
}
