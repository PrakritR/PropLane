import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { asStringArray, readPropertyPermissionsFromRow } from "@/lib/account-link-invite-row";
import {
  hasCoManagerPermissionLevel,
  hasCoManagerPermissionLevelForProperty,
  normalizeCoManagerPermissions,
  type CoManagerPermissionId,
} from "@/lib/co-manager-permissions";
import { parseTeamRole, stampTeamRolePermissions } from "@/lib/co-manager-team-roles";
import {
  resolveWorkspaceTeamMembersWithGrants,
  type TeamMemberGrantRow,
  type TeamMemberWithGrant,
} from "@/lib/team-comms.server";

/**
 * THE one answer to "who in this workspace hears about this event": the owner,
 * plus each accepted teammate whose ROLE and HOUSES say they should. Every
 * automated fan-out (action events, payment reminders, channel bookings) and
 * every inbound fan-out (work email, prospect text, resident text) reads it.
 *
 * Role matrix (docs/agents/co-manager-access.md):
 *  - owner: always.
 *  - admin / full / custom: every event on every house, when the module is on at
 *    notification level for them.
 *  - property_manager / leasing / viewer (and a legacy teammate with no role):
 *    events on houses they hold (or every house on an "all houses" row); an
 *    event with no house reaches them too.
 *  - bookkeeper: payments / financials events only.
 *  - maintenance: services events only.
 *  - property_owner: never (the roster already drops owner links).
 * Permissions stay authoritative: a role label with no notification grant on
 * the module hears nothing.
 */
export type WorkspaceNoticeRecipient = {
  userId: string;
  role: string | null;
  isOwner: boolean;
  /** Assistant thread is always on; email/text are the person's own routing, settled at send time. */
  channels: { assistant: true; email: boolean; sms: boolean };
};

const WHOLE_WORKSPACE_ROLES = new Set(["admin", "full", "custom"]);
const BOOKKEEPER_MODULES = new Set<CoManagerPermissionId>(["payments", "financials"]);

function flatPermissions(row: TeamMemberGrantRow) {
  let flat = normalizeCoManagerPermissions(row.co_manager_permissions);
  if (Object.keys(flat).length === 0) {
    const parsed = parseTeamRole(row.team_role);
    const stamp = parsed.ok && parsed.role ? stampTeamRolePermissions(parsed.role) : null;
    if (stamp) flat = stamp;
  }
  return flat;
}

/** Pure: does this teammate's role + grants put them on a notice for `module` (on `propertyId`, or no house)? */
export function memberReceivesNotice(
  member: Pick<TeamMemberWithGrant, "teamRole" | "isOwner" | "grantRow">,
  event: { module: CoManagerPermissionId; propertyId?: string | null },
): boolean {
  if (member.isOwner) return true;
  const role = member.teamRole;
  if (role === "property_owner") return false;
  if (role === "bookkeeper" && !BOOKKEEPER_MODULES.has(event.module)) return false;
  if (role === "maintenance" && event.module !== "services") return false;
  const row = member.grantRow;
  if (!row) return false;

  const houseScopeAll = String(row.house_scope ?? "") === "all";
  const assigned = asStringArray(row.assigned_property_ids);
  const perHouse = readPropertyPermissionsFromRow(row as Parameters<typeof readPropertyPermissionsFromRow>[0]);
  const flat = flatPermissions(row);
  const wholeWorkspace = WHOLE_WORKSPACE_ROLES.has(role ?? "");
  const anyHouseGrant = () => {
    if (assigned.some((id) => hasCoManagerPermissionLevelForProperty(perHouse, id, event.module, "notification"))) {
      return true;
    }
    // A teammate with no houses of their own only hears whole-workspace events if their role is whole-workspace.
    const holdsHouses = houseScopeAll || assigned.length > 0 || wholeWorkspace;
    return holdsHouses && hasCoManagerPermissionLevel(flat, event.module, "notification");
  };

  if (wholeWorkspace) return anyHouseGrant();

  const propertyId = event.propertyId?.trim() ?? "";
  if (!propertyId) return anyHouseGrant();
  if (!houseScopeAll && !assigned.includes(propertyId)) return false;
  if (hasCoManagerPermissionLevelForProperty(perHouse, propertyId, event.module, "notification")) return true;
  // An "all houses" row picks up a house with no per-house entry yet on its flat grant.
  return houseScopeAll && !perHouse[propertyId] && hasCoManagerPermissionLevel(flat, event.module, "notification");
}

export async function resolveWorkspaceNoticeRecipients(
  db: SupabaseClient,
  input: {
    ownerUserId: string;
    workspaceId?: string | null;
    module: CoManagerPermissionId;
    propertyId?: string | null;
  },
): Promise<WorkspaceNoticeRecipient[]> {
  const ownerId = input.ownerUserId.trim();
  if (!ownerId) return [];
  const members = await resolveWorkspaceTeamMembersWithGrants(db, {
    ownerManagerUserId: ownerId,
    workspaceId: input.workspaceId,
  });
  const chosen = members.filter((member) => memberReceivesNotice(member, input));

  const profileById = new Map<string, { email?: unknown; phone?: unknown; sms_forward_inbound?: unknown }>();
  try {
    const { data } = await db
      .from("profiles")
      .select("id, email, phone, sms_forward_inbound")
      .in("id", chosen.map((m) => m.userId));
    for (const row of (data ?? []) as Array<{ id?: unknown; email?: unknown; phone?: unknown; sms_forward_inbound?: unknown }>) {
      profileById.set(String(row.id ?? ""), row);
    }
  } catch {
    /* channels degrade to the Assistant thread alone */
  }

  return chosen.map((member) => {
    const profile = profileById.get(member.userId);
    return {
      userId: member.userId,
      role: member.teamRole,
      isOwner: member.isOwner,
      channels: {
        assistant: true as const,
        email: String(profile?.email ?? "").includes("@"),
        sms: Boolean(String(profile?.phone ?? "").trim()) && profile?.sms_forward_inbound !== false,
      },
    };
  });
}
