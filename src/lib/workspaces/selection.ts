/** Display scope only; all authorization stays in the existing server gates. */
import type { WorkspacePayload } from "./types";
let selection: WorkspacePayload | null = null;
export const WORKSPACE_SELECTION_EVENT = "proplane-workspace-selection";
export function setWorkspaceSelection(next: WorkspacePayload | null) {
  selection = next;
  if (typeof window !== "undefined") window.dispatchEvent(new Event(WORKSPACE_SELECTION_EVENT));
}
export function workspaceContainsProperty(propertyId: string | null | undefined): boolean {
  if (!selection || !selection.activeWorkspaceId) return true;
  const active = selection.workspaces.find((w) => w.id === selection!.activeWorkspaceId);
  if (!active) return false;
  if (!propertyId) return active.owned && active.isDefault;
  if (active.propertyIds.includes(propertyId)) return true;
  // A known record in another workspace must never bleed into this one. A new
  // record whose membership has not refreshed yet retains the existing cold-
  // cache behavior in the default workspace; this is not an access grant.
  const known = selection.workspaces.some((w) => w.propertyIds.includes(propertyId));
  return !known && active.owned && active.isDefault;
}

/**
 * The active workspace as copy needs it: its name, and whether it is narrowing
 * the account at all. `null` until the selection has loaded or when there is no
 * active workspace — callers then read the whole account, as the filter does.
 */
export function activeWorkspaceScope(): { name: string; isDefault: boolean; propertyCount: number } | null {
  if (!selection || !selection.activeWorkspaceId) return null;
  const active = selection.workspaces.find((w) => w.id === selection!.activeWorkspaceId);
  if (!active) return null;
  return { name: active.name, isDefault: active.isDefault, propertyCount: active.propertyIds.length };
}

/** Houses the account holds outside the active workspace — what an empty workspace is missing. */
export function propertiesOutsideActiveWorkspace(): number {
  if (!selection || !selection.activeWorkspaceId) return 0;
  return selection.workspaces
    .filter((w) => w.id !== selection!.activeWorkspaceId)
    .reduce((n, w) => n + w.propertyIds.length, 0);
}
