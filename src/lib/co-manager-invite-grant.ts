/**
 * The invite grant, validated once.
 *
 * `POST /api/pro/account-links` and PropLane Service's team verbs (`team-invite`, `team-access`) both turn a request
 * body into (role, house scope, houses, per-house module map, flat grant, workspace rights). This is the single
 * implementation of that translation, so a service seat can never carry a shape the manager invite refuses, and the
 * rules (a forged `teamRole: "admin"` with an empty map grants nothing, an owner is never "all houses", a named role
 * rewrites the map) live in one place. It is pure: authority (who may invite, which houses belong to the workspace,
 * delegate caps) stays with the caller, between {@link parseInviteAccess} and {@link finalizeInviteGrant}.
 */
import { asStringArray } from "@/lib/account-link-invite-row";
import {
  flatCoManagerPermissionsFromProperty,
  normalizePropertyCoManagerPermissions,
  type CoManagerPermissions,
  type PropertyCoManagerPermissions,
} from "@/lib/co-manager-permissions";
import {
  applyRoleToPropertyPermissions,
  flatTeamRoleGrant,
  inferInviteTeamRole,
  parseTeamRole,
  permissionsMatchTeamRole,
  stampTeamRoleOnProperties,
  type TeamRoleId,
} from "@/lib/co-manager-team-roles";
import { normalizeWorkspacePermissions, type WorkspaceCoManagerGrant } from "@/lib/workspace-co-manager-permissions";
import { OWNER_NEEDS_HOUSE_ERROR, OWNER_SELECTED_ONLY_ERROR, parseHouseScope, type HouseScope } from "@/lib/workspaces/membership";

export type InviteAccessInput = {
  assignedPropertyIds?: unknown;
  propertyCoManagerPermissions?: unknown;
  coManagerPermissions?: unknown;
  teamRole?: unknown;
  /** all = every house in the workspace, now and later; selected = the listed houses. */
  houseScope?: unknown;
  workspacePermissions?: unknown;
};

export type ParsedInviteAccess = {
  teamRole: TeamRoleId;
  houseScope: HouseScope;
  assignedPropertyIds: string[];
  propertyCoManagerPermissions: PropertyCoManagerPermissions;
};

/**
 * Step one: the role, the scope and the houses as asked, with a named role's map stamped over those houses. An owner
 * is refused an explicit "all houses" and a request with no house (the investor's houses are picked on purpose).
 */
export function parseInviteAccess(
  body: InviteAccessInput | null | undefined,
): { ok: true; access: ParsedInviteAccess } | { ok: false; error: string } {
  const assignedPropertyIds = asStringArray(body?.assignedPropertyIds);
  let houseScope: HouseScope = parseHouseScope(body?.houseScope);
  let propertyCoManagerPermissions = normalizePropertyCoManagerPermissions(
    body?.propertyCoManagerPermissions ?? body?.coManagerPermissions,
    assignedPropertyIds,
  );
  const parsedTeamRole = parseTeamRole(body?.teamRole);
  if (!parsedTeamRole.ok) return { ok: false, error: parsedTeamRole.error };
  const teamRole: TeamRoleId = parsedTeamRole.role ?? "custom";
  if (teamRole === "property_owner") {
    // An owner never follows later-added houses: reject an explicit "all", coerce a defaulted scope, and require a
    // house somebody actually chose.
    if (parseHouseScope(body?.houseScope) === "all") return { ok: false, error: OWNER_SELECTED_ONLY_ERROR };
    houseScope = "selected";
    if (assignedPropertyIds.length === 0) return { ok: false, error: OWNER_NEEDS_HOUSE_ERROR };
  }
  if (teamRole !== "custom") {
    propertyCoManagerPermissions = stampTeamRoleOnProperties(teamRole, assignedPropertyIds, propertyCoManagerPermissions);
  }
  return { ok: true, access: { teamRole, houseScope, assignedPropertyIds, propertyCoManagerPermissions } };
}

/**
 * The map for the FINAL list of houses. The caller resolves "all houses" to the workspace's houses (or refuses a
 * house outside it) after step one, so a named role is stamped again over that list, and a Custom map is
 * re-normalised against it.
 */
export function restampInviteHouses(
  body: InviteAccessInput | null | undefined,
  teamRole: TeamRoleId,
  assignedPropertyIds: string[],
  current: PropertyCoManagerPermissions,
): PropertyCoManagerPermissions {
  if (teamRole !== "custom") return stampTeamRoleOnProperties(teamRole, assignedPropertyIds, current);
  return normalizePropertyCoManagerPermissions(
    body?.propertyCoManagerPermissions ?? body?.coManagerPermissions,
    assignedPropertyIds,
  );
}

export type FinalInviteGrant = {
  teamRole: TeamRoleId;
  propertyCoManagerPermissions: PropertyCoManagerPermissions;
  workspacePermissions: WorkspaceCoManagerGrant;
  coManagerPermissions: CoManagerPermissions;
};

/**
 * The last step, after any delegate cap: the role decides which keys survive (an owner keeps owner keys only, every
 * other role loses them), a map that no longer matches its named role reads as the role it really is, the workspace
 * rights follow the role (only Custom carries explicit flags), and the flat grant is the role's stamp or, for
 * Custom, what was asked.
 */
export function finalizeInviteGrant(
  body: InviteAccessInput | null | undefined,
  input: { teamRole: TeamRoleId; propertyCoManagerPermissions: PropertyCoManagerPermissions },
): FinalInviteGrant {
  let teamRole = input.teamRole;
  const propertyCoManagerPermissions = applyRoleToPropertyPermissions(teamRole, input.propertyCoManagerPermissions);
  // With no house there is no map to compare: a workspace that has no houses yet (a new PropLane Service workspace)
  // must still invite an Admin as an Admin, not read the empty map as a Custom role with no workspace rights.
  if (teamRole !== "custom" && Object.keys(propertyCoManagerPermissions).length > 0) {
    const flatAfterCap = flatCoManagerPermissionsFromProperty(propertyCoManagerPermissions);
    if (!permissionsMatchTeamRole(flatAfterCap, teamRole)) {
      teamRole = inferInviteTeamRole(propertyCoManagerPermissions);
    }
  }
  const workspacePermissions: WorkspaceCoManagerGrant =
    teamRole === "custom" ? normalizeWorkspacePermissions(body?.workspacePermissions) : {};
  const stampedFlat = flatTeamRoleGrant(teamRole, propertyCoManagerPermissions);
  const askedFlat =
    body?.coManagerPermissions && typeof body.coManagerPermissions === "object"
      ? (body.coManagerPermissions as CoManagerPermissions)
      : {};
  const coManagerPermissions: CoManagerPermissions = stampedFlat
    ? stampedFlat
    : Object.keys(askedFlat).length
      ? askedFlat
      : flatCoManagerPermissionsFromProperty(propertyCoManagerPermissions);
  return { teamRole, propertyCoManagerPermissions, workspacePermissions, coManagerPermissions };
}
