/**
 * Workspace membership — the pure rules behind "who is in this workspace, as
 * what, over which houses". Shared by the server loaders, the API routes and
 * the Settings → Workspaces UI so the three cannot drift.
 *
 * A membership is one `account_link_invites` row pinned to a workspace:
 *   role        what the person may do (stamps the per-house module map)
 *   houseScope  'all'      every house in the workspace, kept current by the
 *                          database trigger as houses join and leave
 *               'selected' the listed houses, pruned when one leaves
 *
 * Module gates keep reading the per-house permission map; nothing here is a
 * second authorization source. What this file decides is the WORKSPACE-level
 * questions: may this member invite others, add or move houses, edit or remove
 * another member — and how a row is described.
 */
import { CO_MANAGER_PERMISSION_OPTIONS, hasCoManagerPermission, type CoManagerPermissions } from "@/lib/co-manager-permissions";
import { TEAM_ROLE_LABELS, type TeamRoleId } from "@/lib/co-manager-team-roles";

export type HouseScope = "all" | "selected";

/** The viewer's standing in one workspace. Owner is not a row; it is the workspace's owner_user_id. */
export type WorkspaceRole = "owner" | TeamRoleId;

export type WorkspaceRights = {
  /** Invite, edit and remove members of this workspace. */
  members: boolean;
  /** Add a listing into this workspace, and move houses between workspaces they administer. */
  houses: boolean;
};

export function parseHouseScope(raw: unknown): HouseScope {
  return raw === "all" ? "all" : "selected";
}

/**
 * What a role may do at the workspace level. Owner and Admin run the
 * workspace; Property manager may add houses (the listing wizard's
 * create-as-owner); everyone else acts only inside the modules they hold.
 * Custom carries no workspace rights unless the stored flags say so — see
 * `workspaceRightsForMembership`.
 */
export function workspaceRightsForRole(role: WorkspaceRole | null | undefined): WorkspaceRights {
  switch (role) {
    case "owner":
    case "admin":
    case "full":
      return { members: true, houses: true };
    case "property_manager":
      return { members: false, houses: true };
    default:
      return { members: false, houses: false };
  }
}

/** Rights for a stored row: the role decides, except Custom, which keeps its explicit flags. */
export function workspaceRightsForMembership(input: {
  teamRole: TeamRoleId | null | undefined;
  workspacePermissions?: { addProperties?: boolean; teams?: boolean } | null;
}): WorkspaceRights {
  if (input.teamRole && input.teamRole !== "custom") return workspaceRightsForRole(input.teamRole);
  return {
    members: input.workspacePermissions?.teams === true,
    houses: input.workspacePermissions?.addProperties === true,
  };
}

/** Whether the viewer may run this workspace's team (invite, edit, remove). */
export function canManageWorkspaceMembers(role: WorkspaceRole | null | undefined): boolean {
  return workspaceRightsForRole(role).members;
}

/**
 * May `actor` edit or remove `target`? The Owner may do anything to any row.
 * An Admin may act on every row but the Owner (who has no row) and must never
 * leave the workspace without an admin when the Owner delegated it.
 */
export function canActOnMember(input: {
  actorRole: WorkspaceRole | null | undefined;
  targetRole: TeamRoleId | null | undefined;
  /** Accepted Admin/Full rows in the workspace, the target included. */
  adminCount: number;
}): { ok: true } | { ok: false; reason: string } {
  if (input.actorRole === "owner") return { ok: true };
  if (!canManageWorkspaceMembers(input.actorRole)) {
    return { ok: false, reason: "Only the workspace owner or an admin can change members." };
  }
  const targetIsAdmin = input.targetRole === "admin" || input.targetRole === "full";
  if (targetIsAdmin && input.adminCount <= 1) {
    return { ok: false, reason: "This workspace needs at least one admin. Ask the owner to change this member." };
  }
  return { ok: true };
}

/** An Admin may stamp any role in the catalogue; the ceiling is Admin itself. Owner is not a role. */
export function roleAssignableBy(actorRole: WorkspaceRole | null | undefined, role: TeamRoleId): boolean {
  if (actorRole === "owner") return true;
  if (!canManageWorkspaceMembers(actorRole)) return false;
  return role !== "full" || actorRole === "full";
}

/**
 * The houses a membership reaches right now. 'all' is the workspace itself;
 * 'selected' is the stored list narrowed to the workspace, so a house that
 * moved out is gone even before the trigger has pruned the row.
 */
export function effectiveHouseIds(input: {
  houseScope: HouseScope;
  assignedPropertyIds: readonly string[];
  workspacePropertyIds: readonly string[];
}): string[] {
  const inWorkspace = new Set(input.workspacePropertyIds.map((id) => id.trim()).filter(Boolean));
  if (input.houseScope === "all") return [...inWorkspace];
  return input.assignedPropertyIds.map((id) => id.trim()).filter((id) => inWorkspace.has(id));
}

/** "All houses" or "3 of 10 houses" — the reach column on a member row. */
export function memberReachLabel(input: {
  houseScope: HouseScope;
  houseCount: number;
  workspaceHouseCount: number;
}): string {
  if (input.houseScope === "all") return "All houses";
  if (input.houseCount === 0) return "No houses";
  return `${input.houseCount} of ${input.workspaceHouseCount} ${input.workspaceHouseCount === 1 ? "house" : "houses"}`;
}

/** "Admin · All houses" — the switcher's line for a shared workspace. */
export function memberStandingLabel(input: {
  role: WorkspaceRole | null | undefined;
  houseScope: HouseScope;
  houseCount: number;
  workspaceHouseCount: number;
}): string {
  const role = input.role === "owner" ? "Owner" : input.role ? TEAM_ROLE_LABELS[input.role] : "Shared";
  if (input.role === "owner") {
    return `Owner · ${input.workspaceHouseCount} ${input.workspaceHouseCount === 1 ? "house" : "houses"}`;
  }
  return `${role} · ${memberReachLabel(input)}`;
}

/**
 * Who loses, keeps and gains a house when it moves between two workspaces.
 * Members on 'all' in the destination gain it; members of the source lose it
 * unless they also sit in the destination on 'all' (they keep it).
 */
export function describeHouseMove(input: {
  propertyId: string;
  source: { members: { userId: string; name: string; houseScope: HouseScope; propertyIds: string[] }[] };
  destination: { members: { userId: string; name: string; houseScope: HouseScope; propertyIds: string[] }[] };
}): { loses: string[]; keeps: string[]; gains: string[] } {
  const pid = input.propertyId.trim();
  const destAll = new Map(
    input.destination.members.filter((m) => m.houseScope === "all").map((m) => [m.userId, m.name]),
  );
  const had = input.source.members.filter((m) => m.houseScope === "all" || m.propertyIds.includes(pid));
  const loses: string[] = [];
  const keeps: string[] = [];
  for (const member of had) {
    if (destAll.has(member.userId)) keeps.push(member.name);
    else loses.push(member.name);
  }
  const hadIds = new Set(had.map((m) => m.userId));
  const gains = [...destAll.entries()].filter(([userId]) => !hadIds.has(userId)).map(([, name]) => name);
  return { loses, keeps, gains };
}

/** Module labels a flat grant reaches — the "Leasing can" line under a role. */
export function grantedModuleLabels(grant: CoManagerPermissions | undefined): string[] {
  return CO_MANAGER_PERMISSION_OPTIONS.filter(({ id }) => hasCoManagerPermission(grant, id)).map(({ label }) => label);
}
