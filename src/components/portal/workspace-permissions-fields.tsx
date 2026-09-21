"use client";

/**
 * The reusable pieces of "Edit permissions": Role, Houses, Selected houses,
 * the per-module Custom editor, and the read-only "<Role> can" capability
 * list. `WorkspacePermissionsFields` bundles the first three so every place
 * that assigns a role over a set of houses — the Team page's Edit permissions
 * sheet and the workspace invite sheet — renders the identical controls
 * rather than growing its own copy. `RoleCapabilitiesList` is the matching
 * read-only view for a stock (non-Custom) role.
 */

import { FieldSingleSelect, CheckboxMultiSelect } from "@/components/ui/checkbox-multi-select";
import { cn } from "@/lib/utils";
import { workspaceRightsForRole, type HouseScope } from "@/lib/workspaces/membership";
import {
  inferTeamRoleFromPermissions,
  stampTeamRolePermissions,
  TEAM_ROLE_INVITE_OPTIONS,
  TEAM_ROLE_LABELS,
  type TeamRoleId,
} from "@/lib/co-manager-team-roles";
import {
  CO_MANAGER_PERMISSION_OPTIONS,
  type CoManagerPermissionId,
  type CoManagerPermissions,
} from "@/lib/co-manager-permissions";
import type { WorkspaceCoManagerGrant } from "@/lib/workspace-co-manager-permissions";

