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
 * One scope bar, four shapes.
 *
 * `variant="full"` / `"workspace-only"` (the default) is the pre-existing
 * per-list-page settings gear picker (`ProPortalSettingsModal`, opened from
 * Tours/Applications/Leases/… list headers) — unchanged here.
 *
 * `variant="applies-to"` / `"applies-to-workspace-only"` are what the
 * Settings *nav* pages use (S008/S014, captain 2026-09-27 — the S014
 * correction KEPT the properties picker after an earlier pass had dropped
 * it): same workspace select, properties multi-select, and Reset as `"full"`
 * / `"workspace-only"` — per-property overrides stay settable from Settings,
 * exactly as before — except the label reads "Applies to" / "All my
 * workspaces" instead of "Workspace" / "All workspaces", and the bar's own
 * Account/Workspace/"Own values on N properties" tag is gone (still removed
 * per S008). `applies-to` carries the properties picker (Communication,
 * Payments, Payouts); `applies-to-workspace-only` does not (Application
 * form, Lease documents — no per-house rung, same reason `"workspace-only"`
 * never carried one either).
 */
export function SettingsScopeBar({
  variant = "full",
}: {
  variant?: "full" | "workspace-only" | "applies-to" | "applies-to-workspace-only";
}) {
  const scope = useSettingsPropertyScope();
  const workspaces = useWorkspaces();
  const appliesTo = variant === "applies-to" || variant === "applies-to-workspace-only";
  const showProperties = variant === "full" || variant === "applies-to";

  const workspaceOptions = useMemo(
    () => [
      { value: ALL_WORKSPACES, label: appliesTo ? "All my workspaces" : "All workspaces" },
      ...(workspaces?.workspaces.map((w) => ({ value: w.id, label: w.name })) ?? []),
    ],
    [appliesTo, workspaces?.workspaces],
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
      {appliesTo ? <span className="text-[13px] font-semibold text-foreground">Applies to</span> : null}
      <FieldSingleSelect
        label={appliesTo ? "Applies to" : "Workspace"}
        hideLabel
        value={scope.workspaceId || ALL_WORKSPACES}
        onChange={handleWorkspaceChange}
        options={workspaceOptions}
        disabled={scope.loading || !workspaces || workspaces.loading}
        dataAttr="settings-scope-workspace"
        variant="pill"
        triggerClassName={`${FIELD_SELECT_TRIGGER_TOOLBAR_PILL_CLASS} ${appliesTo ? "max-w-[16rem]" : "max-w-[13rem]"}`}
      />
      {showProperties ? (
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
      {appliesTo ? null : (
        <PortalSettingsScopeTag>{scopeTagLabel(selectionSource, scope.propertyIds.length)}</PortalSettingsScopeTag>
      )}
      {showProperties && scope.propertyIds.length > 0 ? (
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

/** "Own values on N properties" — how many properties override a workspace default. */
export function ownValuesOnPropertiesLabel(count: number): string {
  return `Own values on ${count} ${count === 1 ? "property" : "properties"}`;
}
