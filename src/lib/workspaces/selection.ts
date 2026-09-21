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

/** The selected workspace id, or null before the selection loads. Readers that cache per workspace key on this. */
export function selectedWorkspaceId(): string | null {
  return selection?.activeWorkspaceId ?? null;
}

export function activeWorkspaceIdentity(): { id: string; isDefault: boolean } | null {
  const active = activeWorkspace();
  if (!active) return null;
  return { id: active.id, isDefault: active.isDefault };
}

/**
 * True once the account holds more than one workspace. Only account-level
 * rows (no house at all) consult this: they live in the owned default
 * workspace of a single-workspace account and nowhere once it is partitioned.
 * A row that names a house never does — see `workspaceContainsProperty`.
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
  // Membership is the only test. A house this workspace does not hold never
  // shows here — not one that belongs to another workspace, and not one no
  // workspace claims at all. There used to be a fallback that let an unplaced
  // house into a single-workspace account's default workspace, on the theory
  // that a record the server had not placed yet should not vanish. In practice
  // every row that names a house (a tour, an application, a lease) names a
  // house the server already holds, so the only thing the fallback ever let
  // through was seed data for houses that do not exist — which is exactly how
  // a workspace with zero properties came to show eight tours, twice.
  return active.propertyIds.some((known) => known.trim() === id);
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
 * `null` means "not narrowing" — the selection has not loaded yet. An EMPTY
 * ARRAY means the workspace genuinely holds no houses, which is not the same
 * thing: a caller that treats it as "no filter" shows the whole account in an
 * empty workspace.
 */
export function activeWorkspacePropertyIds(): string[] | null {
  const active = activeWorkspace();
  if (!active) return null;
  return active.propertyIds.map((id) => id.trim()).filter(Boolean);
}

export type WorkspacePropertySource = {
  propertyIds: readonly string[];
  propertyLabels?: Record<string, string> | null;
};

/** Houses one workspace payload already knows about — never the pipeline cache. */
export function propertyOptionsFromWorkspacePayload(
  workspace: WorkspacePropertySource,
): { id: string; label: string }[] {
  const labels = workspace.propertyLabels ?? {};
  return workspace.propertyIds
    .map((id) => id.trim())
    .filter(Boolean)
    .map((id) => {
      const label = (labels[id] ?? "").trim();
      return { id, label: label || "Untitled property" };
    });
}

/** Union of every workspace's houses, first-seen wins. Settings "All workspaces". */
export function allWorkspacePropertyOptions(
  workspaces: readonly WorkspacePropertySource[],
): { id: string; label: string }[] {
  const seen = new Set<string>();
  const out: { id: string; label: string }[] = [];
  for (const workspace of workspaces) {
    for (const option of propertyOptionsFromWorkspacePayload(workspace)) {
      if (seen.has(option.id)) continue;
      seen.add(option.id);
      out.push(option);
    }
  }
  return out;
}

/** Workspace-payload labels first, then any extra ids the local store still knows.
 *  A payload house whose label is still the untitled fallback takes a real store name. */
export function unionLabeledPropertyOptions<T extends { id: string; label: string }>(
  primary: readonly T[],
  extra: readonly T[],
): T[] {
  const byId = new Map<string, T>();
  for (const option of primary) byId.set(option.id, option);
  for (const option of extra) {
    const existing = byId.get(option.id);
    if (!existing) {
      byId.set(option.id, option);
      continue;
    }
    if (existing.label === "Untitled property" && option.label.trim() && option.label !== "Untitled property") {
      byId.set(option.id, { ...existing, label: option.label });
    }
  }
  return [...byId.values()];
}

/**
 * Houses the active workspace holds, with the labels the server already
 * attached to the workspace payload. List pickers seed from this so an empty
 * local pipeline does not hide houses the workspace knows about.
 */
export function activeWorkspacePropertyOptions(): { id: string; label: string }[] {
  const active = activeWorkspace();
  if (!active) return [];
  return propertyOptionsFromWorkspacePayload(active);
}

/** Property ids on workspaces this account owns — not the pipeline cache. */
export function ownedWorkspacePropertyIds(): string[] {
  if (!selection) return [];
  const ids: string[] = [];
  for (const workspace of selection.workspaces) {
    if (!workspace.owned) continue;
    for (const id of workspace.propertyIds) {
      const trimmed = id.trim();
      if (trimmed) ids.push(trimmed);
    }
  }
  return ids;
}

/**
 * Settings "Applies to" lists. `null` selection means not narrowing yet (tests
 * and first paint) — pass the options through. An empty array is a workspace
 * with no houses, so the picker is empty.
 */
export function filterPropertyOptionsForActiveWorkspace<T extends { id: string }>(
  options: readonly T[],
): T[] {
  const ids = activeWorkspacePropertyIds();
  if (ids === null) return [...options];
  const allowed = new Set(ids);
  return options.filter((option) => allowed.has(option.id));
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
