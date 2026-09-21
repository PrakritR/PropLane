/**
 * Pure client-safe helpers for the Settings scope bar's cross-workspace
 * multi-select (captain: "the dropdown should be a multi-select box" —
 * choose which workspace(s) AND which house(s), not just houses within one
 * workspace). No "server-only" import here — `settings-scope-bar.tsx` runs
 * this in the browser on every checkbox click.
 *
 * A selection is stored as two id lists, matching
 * `settings-property-scope.tsx`'s context shape:
 *   - `workspaceIds`: whole-workspace picks (the "workspace rung": every
 *     house in that workspace, resolved without naming one).
 *   - `propertyIds`: individually picked houses, which may belong to a
 *     workspace that is NOT itself in `workspaceIds` (a partial pick).
 *
 * The multi-select widget (`CheckboxMultiSelect`) knows nothing about this
 * workspace/house relationship — it just reports the flat array of checked
 * option values after one checkbox toggled. `WS_VALUE_PREFIX` marks a
 * workspace-header option's value (`ws:<id>`) so this module can tell a
 * "select the whole workspace" click apart from a "select one house" click
 * in that flat array, and `resolveScopeTreeChange` turns it into the
 * canonical two-list selection:
 *
 *   - Checking a workspace header selects every house under it (and drops
 *     any of that workspace's individually-picked houses — the header
 *     supersedes them).
 *   - Unchecking a workspace header that was fully selected clears the
 *     whole workspace (not "every house individually").
 *   - Unchecking ONE house under an otherwise fully-selected workspace
 *     converts that workspace from "whole workspace" to "every house
 *     except this one, individually" — the header checkbox un-checks
 *     itself, its siblings stay checked.
 *   - Checking every house of a workspace one at a time promotes the
 *     selection back to that workspace's header (saving writes the
 *     workspace rung, not N house rows, matching the plan's ask).
 */

export const WS_VALUE_PREFIX = "ws:";

export function workspaceOptionValue(workspaceId: string): string {
  return `${WS_VALUE_PREFIX}${workspaceId}`;
}

export function isWorkspaceOptionValue(value: string): boolean {
  return value.startsWith(WS_VALUE_PREFIX);
}

export function workspaceIdFromOptionValue(value: string): string {
  return value.slice(WS_VALUE_PREFIX.length);
}

export type ScopeTreeWorkspace = { id: string; propertyIds: string[] };

export type ScopeTreeSelection = { workspaceIds: string[]; propertyIds: string[] };

function ownerWorkspaceId(workspaces: readonly ScopeTreeWorkspace[], propertyId: string): string | null {
  return workspaces.find((w) => w.propertyIds.includes(propertyId))?.id ?? null;
}

/**
 * The raw checkbox values a `CheckboxMultiSelect` should show as checked for
 * a given canonical selection — every selected workspace header PLUS every
 * house under it (so picking a workspace visibly checks its houses too),
 * plus every individually-picked house.
 */
export function scopeTreeCheckedValues(
  workspaces: readonly ScopeTreeWorkspace[],
  selection: ScopeTreeSelection,
): string[] {
  const values = new Set<string>();
  for (const workspaceId of selection.workspaceIds) {
    values.add(workspaceOptionValue(workspaceId));
    const workspace = workspaces.find((w) => w.id === workspaceId);
    for (const propertyId of workspace?.propertyIds ?? []) values.add(propertyId);
  }
  for (const propertyId of selection.propertyIds) values.add(propertyId);
  return [...values];
}

/**
 * Turn the multi-select's next raw checked-values array (after ONE checkbox
 * toggled) into the canonical `{ workspaceIds, propertyIds }` selection,
 * applying the header/house tree rules above. `current` is the selection
 * the bar held before this toggle (used to diff which single value changed).
 */
