import "server-only";

import { asStringArray, INVITE_PERMISSION_COLUMNS, readPropertyPermissionsFromRow } from "@/lib/account-link-invite-row";
import { withoutOwnerLinks } from "@/lib/co-manager-team-roles";
import { normalizeE164Us } from "@/lib/claw-messenger.server";
import {
  hasCoManagerPermissionLevelForProperty,
  type CoManagerPermissionId,
} from "@/lib/co-manager-permissions";
import type { ReminderSubjectKind } from "@/lib/reminders/rules";
import { notifyManagerFromAgent } from "@/lib/agent-notify.server";
import {
  resolveManagerAssistantWorkspace,
  userDefaultWorkspaceId,
} from "@/lib/communication/manager-assistant-workspace.server";
import {
  ensureWorkspaceTeamThread,
  postTeamThreadMessage,
  relayTeamChatMessageToSms,
} from "@/lib/team-comms.server";
import { resolveWorkspaceNoticeRecipients } from "@/lib/workspace-team-recipients.server";
import { notifyWorkNumberRecipients } from "@/lib/work-number-recipients.server";
import type { ManagerNotificationCategory } from "@/lib/manager-notification-preferences";
import type { createSupabaseServiceRoleClient } from "@/lib/supabase/service";

type ServiceClient = ReturnType<typeof createSupabaseServiceRoleClient>;

export type CoManagerNotificationChannel = CoManagerPermissionId;

/** Maps reminder subjects to the Teams module that gates co-manager alerts. */
export const REMINDER_SUBJECT_CO_MANAGER_MODULE: Record<ReminderSubjectKind, CoManagerPermissionId> = {
  tour: "calendar",
  tour_interest: "inbox",
  task: "calendar",
  service_order: "services",
  work_order: "services",
  application: "applications",
  application_manager: "applications",
  application_post_tour: "applications",
  lease: "leases",
  lease_manager: "leases",
  payment_manager: "payments",
  outgoing_payment: "financials",
  // Bookings sit in the Operations group beside the calendar, and a co-manager
  // who can see the schedule is the one who can see the stays on it.
  booking: "calendar",
  inspection: "residents",
  inspection_manager: "residents",
  // ---- PLAN-0915 kinds. Keep byte-identical with REMINDER_KIND_MODULE in
  // pro-portal-automation-settings-panel.tsx (tests/unit/reminder-module-mapping-parity). ----
  work_order_unassigned: "services",
  work_order_unassigned_emergency: "services",
  work_order_no_on_my_way: "services",
  vendor_offer_expiry: "services",
  vendor_invoice_nudge: "services",
  invoice_approval: "financials",
  service_request_decision: "services",
  service_request_unpaid: "services",
  vendor_document_expiry: "services",
  lease_ending: "leases",
  lease_ending_manager: "leases",
  renewal_offer_expiry: "leases",
  countersign_overdue: "leases",
  move_in: "leases",
  move_in_payment_method: "payments",
  move_out: "leases",
  move_out_inspection_manager: "residents",
  deposit_accounting: "payments",
  lease_renewal_offer: "leases",
  move_out_instructions: "leases",
  deposit_return_notice: "payments",
  application_documents: "applications",
  application_decision_manager: "applications",
  application_no_lease_manager: "applications",
  cosigner: "applications",
  group_application: "applications",
  tour_request_unanswered: "calendar",
  tour_request_reoffer: "calendar",
  tour_no_show_manager: "calendar",
  tour_feedback: "calendar",
  delinquency_manager: "payments",
  message_unanswered: "inbox",
  document_signature: "documents",
  task_overdue: "calendar",
  resident_welcome: "residents",
  inspection_acknowledge: "residents",
};

/**
 * Primary manager plus co-managers with **notification** access on a property module.
 * When `propertyId` is omitted, returns only the owner (manager-specific notifications).
 */
