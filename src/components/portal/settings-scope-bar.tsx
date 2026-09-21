"use client";

import { useMemo } from "react";
import { CheckboxMultiSelect, FieldSingleSelect } from "@/components/ui/checkbox-multi-select";
import { FIELD_SELECT_TRIGGER_TOOLBAR_PILL_CLASS } from "@/components/ui/field-select-styles";
import { PortalSettingsScopeTag } from "@/components/portal/portal-settings-ui";
import { useWorkspaces } from "@/components/portal/workspace-provider";
import {
  allWorkspacePropertyOptions,
  propertyOptionsFromWorkspacePayload,
  unionLabeledPropertyOptions,
} from "@/lib/workspaces/selection";
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
 * `variant="full"` (the Portfolio + Operations modules, including Payouts) is a
 * workspace select, a properties multi-select scoped to that workspace, a
 * bar-level tag describing the CURRENT SELECTION, and a Reset control once
 * houses are picked. `variant="workspace-only"` (Notifications) drops the
 * properties picker entirely — manager alert routing has no per-house rung.
 *
 * The workspace select is Settings-only. It does not call the portal header
 * `WorkspaceSwitcher`'s `select()` — All workspaces can mean the account
 * while Inbox / Properties stay on whichever workspace the header last picked.
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

  // Houses from the workspace payload first (even when the local pipeline is
  // empty), then any extra labels the host already computed.
  const propertyOptions = useMemo(() => {
    const listed = workspaces?.workspaces ?? [];
    const fromPayload = scope.workspaceId
      ? (() => {
          const active = listed.find((w) => w.id === scope.workspaceId);
          return active ? propertyOptionsFromWorkspacePayload(active) : [];
        })()
      : allWorkspacePropertyOptions(listed);
    if (scope.workspaceId) {
      const allowed = new Set(fromPayload.map((option) => option.id));
      return unionLabeledPropertyOptions(
        fromPayload,
        scope.options.filter((option) => allowed.has(option.id)),
      );
    }
    return unionLabeledPropertyOptions(fromPayload, scope.options);
  }, [scope.workspaceId, scope.options, workspaces?.workspaces]);

  const selectionSource: SettingsResolutionSource =
    scope.propertyIds.length > 0 ? "property" : scope.workspaceId ? "workspace" : "account";

  const handleWorkspaceChange = (next: string) => {
    const id = next === ALL_WORKSPACES ? "" : next;
    scope.setWorkspaceId(id);
    scope.setPropertyIds([]);
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
          emptyMenuText={scope.workspaceId ? "No houses in this workspace" : "No houses"}
          dataAttr="settings-scope-properties"
          className="max-w-[15rem]"
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
