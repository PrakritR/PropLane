/**
 * Email + Axis inbox notifications for co-manager invites and ownership transfers.
 */

import type { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { deliverPortalInboxMessage } from "@/lib/portal-inbox-delivery";
import { resolveEmailLinkBaseUrl } from "@/lib/app-url";
import { buildCoManagerInviteBody, coManagerInviteSubject } from "@/lib/co-manager-link-email";

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
