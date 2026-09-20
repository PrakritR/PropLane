/** Shared invite serialization; route modules export only handlers/configuration. */
import type { AccountLinkInviteDto } from "@/lib/account-links";
import {
  flatCoManagerPermissionsFromProperty,
  normalizeCoManagerPermissions,
  normalizePropertyCoManagerPermissions,
  type PropertyCoManagerPermissions,
} from "@/lib/co-manager-permissions";
import {
  inferInviteTeamRole,
  parseTeamRole,
  stampTeamRolePermissions,
  type CoManagerTeamRole,
} from "@/lib/co-manager-team-roles";
import { normalizeWorkspacePermissions } from "@/lib/workspace-co-manager-permissions";
import { parseHouseScope, type HouseScope } from "@/lib/workspaces/membership";

export type InviteRow = {
  id: string;
  inviter_user_id: string;
  invitee_user_id: string | null;
  tab_kind: string;
  inviter_axis_id: string;
  invitee_axis_id: string | null;
  inviter_display_name: string | null;
  invitee_display_name: string | null;
  assigned_property_ids: unknown;
  payout_percent_for_manager: number;
  co_manager_permissions?: unknown;
  property_co_manager_permissions?: unknown;
  status: string;
  created_at: string;
  responded_at: string | null;
  expires_at?: string | null;
  invite_token_hash?: string | null;
  invitee_plan_inherited?: boolean;
  workspace_id?: string | null;
  workspace_permissions?: unknown;
  legacy_workspace_permissions?: unknown;
  team_role?: string | null;
  house_scope?: string | null;
  invited_via?: string | null;
  invited_at?: string | null;
};

/**
 * Columns a reader must select for `readPropertyPermissionsFromRow` to see an
 * "all houses" row correctly. One string so no reader forgets `house_scope`
 * or `team_role`.
 */
export const INVITE_PERMISSION_COLUMNS =
  "assigned_property_ids, property_co_manager_permissions, co_manager_permissions, house_scope, team_role";

export function asStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x) => typeof x === "string") as string[];
}

/**
 * The per-house map a row grants. On an "all houses" row the database keeps
 * `assigned_property_ids` current as houses join the workspace, and a house
 * that joined after the row was written has no per-house entry yet — it takes
 * the row's flat grant (`co_manager_permissions`, the role stamp), falling
 * back to the stored `team_role`'s stamp when that flat grant is empty. Only
 * an EMPTY entry is filled: an explicit narrower grant on one house stands.
 */
export function readPropertyPermissionsFromRow(
  row: Pick<InviteRow, "assigned_property_ids" | "property_co_manager_permissions" | "co_manager_permissions"> &
    Partial<Pick<InviteRow, "house_scope" | "team_role">>,
): PropertyCoManagerPermissions {
  const assigned = asStringArray(row.assigned_property_ids);
  const raw = row.property_co_manager_permissions ?? row.co_manager_permissions;
  const perms = normalizePropertyCoManagerPermissions(raw, assigned);
  if (parseHouseScope(row.house_scope) !== "all") return perms;
  let flat = normalizeCoManagerPermissions(row.co_manager_permissions);
  if (Object.keys(flat).length === 0) {
    const parsedRole = parseTeamRole(row.team_role);
    const roleStamp = parsedRole.ok && parsedRole.role ? stampTeamRolePermissions(parsedRole.role) : null;
    if (roleStamp) flat = roleStamp;
  }
  if (Object.keys(flat).length === 0) return perms;
  for (const id of assigned) {
    if (Object.keys(perms[id] ?? {}).length === 0) perms[id] = { ...flat };
  }
  return perms;
}

export function readHouseScopeFromRow(row: Pick<InviteRow, "house_scope">): HouseScope {
  return parseHouseScope(row.house_scope);
}

export function serializeInvite(
  row: InviteRow,
  viewerId: string,
  propertyLabelsById: Record<string, string> = {},
  options: {
    /**
     * The viewer runs the workspace this row belongs to (an Admin) without
     * being its inviter. The row reads as outgoing — the member is the other
     * party — exactly as it does for the owner.
     */
    viewAsWorkspaceManager?: boolean;
  } = {},
): AccountLinkInviteDto {
  const out = row.inviter_user_id === viewerId || options.viewAsWorkspaceManager === true;
  const openInvite = !String(row.invitee_user_id ?? "").trim();
  const linkedAxisId = out ? (row.invitee_axis_id ?? "") : row.inviter_axis_id;
  const linkedDisplayName = out
    ? openInvite
      ? "Invite link"
      : row.invitee_display_name
    : row.inviter_display_name;
  const linkedUserId = out ? (row.invitee_user_id ?? "") : row.inviter_user_id;
  const assignedPropertyIds = asStringArray(row.assigned_property_ids);
  const propertyCoManagerPermissions = readPropertyPermissionsFromRow(row);
  const assignedPropertyLabels: Record<string, string> = {};
  for (const id of assignedPropertyIds) {
    const label = propertyLabelsById[id]?.trim();
    if (label) assignedPropertyLabels[id] = label;
  }
  return {
    id: row.id,
    tabKind: "manager",
    status:
      row.status === "accepted" ||
      row.status === "rejected" ||
      row.status === "cancelled" ||
      row.status === "pending"
        ? row.status
        : "pending",
    direction: out ? "outgoing" : "incoming",
    inviterAxisId: row.inviter_axis_id,
    inviteeAxisId: row.invitee_axis_id ?? "",
    openInvite,
    inviterDisplayName: row.inviter_display_name,
    inviteeDisplayName: row.invitee_display_name,
    linkedAxisId,
    linkedDisplayName,
    linkedUserId,
    assignedPropertyIds,
    assignedPropertyLabels: Object.keys(assignedPropertyLabels).length > 0 ? assignedPropertyLabels : undefined,
    payoutPercentForManager: Number(row.payout_percent_for_manager),
    coManagerPermissions: flatCoManagerPermissionsFromProperty(propertyCoManagerPermissions),
    propertyCoManagerPermissions,
    workspaceId: row.workspace_id ?? null,
    houseScope: parseHouseScope(row.house_scope),
    teamRole: resolveInviteTeamRole(row.team_role, propertyCoManagerPermissions),
    workspacePermissions: normalizeWorkspacePermissions(row.workspace_permissions),
    legacyWorkspacePermissions: normalizeWorkspacePermissions(row.legacy_workspace_permissions),
    createdAt: row.created_at,
    respondedAt: row.responded_at,
    expiresAt: row.expires_at ?? null,
    invitedVia:
      row.invited_via === "phone" || row.invited_via === "email" || row.invited_via === "code"
        ? row.invited_via
        : null,
    invitedAt: row.invited_at ?? null,
  };
}

export function resolveInviteTeamRole(
  stored: unknown,
  propertyPerms: PropertyCoManagerPermissions,
): CoManagerTeamRole {
  const parsed = parseTeamRole(stored);
  if (parsed.ok && parsed.role) return parsed.role;
  return inferInviteTeamRole(propertyPerms);
}
