import type { SupabaseClient } from "@supabase/supabase-js";
import {
  loadCoManagerNotificationRecipients,
  type CoManagerNotificationRecipient,
} from "@/lib/co-manager-notification-recipients.server";
import {
  coManagerModuleAllowed,
  normalizePropertyCoManagerPermissions,
  type CoManagerPermissionId,
  type PropertyCoManagerPermissions,
} from "@/lib/co-manager-permissions";
import type { ReminderRecipient } from "@/lib/reminders/queue.server";

export type ManagerReminderRecipient = {
  email: string;
  name: string | null;
};

export type TeamReminderRecipient = ManagerReminderRecipient & {
  userId: string;
  /** Properties this co-manager was actually assigned on the accepted invite. */
  assignedPropertyIds: string[];
  /** Their per-property module grants — an absent/empty map confers nothing. */
  permissions: PropertyCoManagerPermissions | undefined;
};

/** Load manager reminder destinations once per sweep, never once per subject. */
export async function loadManagerReminderRecipients(
  db: SupabaseClient,
  managerUserIds: readonly string[],
): Promise<Map<string, ManagerReminderRecipient>> {
  const ids = [...new Set(managerUserIds.map((id) => id.trim()).filter(Boolean))];
  const out = new Map<string, ManagerReminderRecipient>();
  if (ids.length === 0) return out;

  const { data, error } = await db
    .from("profiles")
    .select("id, email, full_name")
    .in("id", ids);
  if (error) throw error;

  for (const row of data ?? []) {
    const id = String((row as { id?: unknown }).id ?? "").trim();
    const email = String((row as { email?: unknown }).email ?? "").trim().toLowerCase();
    if (!id || !email.includes("@")) continue;
    const name = String((row as { full_name?: unknown }).full_name ?? "").trim();
    out.set(id, { email, name: name || null });
  }
  return out;
}

/**
 * Co-managers with **notification** permission on a module (property-scoped when provided).
 *
 * An empty `teamUserIds` means every eligible teammate; a non-empty list is the
 * manager's explicit allowlist from Reminder settings.
 */
export async function loadTeamReminderRecipients(
  db: SupabaseClient,
  managerUserId: string,
  teamUserIds: readonly string[],
  options?: {
    module?: CoManagerPermissionId;
    propertyId?: string | null;
  },
): Promise<TeamReminderRecipient[]> {
  if (options?.module) {
    const rows = await loadCoManagerNotificationRecipients(db, {
      ownerManagerUserId: managerUserId,
      module: options.module,
      propertyId: options.propertyId,
      teamUserIds,
    });
    return rows.map((member) => ({
      userId: member.userId,
      email: member.email,
      name: member.name,
      assignedPropertyIds: [],
      permissions: undefined,
    }));
  }

  const ownerId = managerUserId.trim();
  if (!ownerId) return [];

  const inviteeIds: string[] = [];
  const scopeByUserId = new Map<
    string,
    { assignedPropertyIds: string[]; permissions: PropertyCoManagerPermissions | undefined }
  >();
  try {
    const { data: links, error } = await db
      .from("account_link_invites")
      .select("invitee_user_id, assigned_property_ids, property_co_manager_permissions")
      .eq("status", "accepted")
      .eq("inviter_user_id", ownerId);
    if (error && !String(error.message ?? "").toLowerCase().includes("account_link_invites")) {
      throw error;
    }
    for (const row of links ?? []) {
      const id = String((row as { invitee_user_id?: unknown }).invitee_user_id ?? "").trim();
      if (!id) continue;
      inviteeIds.push(id);
      const assignedPropertyIds = Array.isArray(
        (row as { assigned_property_ids?: unknown }).assigned_property_ids,
      )
        ? ((row as { assigned_property_ids: unknown[] }).assigned_property_ids
            .map((value) => String(value ?? "").trim())
            .filter(Boolean) as string[])
        : [];
      scopeByUserId.set(id, {
        assignedPropertyIds,
        permissions: normalizePropertyCoManagerPermissions(
          (row as { property_co_manager_permissions?: unknown }).property_co_manager_permissions,
          assignedPropertyIds,
        ),
      });
    }
  } catch {
    return [];
  }

  const allowlist = [...new Set(teamUserIds.map((id) => id.trim()).filter(Boolean))];
  const targetIds =
    allowlist.length > 0 ? inviteeIds.filter((id) => allowlist.includes(id)) : inviteeIds;
  if (targetIds.length === 0) return [];

  const { data, error } = await db
    .from("profiles")
    .select("id, email, full_name")
    .in("id", targetIds);
  if (error) throw error;

  const out: TeamReminderRecipient[] = [];
  for (const row of data ?? []) {
    const userId = String((row as { id?: unknown }).id ?? "").trim();
    const email = String((row as { email?: unknown }).email ?? "").trim().toLowerCase();
    if (!userId || !email.includes("@")) continue;
    const name = String((row as { full_name?: unknown }).full_name ?? "").trim();
    const scope = scopeByUserId.get(userId);
    out.push({
      userId,
      email,
      name: name || null,
      assignedPropertyIds: scope?.assignedPropertyIds ?? [],
      permissions: scope?.permissions,
    });
  }
  return out;
}

/**
 * Restrict a team fan-out to the co-managers who may actually see this subject.
 *
 * The invite's assignment and per-property module grants are the product's
 * authorization boundary everywhere else, and a reminder carries the same data
 * the API would refuse them — bill payee, amount, due date, property. Fan-out
 * without this pushed a manager's whole accounts payable to co-managers who
 * were never assigned the property and never granted the module.
 *
 * A subject with no property cannot be shown to be in scope, so it requires the
 * module on EVERY assigned property rather than defaulting to allow.
 */
export function teamRecipientsScopedToSubject(
  members: readonly TeamReminderRecipient[],
  propertyId: string | null | undefined,
  module: CoManagerPermissionId,
): TeamReminderRecipient[] {
  const target = String(propertyId ?? "").trim();
  return members.filter((member) => {
    if (member.assignedPropertyIds.length === 0) return false;
    if (target) {
      return (
        member.assignedPropertyIds.includes(target) &&
        coManagerModuleAllowed(member.permissions, target, module, "notification")
      );
    }
    return member.assignedPropertyIds.every((id) =>
      coManagerModuleAllowed(member.permissions, id, module, "notification"),
    );
  });
}

export function teamReminderRecipients(members: readonly TeamReminderRecipient[]): ReminderRecipient[] {
  return members.map((member) => ({
    email: member.email,
    role: "team" as const,
    name: member.name,
    userId: member.userId,
  }));
}

/** Load team recipients once per manager when a sweep needs them. */
export async function loadTeamReminderRecipientsByManager(
  db: SupabaseClient,
  entries: ReadonlyArray<{
    managerUserId: string;
    teamUserIds: readonly string[];
    module?: CoManagerPermissionId;
    propertyId?: string | null;
  }>,
): Promise<Map<string, TeamReminderRecipient[]>> {
  const out = new Map<string, TeamReminderRecipient[]>();
  const seen = new Set<string>();
  for (const entry of entries) {
    const managerUserId = entry.managerUserId.trim();
    if (!managerUserId || seen.has(managerUserId)) continue;
    seen.add(managerUserId);
    out.set(
      managerUserId,
      await loadTeamReminderRecipients(db, managerUserId, entry.teamUserIds, {
        module: entry.module,
        propertyId: entry.propertyId,
      }),
    );
  }
  return out;
}

export type { CoManagerNotificationRecipient };
