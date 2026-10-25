import { normalizePropertyCoManagerPermissions, type CoManagerPermissions } from "@/lib/co-manager-permissions";
import { stampTeamRolePermissions, type TeamRoleId } from "@/lib/co-manager-team-roles";
import { DEFAULT_NEW_INVITE_WORKSPACE_GRANT, normalizeWorkspacePermissions, type WorkspaceCoManagerGrant } from "@/lib/workspace-co-manager-permissions";
import type { HouseScope } from "@/lib/workspaces/membership";

/**
 * The request body for inviting a helper to a service workspace from one box: an email when it has an "@", else a
 * PropLane ID. Null for an empty box. Pure, shared by the Team pane and its test.
 */
export function serviceInviteBody(workspaceId: string, typed: string): Record<string, unknown> | null {
  const value = typed.trim();
  if (!value) return null;
  return value.includes("@")
    ? { action: "team-invite", id: workspaceId, email: value }
    : { action: "team-invite", id: workspaceId, proplaneId: value };
}

/** What the Invite sheet collected. The server re-derives every part of it; this only shapes the request. */
export type ServiceAccessChoice = {
  role: TeamRoleId;
  houseScope: HouseScope;
  /** The houses the sheet shows as chosen (all of the workspace's when `houseScope` is "all"). */
  houseIds: string[];
  /** The Custom grid's map; a named role ignores it and stamps its own. */
  customPermissions: CoManagerPermissions;
  workspacePermissions: WorkspaceCoManagerGrant;
};

/** The flat module grant the sheet shows for a choice: the role's stamp, or the Custom grid. */
export function effectiveServicePermissions(choice: Pick<ServiceAccessChoice, "role" | "customPermissions">): CoManagerPermissions {
  return choice.role === "custom" ? choice.customPermissions : (stampTeamRolePermissions(choice.role) ?? {});
}

function accessFields(choice: ServiceAccessChoice) {
  const effective = effectiveServicePermissions(choice);
  return {
    teamRole: choice.role,
    houseScope: choice.houseScope,
    assignedPropertyIds: choice.houseIds,
    coManagerPermissions: effective,
    propertyCoManagerPermissions: normalizePropertyCoManagerPermissions(
      Object.fromEntries(choice.houseIds.map((id) => [id, effective])),
      choice.houseIds,
    ),
    // Workspace rights follow the role; only Custom carries its own flags.
    workspacePermissions: choice.role === "custom" ? normalizeWorkspacePermissions(choice.workspacePermissions) : DEFAULT_NEW_INVITE_WORKSPACE_GRANT,
  };
}

/**
 * `team-invite` for the Invite sheet: the recipient (email when it has an "@", else a PropLane ID) plus the role,
 * houses and module levels. Owner is its own shape (the client's owner of record: no role to pick, no houses).
 * Null for an empty recipient.
 */
export function serviceInviteRequest(input: {
  workspaceId: string;
  recipient: string;
  choice: ServiceAccessChoice;
  /** The operator confirmed replacing the current owner. */
  replaceOwner?: boolean;
}): Record<string, unknown> | null {
  const recipient = input.recipient.trim();
  if (!recipient) return null;
  const who = recipient.includes("@") ? { email: recipient } : { proplaneId: recipient };
  if (input.choice.role === "property_owner") {
    return { action: "team-invite", id: input.workspaceId, ...who, ownerOfRecord: true, ...(input.replaceOwner ? { replaceOwner: true } : {}) };
  }
  return { action: "team-invite", id: input.workspaceId, ...who, ...accessFields(input.choice) };
}

/** `team-access` for Edit access on an existing seat. */
export function serviceAccessRequest(input: { workspaceId: string; linkId: string; choice: ServiceAccessChoice }): Record<string, unknown> {
  return { action: "team-access", id: input.workspaceId, linkId: input.linkId, ...accessFields(input.choice) };
}
