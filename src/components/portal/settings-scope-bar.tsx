"use client";

import { useMemo } from "react";
import { CheckboxMultiSelect, FieldSingleSelect } from "@/components/ui/checkbox-multi-select";
import { FIELD_SELECT_TRIGGER_TOOLBAR_PILL_CLASS } from "@/components/ui/field-select-styles";
import { PortalSettingsScopeTag } from "@/components/portal/portal-settings-ui";
import { useWorkspaces } from "@/components/portal/workspace-provider";
import {
  useSettingsPropertyScope,
  type SettingsResolutionSource,
  type SettingsSourceNamespace,
} from "@/components/portal/settings-property-scope";

const ALL_WORKSPACES = "__all_workspaces__";

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
 * `variant="full"` (the eleven Portfolio + Operations modules) is a workspace
 * select, a properties multi-select scoped to that workspace, a bar-level tag
 * describing the CURRENT SELECTION, and a Reset control once houses are
 * picked. `variant="workspace-only"` (Notifications) drops the properties
 * picker entirely — manager alert routing has no per-house rung.
 *
 * The workspace select is bound to the SAME global selection the top-left
 * `WorkspaceSwitcher` reads (`useWorkspaces()`): picking a real workspace here
 * calls the same `select()` the switcher itself calls, so the two stay in
 * sync. "All workspaces" has no equivalent global state — a switch always
 * stands in exactly one workspace — so picking it is a local-only override
 * for this module's fetches; it never forces the global switcher into an
 * impossible "no workspace" state, and switching workspaces globally always
 * still shows here.
 */
export function SettingsScopeBar({ variant = "full" }: { variant?: "full" | "workspace-only" }) {
  const scope = useSettingsPropertyScope();
  const workspaces = useWorkspaces();

  const workspaceOptions = useMemo(
    () => [
      { value: ALL_WORKSPACES, label: "All workspaces" },
      ...(workspaces?.workspaces.map((w) => ({ value: w.id, label: w.name })) ?? []),
    ],
    [workspaces?.workspaces],
  );

  // Properties scoped to whichever workspace is chosen — "All workspaces" falls
  // back to the full account list the host already computed for the provider.
  const propertyOptions = useMemo(() => {
    if (!scope.workspaceId) return scope.options;
    const active = workspaces?.workspaces.find((w) => w.id === scope.workspaceId);
    if (!active) return scope.options;
    const labels = active.propertyLabels ?? {};
    return active.propertyIds
      .map((id) => id.trim())
      .filter(Boolean)
      .map((id) => ({ id, label: (labels[id] ?? "").trim() || "Untitled property" }));
  }, [scope.workspaceId, scope.options, workspaces?.workspaces]);

  const selectionSource: SettingsResolutionSource =
    scope.propertyIds.length > 0 ? "property" : scope.workspaceId ? "workspace" : "account";

  const handleWorkspaceChange = (next: string) => {
    const id = next === ALL_WORKSPACES ? "" : next;
    scope.setWorkspaceId(id);
    scope.setPropertyIds([]);
    if (id) void workspaces?.select(id, { href: false });
  };

  return (
    <div className="flex flex-wrap items-center gap-2">
      <FieldSingleSelect
        label="Workspace"
        hideLabel
        value={scope.workspaceId || ALL_WORKSPACES}
        onChange={handleWorkspaceChange}
        options={workspaceOptions}
        disabled={scope.loading || !workspaces || workspaces.loading}
        dataAttr="settings-scope-workspace"
        variant="pill"
        triggerClassName={`${FIELD_SELECT_TRIGGER_TOOLBAR_PILL_CLASS} max-w-[13rem]`}
      />
      {variant === "full" ? (
        <CheckboxMultiSelect
          label="Properties"
          hideLabel
          variant="pill"
          selected={scope.propertyIds}
          onChange={scope.setPropertyIds}
          options={propertyOptions.map((o) => ({ value: o.id, label: o.label }))}
          disabled={scope.loading}
          emptyLabel={scope.workspaceId ? "All properties in workspace" : "All properties"}
          dataAttr="settings-scope-properties"
          className="max-w-[15rem]"
          menuFooter={(close) => (
            <div className="flex gap-2">
              <button
                type="button"
                className="text-xs font-semibold text-primary hover:underline"
                data-attr="settings-scope-properties-select-all"
                onClick={() => {
                  scope.setPropertyIds(propertyOptions.map((o) => o.id));
                  close();
                }}
              >
                Select all
              </button>
              <button
                type="button"
                className="text-xs font-semibold text-muted hover:underline"
                data-attr="settings-scope-properties-clear"
                disabled={scope.propertyIds.length === 0}
                onClick={() => {
                  scope.setPropertyIds([]);
                  close();
                }}
              >
                Clear
              </button>
            </div>
          )}
        />
      ) : null}
      <PortalSettingsScopeTag>{scopeTagLabel(selectionSource, scope.propertyIds.length)}</PortalSettingsScopeTag>
      {variant === "full" && scope.propertyIds.length > 0 ? (
        <button
          type="button"
          onClick={() => {
            scope.requestReset();
            scope.setPropertyIds([]);
          }}
          disabled={scope.loading}
          data-attr="settings-scope-reset"
          className="text-[13px] font-semibold text-primary transition-colors hover:text-primary/80 disabled:opacity-50"
        >
          Reset to workspace
        </button>
      ) : null}
    </div>
  );
}