export async function resolvePropertyScopedManagerRecipientIds(
  db: ServiceClient,
  input: {
    ownerManagerUserId: string;
    propertyId?: string | null;
    channel: CoManagerNotificationChannel;
  },
): Promise<string[]> {
  const ownerId = input.ownerManagerUserId.trim();
  if (!ownerId) return [];

  const propertyId = input.propertyId?.trim() || "";
  const recipientIds = new Set<string>([ownerId]);
  if (!propertyId) return [...recipientIds];

  try {
    // A Property owner (investor) link is never a teammate to notify.
    const { data: links, error } = withoutOwnerLinks(await db
      .from("account_link_invites")
      .select(`invitee_user_id, ${INVITE_PERMISSION_COLUMNS}`)
      .eq("status", "accepted")
      .eq("inviter_user_id", ownerId));

    if (error && !String(error.message ?? "").toLowerCase().includes("account_link_invites")) {
      return [...recipientIds];
    }

    // Not named `module`: Next forbids assigning that identifier
    // (@next/next/no-assign-module-variable).
    const permissionModule = input.channel;
    for (const row of links ?? []) {
      const inviteeId = String(row.invitee_user_id ?? "").trim();
      if (!inviteeId) continue;
      const assigned = asStringArray(row.assigned_property_ids);
      if (!assigned.includes(propertyId)) continue;
      const perms = readPropertyPermissionsFromRow(
        row as Parameters<typeof readPropertyPermissionsFromRow>[0],
      );
      if (!hasCoManagerPermissionLevelForProperty(perms, propertyId, permissionModule, "notification")) continue;
      recipientIds.add(inviteeId);
    }
  } catch {
    /* table may not exist */
  }

  return [...recipientIds];
}

/** Owner + co-managers with inbox or calendar **notification** access — property leads and tours. */
export async function resolvePropertyLeadRecipientIds(
  db: ServiceClient,
  input: {
    ownerManagerUserId: string;
    propertyId?: string | null;
  },
): Promise<string[]> {
  const [inboxIds, calendarIds] = await Promise.all([
    resolvePropertyScopedManagerRecipientIds(db, { ...input, channel: "inbox" }),
    resolvePropertyScopedManagerRecipientIds(db, { ...input, channel: "calendar" }),
  ]);
  return [...new Set([...inboxIds, ...calendarIds])];
}

/** Resolve manager profile emails (+ SMS forward phone) for inbox/email/SMS delivery fan-out. */
export async function resolveManagerRecipientProfiles(
  db: ServiceClient,
  userIds: string[],
): Promise<Array<{ userId: string; email: string; fullName: string | null; phone: string | null }>> {
  const ids = [...new Set(userIds.map((id) => id.trim()).filter(Boolean))];
  if (ids.length === 0) return [];
  const { data } = await db.from("profiles").select("id, email, full_name, phone, sms_forward_inbound").in("id", ids);
  const out: Array<{ userId: string; email: string; fullName: string | null; phone: string | null }> = [];
  for (const row of data ?? []) {
    const userId = String(row.id ?? "").trim();
    const email = String(row.email ?? "").trim().toLowerCase();
    if (!userId || !email.includes("@")) continue;
    const forwardOptedOut = (row as { sms_forward_inbound?: unknown }).sms_forward_inbound === false;
    out.push({
      userId,
      email,
      fullName: String(row.full_name ?? "").trim() || null,
      phone: forwardOptedOut ? null : normalizeE164Us(String((row as { phone?: unknown }).phone ?? "")),
    });
  }
  return out;
}

export type CoManagerNotificationRecipient = {
  userId: string;
  email: string;
  name: string | null;
};

/**
 * Co-managers who should receive operational alerts for a module (property-scoped).
 * Optional `teamUserIds` is the manager's explicit allowlist from reminder settings.
 */
export async function loadCoManagerNotificationRecipients(
  db: ServiceClient,
  input: {
    ownerManagerUserId: string;
    module: CoManagerPermissionId;
    propertyId?: string | null;
    teamUserIds?: readonly string[];
  },
): Promise<CoManagerNotificationRecipient[]> {
  const ownerId = input.ownerManagerUserId.trim();
  if (!ownerId) return [];

  const propertyId = input.propertyId?.trim() || "";
  const allowlist = [...new Set((input.teamUserIds ?? []).map((id) => id.trim()).filter(Boolean))];

  let inviteeIds: string[] = [];
  try {
    // A Property owner (investor) link is never a teammate to notify.
    const { data: links, error } = withoutOwnerLinks(await db
      .from("account_link_invites")
      .select(`invitee_user_id, ${INVITE_PERMISSION_COLUMNS}`)
      .eq("status", "accepted")
      .eq("inviter_user_id", ownerId));
    if (error && !String(error.message ?? "").toLowerCase().includes("account_link_invites")) {
      return [];
    }

    for (const row of links ?? []) {
      const inviteeId = String(row.invitee_user_id ?? "").trim();
      if (!inviteeId) continue;
      if (allowlist.length > 0 && !allowlist.includes(inviteeId)) continue;

      const assigned = asStringArray(row.assigned_property_ids);
      const perms = readPropertyPermissionsFromRow(
        row as Parameters<typeof readPropertyPermissionsFromRow>[0],
      );

      if (propertyId) {
        if (!assigned.includes(propertyId)) continue;
        if (!hasCoManagerPermissionLevelForProperty(perms, propertyId, input.module, "notification")) continue;
        inviteeIds.push(inviteeId);
        continue;
      }

      const hasAny = assigned.some((pid) =>
        hasCoManagerPermissionLevelForProperty(perms, pid, input.module, "notification"),
      );
      if (hasAny) inviteeIds.push(inviteeId);
    }
  } catch {
    return [];
  }

  inviteeIds = [...new Set(inviteeIds)];
  if (inviteeIds.length === 0) return [];

  const { data, error } = await db
    .from("profiles")
    .select("id, email, full_name")
    .in("id", inviteeIds);
  if (error) return [];

  const out: CoManagerNotificationRecipient[] = [];
  for (const row of data ?? []) {
    const userId = String((row as { id?: unknown }).id ?? "").trim();
    const email = String((row as { email?: unknown }).email ?? "").trim().toLowerCase();
    if (!userId || !email.includes("@")) continue;
    const name = String((row as { full_name?: unknown }).full_name ?? "").trim();
    out.push({ userId, email, name: name || null });
  }
  return out;
}

