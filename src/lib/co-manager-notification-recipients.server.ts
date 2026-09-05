import "server-only";

import { asStringArray, readPropertyPermissionsFromRow } from "@/app/api/pro/account-links/route";
import { normalizeE164Us } from "@/lib/claw-messenger.server";
import {
  hasCoManagerPermissionLevelForProperty,
  type CoManagerPermissionId,
} from "@/lib/co-manager-permissions";
import type { ReminderSubjectKind } from "@/lib/reminders/rules";
import { notifyManagerFromAgent } from "@/lib/agent-notify.server";
import type { ManagerNotificationCategory } from "@/lib/manager-notification-preferences";
import type { createSupabaseServiceRoleClient } from "@/lib/supabase/service";

type ServiceClient = ReturnType<typeof createSupabaseServiceRoleClient>;

export type CoManagerNotificationChannel = CoManagerPermissionId;

/** Maps reminder subjects to the Teams module that gates co-manager alerts. */
export const REMINDER_SUBJECT_CO_MANAGER_MODULE: Record<ReminderSubjectKind, CoManagerPermissionId> = {
  tour: "calendar",
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
    const { data: links, error } = await db
      .from("account_link_invites")
      .select(
        "invitee_user_id, assigned_property_ids, property_co_manager_permissions, co_manager_permissions",
      )
      .eq("status", "accepted")
      .eq("inviter_user_id", ownerId);

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
    const { data: links, error } = await db
      .from("account_link_invites")
      .select(
        "invitee_user_id, assigned_property_ids, property_co_manager_permissions, co_manager_permissions",
      )
      .eq("status", "accepted")
      .eq("inviter_user_id", ownerId);
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

/** Fan out a PropLane Assistant notice to the owner and permitted co-managers. */
export async function notifyPropertyScopedManagersFromAgent(
  db: ServiceClient,
  input: {
    ownerManagerUserId: string;
    propertyId?: string | null;
    module: CoManagerPermissionId;
    subject: string;
    text: string;
    externalText?: string;
    threadType?: string;
    url?: string;
    category?: ManagerNotificationCategory;
    idempotencyKey?: string;
  },
): Promise<void> {
  const recipientIds = await resolvePropertyScopedManagerRecipientIds(db, {
    ownerManagerUserId: input.ownerManagerUserId,
    propertyId: input.propertyId,
    channel: input.module,
  });
  for (const userId of recipientIds) {
    await notifyManagerFromAgent(db, {
      landlordId: userId,
      subject: input.subject,
      text: input.text,
      externalText: input.externalText,
      threadType: input.threadType,
      url: input.url,
      category: input.category,
      idempotencyKey: input.idempotencyKey ? `${input.idempotencyKey}:${userId}` : undefined,
    });
  }
}