/** Role → the row's chips: what the person can do in each module, read-only. */
export function RoleCapabilitiesList({ role, grant }: { role: TeamRoleId; grant: CoManagerPermissions }) {
  const rights = workspaceRightsForRole(role);
  const rows: { label: string; value: string; on: boolean }[] = [
    { label: "Invite and edit members", value: rights.members ? "Yes" : "No", on: rights.members },
    { label: "Add and move houses in this workspace", value: rights.houses ? "Yes" : "No", on: rights.houses },
    ...CO_MANAGER_PERMISSION_OPTIONS.map(({ id, label }) => {
      const access = levelsToAccess(grantToLevels(grant[id]));
      return {
        label,
        value: MODULE_ACCESS_OPTIONS.find((option) => option.id === access)?.label ?? "No access",
        on: access !== "none",
      };
    }),
  ];
  return (
    <div className="rounded-xl border border-border bg-card" data-attr="team-role-can">
      <p className="px-3 pt-2.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-muted">{TEAM_ROLE_LABELS[role]} can</p>
      <ul className="mt-1 divide-y divide-border/60">
        {rows.map((row) => (
          <li key={row.label} className="flex items-center justify-between gap-3 px-3 py-2 text-[13.5px]">
            <span className="text-foreground">{row.label}</span>
            <span
              className={cn(
                "shrink-0 rounded-full px-2.5 py-0.5 text-[11px] font-semibold",
                row.on ? "bg-primary/10 text-primary" : "bg-[var(--secondary)] text-muted",
              )}
            >
              {row.value}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** @deprecated Use {@link RoleCapabilitiesList}. Kept only during the rename. */
export const RoleCanTable = RoleCapabilitiesList;

function CoManagerRoleSelect({
  value,
  onChange,
  disabled,
  dataAttr = "co-manager-role",
}: {
  value: TeamRoleId;
  onChange: (next: TeamRoleId) => void;
  disabled?: boolean;
  dataAttr?: string;
}) {
  return (
    <FieldSingleSelect
      label="Role"
      options={TEAM_ROLE_INVITE_OPTIONS}
      // The legacy Full access stamp is the same grant as Admin and lists as it.
      value={value === "full" ? "admin" : value}
      onChange={(next) => onChange(next as TeamRoleId)}
      disabled={disabled}
      dataAttr={dataAttr}
    />
  );
}

function HouseScopeSelect({
  value,
  onChange,
  workspaceName,
  houseCount,
  disabled,
  dataAttr = "team-house-scope",
}: {
  value: HouseScope;
  onChange: (next: HouseScope) => void;
  workspaceName: string;
  houseCount: number;
  disabled?: boolean;
  dataAttr?: string;
}) {
  return (
    <FieldSingleSelect
      label="Houses"
      options={[
        { value: "all", label: `All houses in ${workspaceName} (${houseCount})` },
        { value: "selected", label: "Only selected houses" },
      ]}
      value={value}
      onChange={(next) => onChange(next === "all" ? "all" : "selected")}
      disabled={disabled}
      dataAttr={dataAttr}
    />
  );
}

/**
 * Role + Houses + (when scoped) Selected houses — the one system both the
 * Team page's Edit permissions sheet and the workspace invite sheet render,
 * so a manager sees the identical controls whether they are inviting someone
 * new or changing an existing member's reach.
 *
 * `workspace` is null only for a legacy local relationship with no resolved
 * workspace — there the Houses scope choice does not apply and the multi-
 * select alone stands in, labelled "Houses" instead of "Selected houses".
 */
export function WorkspacePermissionsFields({
  role,
  onRoleChange,
  houseScope,
  onHouseScopeChange,
  selectedHouseIds,
  onSelectedHouseIdsChange,
  workspace,
  houseOptions,
  disabled,
  roleDataAttr = "co-manager-role",
  houseScopeDataAttr = "team-house-scope",
  selectedHousesDataAttr = "team-member-houses",
}: {
  role: TeamRoleId;
  onRoleChange: (next: TeamRoleId) => void;
  houseScope: HouseScope;
  onHouseScopeChange: (next: HouseScope) => void;
  selectedHouseIds: string[];
  onSelectedHouseIdsChange: (next: string[]) => void;
  /** null when no workspace is resolved for this row. */
  workspace: { name: string; houseCount: number } | null;
  houseOptions: { value: string; label: string }[];
  disabled?: boolean;
  roleDataAttr?: string;
  houseScopeDataAttr?: string;
  selectedHousesDataAttr?: string;
}) {
  return (
    <>
      <CoManagerRoleSelect value={role} onChange={onRoleChange} disabled={disabled} dataAttr={roleDataAttr} />
      {workspace ? (
        <HouseScopeSelect
          value={houseScope}
          disabled={disabled}
          workspaceName={workspace.name}
          houseCount={workspace.houseCount}
          onChange={onHouseScopeChange}
          dataAttr={houseScopeDataAttr}
        />
      ) : null}
      {houseScope === "selected" || !workspace ? (
        <CheckboxMultiSelect
          label={workspace ? "Selected houses" : "Houses"}
          labelClassName="text-xs font-semibold text-foreground"
          options={houseOptions}
          selected={selectedHouseIds}
          onChange={onSelectedHouseIdsChange}
          emptyLabel="Select houses…"
          searchPlaceholder="Search houses…"
          dataAttr={selectedHousesDataAttr}
        />
      ) : null}
    </>
  );
}

export function WorkspaceGrantFields({
  value,
  onChange,
  disabled,
}: {
  value: WorkspaceCoManagerGrant;
  onChange: (next: WorkspaceCoManagerGrant) => void;
  disabled?: boolean;
}) {
  return (
    <fieldset className="space-y-2" data-attr="team-workspace-grants">
      <legend className="text-xs font-semibold text-foreground">Workspace</legend>
      <label className="flex min-h-11 items-center gap-3 rounded-xl border border-border bg-card px-3 text-[13.5px]">
        <input
          type="checkbox"
          checked={value.addProperties === true}
          disabled={disabled}
          onChange={(e) => onChange({ ...value, addProperties: e.target.checked ? true : undefined })}
          data-attr="team-grant-add-properties"
        />
        Add properties
      </label>
      <label className="flex min-h-11 items-center gap-3 rounded-xl border border-border bg-card px-3 text-[13.5px]">
        <input
          type="checkbox"
          checked={value.teams === true}
          disabled={disabled}
          onChange={(e) => onChange({ ...value, teams: e.target.checked ? true : undefined })}
          data-attr="team-grant-invite-teammates"
        />
        Invite teammates
      </label>
    </fieldset>
  );
}

type GrantLevels = { read?: boolean; edit?: boolean; delete?: boolean; notification?: boolean };

function grantToLevels(grant: CoManagerPermissions[CoManagerPermissionId]): GrantLevels {
  if (grant === true) return { read: true, edit: true, delete: true, notification: true };
  if (grant && typeof grant === "object") {
    const read = grant.read === true || grant.edit === true || grant.delete === true;
    const notification =
      grant.notification === false
        ? false
        : grant.notification === true || read || grant.edit === true || grant.delete === true;
    return {
      read,
      edit: grant.edit === true,
      delete: grant.delete === true,
      notification,
    };
  }
  return {};
}

function levelsToGrant(levels: GrantLevels): CoManagerPermissions[CoManagerPermissionId] | undefined {
  if (levels.read && levels.edit && levels.delete && levels.notification) return true;
  const grant: GrantLevels = {};
  if (levels.read) grant.read = true;
  if (levels.edit) grant.edit = true;
  if (levels.delete) grant.delete = true;
  if (levels.notification) grant.notification = true;
  if (levels.notification === false) grant.notification = false;
  return Object.keys(grant).length > 0 ? grant : undefined;
}

// "All delete" grants delete (without edit) so it stays distinct from "All edit";
// "All full access" is read+edit+delete (collapses to the legacy `true`). The
// grant-map builder lives in the lib (buildAllModulesGrant) so it is unit-tested.
const permissionToggleActive =
  "border-primary bg-primary/10 text-foreground shadow-sm";
const permissionToggleInactive =
  "border-border bg-card text-muted hover:border-primary/40 hover:text-foreground";

function PermissionLevelToggle({
  label,
  active,
  disabled,
  onToggle,
  dataAttr,
  title,
}: {
  label: string;
  active: boolean;
  disabled?: boolean;
  onToggle: () => void;
  dataAttr?: string;
  /** Why a toggle is disabled, so a locked control explains itself. */
  title?: string;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onToggle}
      data-attr={dataAttr}
      title={title}
      className={`rounded-full border px-2.5 py-1 text-[11px] font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
        active ? permissionToggleActive : permissionToggleInactive
      }`}
    >
      {label}
    </button>
  );
}

type ModuleAccessLevel = "none" | "view" | "edit" | "manage";

const MODULE_ACCESS_OPTIONS: Array<{ id: ModuleAccessLevel; label: string; hint: string }> = [
  { id: "none", label: "No access", hint: "The module is hidden for this property." },
  { id: "view", label: "View", hint: "Read records; nothing can be changed." },
  { id: "edit", label: "Edit", hint: "Create and change records; never delete." },
  { id: "manage", label: "Manage", hint: "Everything, including delete." },
];

function levelsToAccess(levels: GrantLevels): ModuleAccessLevel {
  if (levels.delete) return "manage";
  if (levels.edit) return "edit";
  if (levels.read) return "view";
  return "none";
}

function accessToLevels(access: ModuleAccessLevel, notification: boolean | undefined): GrantLevels {
  if (access === "none") return {};
  const notify = notification ?? true;
  if (access === "view") return { read: true, notification: notify };
  if (access === "edit") return { read: true, edit: true, notification: notify };
  return { read: true, edit: true, delete: true, notification: notify };
}

/**
 * Per-module access, one decision each: No access / View / Edit / Manage,
 * plus whether the person is notified. Empty means no access — assigning a
 * property never grants a module by itself. The grant written is the same
 * `{ read, edit, delete, notification }` shape every server gate reads.
 */
export function CoManagerPermissionsEditor({
  value,
  onChange,
  disabled,
  variant = "readWrite",
  role,
  onRoleChange,
  hideRole = false,
}: {
  value: CoManagerPermissions;
  onChange: (next: CoManagerPermissions) => void;
  disabled?: boolean;
  /** Kept for callers; both variants now expose the same four levels. */
  variant?: "readWrite" | "full";
  role?: TeamRoleId;
  onRoleChange?: (next: TeamRoleId) => void;
  /** Invite sheet puts Role above Properties. */
  hideRole?: boolean;
}) {
  void variant;
  const currentRole = role ?? inferTeamRoleFromPermissions(value);

  const applyRole = (next: TeamRoleId) => {
    onRoleChange?.(next);
    const stamp = stampTeamRolePermissions(next);
    if (stamp) onChange(stamp);
  };

  const setLevels = (id: CoManagerPermissionId, levels: GrantLevels) => {
    const next = { ...value };
    const grant = levelsToGrant(levels);
    if (grant === undefined) delete next[id];
    else next[id] = grant;
    onChange(next);
    if (currentRole !== "custom") onRoleChange?.("custom");
  };

  const isEmpty = Object.keys(value).length === 0;
  const grantedCount = CO_MANAGER_PERMISSION_OPTIONS.filter(({ id }) => levelsToAccess(grantToLevels(value[id])) !== "none").length;

  return (
    <div className="space-y-3">
      {hideRole ? null : (
        <CoManagerRoleSelect value={currentRole} onChange={applyRole} disabled={disabled} />
      )}
      <div className="flex flex-wrap items-center gap-1.5">
        <button
          type="button"
          disabled={disabled || isEmpty}
          onClick={() => {
            onChange({});
            onRoleChange?.("custom");
          }}
          className="rounded-full border border-border bg-card px-2.5 py-1 text-xs font-medium text-muted transition-colors hover:bg-accent/40 disabled:cursor-not-allowed disabled:opacity-50"
          data-attr="co-manager-preset-none"
        >
          Clear all
        </button>
        <span className="ml-auto text-xs text-muted" data-attr="co-manager-effective-access">
          {isEmpty
            ? "No access"
            : `${grantedCount} of ${CO_MANAGER_PERMISSION_OPTIONS.length} modules granted`}
        </span>
      </div>
      {isEmpty ? (
        <p className="rounded-lg border border-dashed border-border bg-accent/20 px-3 py-2 text-xs text-muted">
          No access. Choose a role, or set View, Edit, or Manage for each module below.
        </p>
      ) : null}
      <div className="space-y-2">
        {CO_MANAGER_PERMISSION_OPTIONS.map(({ id, label }) => {
          const levels = grantToLevels(value[id]);
          const access = levelsToAccess(levels);
          return (
            <div
              key={id}
              className={`flex flex-col gap-2 rounded-xl border border-border bg-card px-3 py-2.5 sm:flex-row sm:items-center sm:justify-between ${
                disabled ? "opacity-60" : ""
              }`}
              data-attr={`co-manager-module-${id}`}
            >
              <span className="text-sm font-medium text-foreground">{label}</span>
              <div className="flex flex-wrap items-center gap-1.5">
                <div
                  role="radiogroup"
                  aria-label={`${label} access`}
                  className="inline-flex rounded-full border border-border bg-[var(--secondary)]/50 p-0.5"
                >
                  {MODULE_ACCESS_OPTIONS.map((option) => (
                    <button
                      key={option.id}
                      type="button"
                      role="radio"
                      aria-checked={access === option.id}
                      disabled={disabled}
                      title={option.hint}
                      data-attr={`co-manager-${id}-${option.id}`}
                      onClick={() => setLevels(id, accessToLevels(option.id, levels.notification))}
                      className={`rounded-full px-2.5 py-1 text-[11px] font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
                        access === option.id
                          ? "bg-card text-primary shadow-sm"
                          : "text-muted hover:text-foreground"
                      }`}
                    >
                      {option.label}
                    </button>
                  ))}
                </div>
                {/* Read is implied by every level above No access, so the only
                    remaining choice per module is whether alerts are sent. */}
                {access !== "none" ? (
                  <PermissionLevelToggle
                    label="Notify"
                    active={Boolean(levels.notification)}
                    disabled={disabled}
                    dataAttr={`co-manager-${id}-notify`}
                    onToggle={() => setLevels(id, { ...levels, notification: !levels.notification })}
                  />
                ) : (
                  <span className="sr-only" data-attr={`co-manager-${id}-read-implied`}>
                    Read included with any access level
                  </span>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