const MODULE_EVENT_LABEL: Partial<Record<CoManagerPermissionId, string>> = {
  services: "Service request",
  payments: "Payment",
  financials: "Payment",
  leases: "Lease",
  applications: "Application",
  calendar: "Tour",
  residents: "Inspection",
};

/**
 * The Team line for a routine notice that came without one: the first line of
 * the notice the owner receives, at most 160 characters, behind its event label
 * (the module names it: "Service request", "Payment", "Lease", "Application",
 * "Tour", "Inspection"; anything else is "Notice"). The id is the notice's own
 * idempotency key, so a retry posts once. No key = no safe id = no line.
 */
function derivedTeamNotice(input: {
  module: CoManagerPermissionId;
  subject: string;
  text: string;
  idempotencyKey?: string;
  eventLabel?: string;
}): { text: string; messageId: string } | null {
  const key = input.idempotencyKey?.trim();
  if (!key) return null;
  const firstLine = (input.text.trim().split(/\r?\n/)[0] ?? "").trim() || input.subject.trim();
  if (!firstLine) return null;
  const label = input.eventLabel?.trim() || MODULE_EVENT_LABEL[input.module] || "Notice";
  return { text: `${label} · ${firstLine.slice(0, 160)}`, messageId: `${key}:team` };
}

/**
 * Tell the team about something. The owner always gets a PropLane Assistant
 * notice (text to their verified phone, email to their account address).
 *
 * Routine (the default whenever `teamNotice` is given): the teammates hear it
 * from ONE PropLane line in the workspace Team chat (`teamNotice`, idempotent
 * on its `messageId`), texted on to each member by their existing team-texting
 * setting. Nothing lands in a teammate's Assistant or inbox. A workspace of
 * one person has no Team chat, so the owner's notice is all there is.
 *
 * Urgent: every teammate with notification access to the house ALSO gets the
 * notice in their OWN Assistant thread (text from the WORKSPACE OWNER's work
 * number, billed to the owner via `senderOwnerId`; a teammate is never
 * charged), plus the same Team line.
 *
 * With no `teamNotice`, a routine notice derives its Team line from the notice
 * itself (`derivedTeamNotice`): every routine event posts exactly one line.
 *
 * The owner's leg runs first and its failure propagates (the caller retries,
 * every leg is idempotent per `idempotencyKey` + member). A teammate's failure
 * never blocks the owner or the other teammates.
 */
