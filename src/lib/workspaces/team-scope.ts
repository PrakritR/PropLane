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
