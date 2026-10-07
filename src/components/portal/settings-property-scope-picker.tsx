"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import { FieldSingleSelect } from "@/components/ui/checkbox-multi-select";
import { PortalSettingsGroup, PortalSettingsRow } from "@/components/portal/portal-settings-ui";
import { SettingsPropertyScopeProvider, type SettingsPropertyOption } from "@/components/portal/settings-property-scope";
import { useWorkspaces } from "@/components/portal/workspace-provider";
import { useManagerUserId } from "@/hooks/use-manager-user-id";
import { resolveManagerScopeUserId } from "@/lib/demo/demo-session";
import { buildManagerPropertyFilterOptions } from "@/lib/manager-portfolio-access";
import {
  allWorkspacePropertyOptions,
  propertyOptionsFromWorkspacePayload,
  unionLabeledPropertyOptions,
} from "@/lib/workspaces/selection";

/** The houses of the workspace chosen in the shell's switcher (every workspace's when none is chosen). */
export function useWorkspacePropertyOptions(): { workspaceId: string; options: SettingsPropertyOption[] } {
  const workspaces = useWorkspaces();
  const { userId } = useManagerUserId();
  const workspaceId = workspaces?.active?.id ?? "";
  const options = useMemo(() => {
    const listed = workspaces?.workspaces ?? [];
    const local = buildManagerPropertyFilterOptions(resolveManagerScopeUserId(userId));
    const active = workspaceId ? listed.find((item) => item.id === workspaceId) : undefined;
    if (!active) return unionLabeledPropertyOptions(allWorkspacePropertyOptions(listed), local);
    const fromPayload = propertyOptionsFromWorkspacePayload(active);
    const allowed = new Set(fromPayload.map((option) => option.id));
    return unionLabeledPropertyOptions(fromPayload, local.filter((option) => allowed.has(option.id)));
  }, [userId, workspaceId, workspaces?.workspaces]);
  return { workspaceId, options };
}

const NOOP = () => {};

/**
 * A "Property" dropdown above a settings section whose values are stored per
 * property (tour rules, move-in form reminders). "All properties" edits the
 * workspace default every property follows; a chosen property edits that one
 * property's own value. The panels below read the choice through
 * `useSettingsPropertyScope`, so they save to the same storage as before.
 */
export function SettingsPropertyScope({
  children,
  allLabel = "All properties",
  allowAll = true,
}: {
  children: ReactNode;
  allLabel?: string;
  /** False when the setting has no workspace-wide value — a property must be chosen. */
  allowAll?: boolean;
}) {
  const { workspaceId, options } = useWorkspacePropertyOptions();
  const [propertyIds, setPropertyIds] = useState<string[]>([]);
  useEffect(() => {
    setPropertyIds((current) => {
      const next = current.filter((id) => options.some((option) => option.id === id));
      return next.length === current.length ? current : next;
    });
  }, [options]);
  const selected = propertyIds[0] ?? (allowAll ? "" : (options[0]?.id ?? ""));
  const effectiveIds = useMemo(() => (selected ? [selected] : []), [selected]);
  return (
    <SettingsPropertyScopeProvider
      workspaceId={workspaceId}
      onWorkspaceIdChange={NOOP}
      propertyIds={effectiveIds}
      onPropertyIdsChange={setPropertyIds}
      options={options}
    >
      <PortalSettingsGroup>
        <PortalSettingsRow label="Property">
          <FieldSingleSelect
            hideLabel
            label="Property"
            variant="cell"
            wrapperClassName="w-64"
            value={selected}
            options={[...(allowAll ? [{ value: "", label: allLabel }] : []), ...options.map((option) => ({ value: option.id, label: option.label }))]}
            onChange={(next) => setPropertyIds(next ? [next] : [])}
            dataAttr="settings-property-scope"
          />
        </PortalSettingsRow>
      </PortalSettingsGroup>
      {children}
    </SettingsPropertyScopeProvider>
  );
}