export async function notifyPropertyScopedManagersFromAgent(
  db: ServiceClient,
  input: {
    ownerManagerUserId: string;
    propertyId?: string | null;
    module: CoManagerPermissionId;
    subject: string;
    text: string;
    externalText?: string;
    /** What a teammate (not the owner) reads, when the owner's copy is addressed to the owner ("You ..."). */
    teammateText?: string;
    teammateExternalText?: string;
    threadType?: string;
    url?: string;
    category?: ManagerNotificationCategory;
    idempotencyKey?: string;
    /** People already served another way (the actor who did the thing). */
    excludeUserIds?: readonly string[];
    /** Important: teammates are told directly too. Emergency priority / URGENT_REMINDER_KINDS only. */
    urgent?: boolean;
    /** The one Team chat line for this event (built by `buildTeamNoticeLine`); `messageId` makes a retry post once. */
    teamNotice?: { text: string; messageId: string };
    /** Names the event on a derived Team line when the caller built none ("Tour", "Booking", ...). */
    eventLabel?: string;
  },
): Promise<void> {
  const ownerId = input.ownerManagerUserId.trim();
  const excluded = new Set((input.excludeUserIds ?? []).map((id) => id.trim()));
  const noticeWorkspace = await resolveManagerAssistantWorkspace(db, ownerId, { propertyId: input.propertyId }).catch(
    () => null,
  );
  // Routine notices reach teammates only through ONE Team chat line (derived
  // from the notice itself when the caller did not build one); only an urgent
  // event notifies each teammate's own Assistant.
  const urgent = input.urgent === true;
  const teamNotice =
    input.teamNotice?.text.trim() && input.teamNotice.messageId.trim()
      ? { text: input.teamNotice.text.trim(), messageId: input.teamNotice.messageId.trim() }
      : derivedTeamNotice(input);
  const directToTeammates = urgent;
  const recipientIds = (
    directToTeammates
      ? await resolveWorkspaceNoticeRecipients(db, {
          ownerUserId: ownerId,
          workspaceId: noticeWorkspace?.workspaceId || null,
          module: input.module,
          propertyId: input.propertyId,
        })
      : [{ userId: ownerId }]
  )
    .map((recipient) => recipient.userId)
    .filter((id) => !excluded.has(id));
  for (const userId of recipientIds) {
    const isOwner = userId === ownerId;
    const deliver = () =>
      notifyManagerFromAgent(db, {
        landlordId: userId,
        subject: input.subject,
        text: isOwner ? input.text : (input.teammateText ?? input.text),
        externalText: isOwner ? input.externalText : (input.teammateExternalText ?? input.externalText),
        threadType: input.threadType,
        url: input.url,
        category: input.category,
        idempotencyKey: input.idempotencyKey,
        propertyId: input.propertyId ?? null,
        senderOwnerId: ownerId,
      });
    if (isOwner) {
      await deliver();
      continue;
    }
    try {
      await deliver();
    } catch (error) {
      // Masked: the teammate id and the notice body never reach a log.
      console.error("teammate notice failed", error instanceof Error ? error.name : "unknown");
    }
  }
  // "Also notify": people with no PropLane account who get every notice the work number sends.
  // They ride the owner's leg (the owner was served unless they were the actor), as a text from the
  // owner's work number and an email from the work email - never an Assistant thread.
  if (!excluded.has(ownerId)) {
    try {
      await notifyWorkNumberRecipients(db, {
        ownerUserId: ownerId,
        workspaceId: noticeWorkspace?.workspaceId || null,
        subject: input.subject,
        text: input.externalText ?? input.text,
        url: input.url,
        idempotencyKey: input.idempotencyKey,
      });
    } catch (error) {
      console.error("extra recipient notice failed", error instanceof Error ? error.name : "unknown");
    }
  }
  if (teamNotice) {
    await postTeamNoticeLine(db, {
      ownerId,
      workspaceId: noticeWorkspace?.workspaceId || null,
      text: teamNotice.text,
      messageId: teamNotice.messageId,
      excludeUserIds: [...excluded],
    });
  }
}

/**
 * One PropLane line in the workspace Team chat, then the text relay to members
 * with team texting on. No Team chat (fewer than two people) = nothing posted.
 * A failed post throws so the caller retries (the line is idempotent on
 * `messageId`); a relay failure never fails the notice. The owner is never
 * relayed to (their own Assistant notice already texted them) and neither is
 * anyone in `excludeUserIds` (the actor).
 */
async function postTeamNoticeLine(
  db: ServiceClient,
  input: { ownerId: string; workspaceId: string | null; text: string; messageId: string; excludeUserIds: readonly string[] },
): Promise<void> {
  const workspaceId = input.workspaceId || (await userDefaultWorkspaceId(db, input.ownerId).catch(() => "")) || "";
  if (!workspaceId) return;
  const threadId = await ensureWorkspaceTeamThread(db, { ownerManagerUserId: input.ownerId, workspaceId });
  if (!threadId) return;
  const posted = await postTeamThreadMessage(db, {
    ownerManagerUserId: input.ownerId,
    workspaceId,
    actorName: "PropLane",
    text: input.text,
    messageId: input.messageId,
    channel: "app",
  });
  if (!posted.ok) throw new Error(posted.error);
  if (!posted.posted) return;
  await relayTeamChatMessageToSms(db, {
    ownerManagerUserId: input.ownerId,
    workspaceId,
    senderUserId: input.ownerId,
    senderName: "PropLane",
    text: input.text,
    messageId: input.messageId,
    excludeUserIds: input.excludeUserIds,
  }).catch((error: unknown) => {
    console.error("team notice relay failed", error instanceof Error ? error.name : "unknown");
  });
}
