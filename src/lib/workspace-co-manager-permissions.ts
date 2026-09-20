/** Workspace-level grants on a co-manager link (not a house module). */

export type WorkspaceCoManagerGrant = {
  addProperties?: boolean;
  teams?: boolean;
};

export const EMPTY_WORKSPACE_GRANT: WorkspaceCoManagerGrant = {};

/**
 * A fresh invite grants no workspace rights of its own: they follow the role
 * (src/lib/workspaces/membership.ts). These flags remain only for Custom rows.
 */
export const DEFAULT_NEW_INVITE_WORKSPACE_GRANT: WorkspaceCoManagerGrant = {};

export function normalizeWorkspacePermissions(raw: unknown): WorkspaceCoManagerGrant {
  if (!raw || typeof raw !== "object") return {};
  const record = raw as Record<string, unknown>;
  const out: WorkspaceCoManagerGrant = {};
  if (record.addProperties === true) out.addProperties = true;
  if (record.teams === true) out.teams = true;
  return out;
}

export function hasWorkspaceAddProperties(raw: unknown): boolean {
  return normalizeWorkspacePermissions(raw).addProperties === true;
}

export function hasWorkspaceTeamsGrant(raw: unknown): boolean {
  return normalizeWorkspacePermissions(raw).teams === true;
}

export function hasIncomingAcceptedTeamLink(
  invites: readonly { direction?: string; status?: string }[],
): boolean {
  return invites.some((invite) => invite.direction === "incoming" && invite.status === "accepted");
}
