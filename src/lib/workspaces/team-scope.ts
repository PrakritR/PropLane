import { samePropertyId } from "@/lib/manager-portfolio-access";

/** Houses from a co-manager grant that sit in the active workspace. */
export function assignedIdsInWorkspace(
  assignedPropertyIds: string[],
  workspacePropertyIds: string[],
): string[] {
  return assignedPropertyIds.filter((id) =>
    workspacePropertyIds.some((workspaceId) => samePropertyId(id, workspaceId)),
  );
}

/**
 * An accepted grant with houses only in another workspace is hidden here.
 * An invite that has no houses yet still shows, so it can be assigned from
 * this workspace's picker.
 */
export function teamGrantVisibleInWorkspace(
  assignedPropertyIds: string[],
  workspacePropertyIds: string[],
): boolean {
  if (assignedPropertyIds.length === 0) return true;
  return assignedIdsInWorkspace(assignedPropertyIds, workspacePropertyIds).length > 0;
}

/**
 * Which workspace cards a grant belongs under, on Settings → Workspaces.
 *
 * A grant sits under every owned workspace that holds one of its houses, so a
 * co-manager with houses in two workspaces is listed under both. A grant with
 * no houses yet (an accepted invite-by-link) has no workspace of its own and is
 * listed once, under the default workspace, so it is never repeated per card and
 * never lost.
 */
export function grantBelongsToWorkspace(
  assignedPropertyIds: string[],
  workspace: { propertyIds: string[]; isDefault: boolean; owned: boolean },
): boolean {
  if (!workspace.owned) return false;
  if (assignedPropertyIds.length === 0) return workspace.isDefault;
  return assignedIdsInWorkspace(assignedPropertyIds, workspace.propertyIds).length > 0;
}
