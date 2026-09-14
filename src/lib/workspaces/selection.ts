/** Display scope only; all authorization stays in the existing server gates. */
import type { WorkspacePayload } from "./types";
let selection: WorkspacePayload | null = null;
export const WORKSPACE_SELECTION_EVENT = "proplane-workspace-selection";
export function setWorkspaceSelection(next: WorkspacePayload | null) {
  selection = next;
  if (typeof window !== "undefined") window.dispatchEvent(new Event(WORKSPACE_SELECTION_EVENT));
}

function activeWorkspace() {
  if (!selection || !selection.activeWorkspaceId) return null;
  return selection.workspaces.find((w) => w.id === selection!.activeWorkspaceId) ?? null;
}

/**
 * True while the account is a single workspace — the workspace IS the account,
 * so nothing can bleed between workspaces and a record the server has not
 * placed yet keeps showing exactly where it always did. The moment a second
 * workspace exists the portfolio is partitioned and membership is the only
 * test: an unplaced record belongs to no workspace and appears in none.
 */
function accountIsPartitioned(): boolean {
  return (selection?.workspaces.length ?? 0) > 1;
}

export function workspaceContainsProperty(propertyId: string | null | undefined): boolean {
  if (!selection || !selection.activeWorkspaceId) return true;
  const active = activeWorkspace();
  if (!active) return false;
  // A row with no house at all is account-level; the owned default workspace is
  // its only home, so it never appears in a second workspace.
  const id = propertyId?.trim();
  if (!id) return active.owned && active.isDefault && !accountIsPartitioned();
  if (active.propertyIds.some((known) => known.trim() === id)) return true;
  // A house this workspace does not hold never bleeds in — not one that belongs
  // to another workspace, and not one no workspace claims. Before workspaces
  // were partitioned, an unplaced house fell back to the default workspace;
  // that fallback is what made an empty workspace show the whole account.
  return !accountIsPartitioned() && active.owned && active.isDefault;
}

/** Application / lease rows carry the property id in one of several fields. */
export function workspacePropertyIdFromRow(row: {
  assignedPropertyId?: string | null;
  propertyId?: string | null;
  application?: { propertyId?: string | null } | null;
}): string | null {
  return row.assignedPropertyId?.trim() || row.propertyId?.trim() || row.application?.propertyId?.trim() || null;
}

export function filterRowsInActiveWorkspace<T>(
  rows: readonly T[],
  propertyIdOf: (row: T) => string | null | undefined,
): T[] {
  return rows.filter((row) => workspaceContainsProperty(propertyIdOf(row)?.trim() || undefined));
}

/**
 * The houses the active workspace holds, as a scope every list can pass down.
 * `null` means "not narrowing" — the selection has not loaded, or the account
 * is a single workspace. An EMPTY ARRAY means the workspace genuinely holds no
 * houses, which is not the same thing: a caller that treats it as "no filter"
 * shows the whole account in an empty workspace.
 */
export function activeWorkspacePropertyIds(): string[] | null {
  const active = activeWorkspace();
  if (!active) return null;
  if (!accountIsPartitioned()) return null;
  return active.propertyIds.map((id) => id.trim()).filter(Boolean);
}

/**
 * The active workspace as copy needs it: its name, and whether it is narrowing
 * the account at all. `null` until the selection has loaded or when there is no
 * active workspace — callers then read the whole account, as the filter does.
 */
export function activeWorkspaceScope(): {
  name: string;
  isDefault: boolean;
  propertyCount: number;
  /** False while the account is one workspace, so copy never blames an empty list on scope. */
  narrowing: boolean;
} | null {
  const active = activeWorkspace();
  if (!active) return null;
  return {
    name: active.name,
    isDefault: active.isDefault,
    propertyCount: active.propertyIds.length,
    narrowing: accountIsPartitioned(),
  };
}

/** Houses the account holds outside the active workspace — what an empty workspace is missing. */
export function propertiesOutsideActiveWorkspace(): number {
  if (!selection || !selection.activeWorkspaceId) return 0;
  return selection.workspaces
    .filter((w) => w.id !== selection!.activeWorkspaceId)
    .reduce((n, w) => n + w.propertyIds.length, 0);
}

/** Workspaces other than the active one, for copy that offers somewhere to go. */
export function otherWorkspaceSummaries(): { id: string; name: string; propertyCount: number }[] {
  if (!selection || !selection.activeWorkspaceId) return [];
  return selection.workspaces
    .filter((w) => w.id !== selection!.activeWorkspaceId)
    .map((w) => ({ id: w.id, name: w.name, propertyCount: w.propertyIds.length }));
}
