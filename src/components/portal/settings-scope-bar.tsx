"use client";

import { useMemo } from "react";
import { CheckboxMultiSelect, FieldSingleSelect, type CheckboxMultiSelectGroup } from "@/components/ui/checkbox-multi-select";
import { FIELD_SELECT_TRIGGER_TOOLBAR_PILL_CLASS } from "@/components/ui/field-select-styles";
import { PortalSettingsScopeTag } from "@/components/portal/portal-settings-ui";
import { useWorkspaces } from "@/components/portal/workspace-provider";
import {
  useSettingsPropertyScope,
  type SettingsResolutionSource,
  type SettingsSourceNamespace,
} from "@/components/portal/settings-property-scope";
import {
  resolveScopeTreeChange,
  scopeTreeCheckedValues,
  summarizeScopeTreeSelection,
  workspaceOptionValue,
  type ScopeTreeWorkspace,
} from "@/lib/scope/settings-scope-tree";

/** "Account" / "Workspace" / "Own values on N properties" — the one vocabulary every scope tag in Settings uses. */
export function scopeTagLabel(source: SettingsResolutionSource, propertyCount: number): string {
  if (source === "account") return "Account";
  if (source === "workspace") return "Workspace";
  return `Own values on ${propertyCount} ${propertyCount === 1 ? "property" : "properties"}`;
}

/**
 * A group's own tag, read back from whatever it (or a sibling reporting the
 * same namespace) already fetched — never re-derived from the bar's
 * selection, so a house that never had its own override still honestly
 * shows "Workspace" even while it is the one selected in the bar.
 */
export function SettingsGroupSourceTag({ namespace }: { namespace: SettingsSourceNamespace }) {
  const scope = useSettingsPropertyScope();
  const source = scope.sources[namespace];
  if (!source) return null;
  return <PortalSettingsScopeTag variant="muted">{scopeTagLabel(source, scope.propertyIds.length)}</PortalSettingsScopeTag>;
}

/**
 * One scope bar per settings module (AGENTS.md § Icon chrome: "one property
 * control in module chrome … never repeat it on each section header").
 *
 * - `variant="full"` (the ten Portfolio + Operations modules with a per-house
 *   rung): ONE multi-select box — every workspace is a selectable group
 *   header ("My workspace · all houses"), its houses listed beneath it.
 *   Checking the header selects every house under it; checking houses one at
 *   a time promotes back to the header once all of them are checked. A
 *   picked selection can span several workspaces at once.
 * - `variant="workspace-only"` (Notifications — manager alert routing has no
 *   per-house rung): the SAME multi-select, restricted to workspace headers
 *   only, no house rows.
 * - `variant="single-workspace"` (Communication — a work number and a work
 *   email belong to exactly one workspace, never several at once): a plain
 *   single-select workspace picker, bound to the SAME global workspace
 *   switcher `useWorkspaces()` drives, so Communication always shows the
 *   currently active workspace's channels and switching here also switches
 *   the app's active workspace.
 *
 * `variant="full"`/`"workspace-only"` selection lives in
 * `useSettingsPropertyScope()` (the module's own local/URL-backed state);
 * `"single-workspace"` bypasses that context entirely and reads/writes the
 * global switcher directly — Communication's panel already reads the global
 * active workspace (`useSelectedWorkspaceId`), so this variant needs no
 * provider wrap and no plumbing beyond the picker itself.
 */
export function SettingsScopeBar({ variant = "full" }: { variant?: "full" | "workspace-only" | "single-workspace" }) {
  // A thin, hook-free dispatcher — `single-workspace` renders a fully
  // separate component with its own hooks rather than sharing this
  // function's, so neither branch mixes hooks with a conditional return.
  if (variant === "single-workspace") {
    return <SingleWorkspaceScopeBar />;
  }
  return <MultiScopeBar variant={variant} />;
}