export function resolveScopeTreeChange(
  workspaces: readonly ScopeTreeWorkspace[],
  current: ScopeTreeSelection,
  nextRawValues: readonly string[],
): ScopeTreeSelection {
  const prevRaw = new Set(scopeTreeCheckedValues(workspaces, current));
  const nextRaw = new Set(nextRawValues);
  const added = [...nextRaw].filter((v) => !prevRaw.has(v));
  const removed = [...prevRaw].filter((v) => !nextRaw.has(v));

  const workspaceIds = new Set(current.workspaceIds);
  const propertyIds = new Set(current.propertyIds);

  const dropWorkspaceHouses = (workspaceId: string) => {
    const workspace = workspaces.find((w) => w.id === workspaceId);
    for (const propertyId of workspace?.propertyIds ?? []) propertyIds.delete(propertyId);
  };

  const maybePromoteToWorkspace = (workspaceId: string) => {
    const workspace = workspaces.find((w) => w.id === workspaceId);
    if (!workspace || workspace.propertyIds.length === 0) return;
    if (workspace.propertyIds.every((id) => propertyIds.has(id))) {
      workspaceIds.add(workspaceId);
      dropWorkspaceHouses(workspaceId);
    }
  };

  for (const value of removed) {
    if (isWorkspaceOptionValue(value)) {
      const workspaceId = workspaceIdFromOptionValue(value);
      workspaceIds.delete(workspaceId);
      dropWorkspaceHouses(workspaceId);
      continue;
    }
    const wasWholeWorkspace = (() => {
      const owner = ownerWorkspaceId(workspaces, value);
      return owner ? workspaceIds.has(owner) : false;
    })();
    if (wasWholeWorkspace) {
      // One house un-checked out of an otherwise fully-selected workspace:
      // demote header -> every sibling individually, minus this one.
      const owner = ownerWorkspaceId(workspaces, value);
      if (owner) {
        workspaceIds.delete(owner);
        const workspace = workspaces.find((w) => w.id === owner);
        for (const propertyId of workspace?.propertyIds ?? []) {
          if (propertyId !== value) propertyIds.add(propertyId);
        }
      }
    } else {
      propertyIds.delete(value);
    }
  }

  for (const value of added) {
    if (isWorkspaceOptionValue(value)) {
      const workspaceId = workspaceIdFromOptionValue(value);
      workspaceIds.add(workspaceId);
      dropWorkspaceHouses(workspaceId);
      continue;
    }
    const owner = ownerWorkspaceId(workspaces, value);
    if (owner && workspaceIds.has(owner)) continue; // already implied by the workspace header
    propertyIds.add(value);
    if (owner) maybePromoteToWorkspace(owner);
  }

  return { workspaceIds: [...workspaceIds], propertyIds: [...propertyIds] };
}

/**
 * "Applies to · <summary>" — the bar-level plain fact line (never subtext
 * prose; AGENTS.md § No subtext). One workspace and nothing else reads as
 * the workspace's own name; anything else collapses to a count, following
 * the same "short reads as itself, long collapses" rule field selects use.
 */
export function summarizeScopeTreeSelection(
  workspaces: readonly { id: string; name: string; propertyIds: string[] }[],
  selection: ScopeTreeSelection,
  fallbackWorkspaceName: string | null,
): string {
  const explicitHouseCount = selection.propertyIds.length;
  const wholeWorkspaceCount = selection.workspaceIds.length;

  if (wholeWorkspaceCount === 0 && explicitHouseCount === 0) {
    return fallbackWorkspaceName ? `${fallbackWorkspaceName} · all houses` : "All workspaces";
  }
  if (explicitHouseCount === 0) {
    if (wholeWorkspaceCount === 1) {
      const workspace = workspaces.find((w) => w.id === selection.workspaceIds[0]);
      return workspace ? `${workspace.name} · all houses` : "1 workspace";
    }
    return `${wholeWorkspaceCount} workspaces`;
  }

  // Mixed: some whole workspaces plus some individually-picked houses (or
  // only individually-picked houses). Count every touched workspace and
  // every touched house (a whole workspace's houses count via its size).
  const touchedWorkspaceIds = new Set(selection.workspaceIds);
  let houseCount = 0;
  for (const workspaceId of selection.workspaceIds) {
    houseCount += workspaces.find((w) => w.id === workspaceId)?.propertyIds.length ?? 0;
  }
  for (const propertyId of selection.propertyIds) {
    houseCount += 1;
    const owner = ownerWorkspaceId(workspaces, propertyId);
    if (owner) touchedWorkspaceIds.add(owner);
  }
  const workspaceCount = touchedWorkspaceIds.size;
  const houseWord = houseCount === 1 ? "house" : "houses";
  if (workspaceCount <= 1) return `${houseCount} ${houseWord}`;
  return `${houseCount} ${houseWord} in ${workspaceCount} workspaces`;
}