function MultiScopeBar({ variant }: { variant: "full" | "workspace-only" }) {
  const workspaces = useWorkspaces();
  const scope = useSettingsPropertyScope();

  const treeWorkspaces: ScopeTreeWorkspace[] = useMemo(
    () => (workspaces?.workspaces ?? []).map((w) => ({ id: w.id, propertyIds: w.propertyIds })),
    [workspaces?.workspaces],
  );

  const selection = useMemo(
    () => ({ workspaceIds: scope.workspaceIds, propertyIds: scope.propertyIds }),
    [scope.workspaceIds, scope.propertyIds],
  );

  /**
   * Nothing explicit picked yet resolves to the active workspace (the
   * Provider's own `targets` default) — the checkboxes must show THAT as
   * checked, not nothing, or the bar would display an empty picker while
   * every panel underneath is already scoped to a real workspace. A click
   * against this implicit state (e.g. un-checking one house) diffs against
   * it too, via `resolveScopeTreeChange`'s `current` argument below.
   */
  const effectiveSelection = useMemo(() => {
    if (selection.workspaceIds.length === 0 && selection.propertyIds.length === 0 && workspaces?.active?.id) {
      return { workspaceIds: [workspaces.active.id], propertyIds: [] };
    }
    return selection;
    // Depend on the whole `workspaces` object (not `workspaces?.active?.id` alone) —
    // the narrower dependency made the React Compiler skip optimizing this component.
  }, [selection, workspaces]);

  const checkedValues = useMemo(
    () => scopeTreeCheckedValues(treeWorkspaces, effectiveSelection),
    [treeWorkspaces, effectiveSelection],
  );

  const groups: CheckboxMultiSelectGroup[] = useMemo(
    () =>
      (workspaces?.workspaces ?? []).map((w) => ({
        label: w.name,
        options: [
          { value: workspaceOptionValue(w.id), label: "All houses in this workspace" },
          ...(variant === "full"
            ? w.propertyIds
                .map((id) => id.trim())
                .filter(Boolean)
                .map((id) => ({ value: id, label: (w.propertyLabels?.[id] ?? "").trim() || "Untitled property" }))
            : []),
        ],
      })),
    [workspaces?.workspaces, variant],
  );

  const handleChange = (nextRawValues: string[]) => {
    const next = resolveScopeTreeChange(treeWorkspaces, effectiveSelection, nextRawValues);
    scope.setWorkspaceIds(next.workspaceIds);
    scope.setPropertyIds(next.propertyIds);
  };

  const fallbackWorkspaceName =
    scope.workspaceIds.length === 0 && scope.propertyIds.length === 0 ? (workspaces?.active?.name ?? null) : null;
  const summary = summarizeScopeTreeSelection(workspaces?.workspaces ?? [], selection, fallbackWorkspaceName);
  const hasExplicitSelection = scope.workspaceIds.length > 0 || scope.propertyIds.length > 0;

  return (
    <div className="flex flex-wrap items-center gap-2">
      <CheckboxMultiSelect
        label={variant === "full" ? "Workspaces and properties" : "Workspaces"}
        hideLabel
        variant="pill"
        selected={checkedValues}
        onChange={handleChange}
        groups={groups}
        disabled={scope.loading || !workspaces || workspaces.loading}
        emptyLabel={fallbackWorkspaceName ? `${fallbackWorkspaceName} · all houses` : "All workspaces"}
        selectionTriggerLabel={summary}
        dataAttr="settings-scope-picker"
        className="max-w-[16rem]"
        menuFooter={(close) => (
          <button
            type="button"
            className="text-xs font-semibold text-muted hover:underline"
            data-attr="settings-scope-clear"
            disabled={!hasExplicitSelection}
            onClick={() => {
              scope.setWorkspaceIds([]);
              scope.setPropertyIds([]);
              scope.requestReset();
              close();
            }}
          >
            Reset to current workspace
          </button>
        )}
      />
      <PortalSettingsScopeTag dataAttr="settings-scope-summary">Applies to · {summary}</PortalSettingsScopeTag>
    </div>
  );
}

/**
 * Communication's scope: exactly one workspace, no houses. Bound to the
 * global active-workspace switcher (`useWorkspaces().select`), the same
 * state `pro-messaging-settings-panel.tsx` already reads through
 * `useSelectedWorkspaceId()` — this picker IS the module's scope control,
 * with no separate local/URL state to keep in sync.
 */
function SingleWorkspaceScopeBar() {
  const workspaces = useWorkspaces();
  const options = useMemo(
    () => (workspaces?.workspaces ?? []).map((w) => ({ value: w.id, label: w.name })),
    [workspaces?.workspaces],
  );
  const activeId = workspaces?.active?.id ?? "";

  return (
    <div className="flex flex-wrap items-center gap-2">
      <FieldSingleSelect
        label="Workspace"
        hideLabel
        value={activeId}
        onChange={(id) => void workspaces?.select(id, { href: false })}
        options={options}
        disabled={!workspaces || workspaces.loading}
        dataAttr="settings-scope-single-workspace"
        variant="pill"
        triggerClassName={`${FIELD_SELECT_TRIGGER_TOOLBAR_PILL_CLASS} max-w-[13rem]`}
      />
      <PortalSettingsScopeTag dataAttr="settings-scope-summary">Workspace</PortalSettingsScopeTag>
    </div>
  );
}
