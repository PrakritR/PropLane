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
 * Module rows grouped the way the manager sidebar itself groups sections
 * (`src/lib/portals/nav-groups.ts` PRO_GROUPS), so "grouped like the sidebar"
 * (C112) is one map onto the real nav rather than an invented taxonomy.
 * `bankAccount` and `teams` have no sidebar row of their own (bank lives
 * inside Payments' setup modal; Team lives under Settings -> Workspaces) —
 * both get their own trailing group rather than being folded silently into
 * an unrelated one.
 */
const PERMISSION_EDITOR_GROUPS: Array<{ label: string; ids: CoManagerPermissionId[] }> = [
  { label: "Workspace", ids: ["properties"] },
  { label: "Leasing", ids: ["applications", "leases"] },
  { label: "Tenancy", ids: ["residents", "payments", "services"] },
  { label: "Operations", ids: ["calendar", "inbox"] },
  { label: "Marketing", ids: ["promotion"] },
  { label: "Finances", ids: ["financials", "documents", "bankAccount"] },
  { label: "Administration", ids: ["teams"] },
];

/**
 * One-click presets that set every module dropdown at once (C112 "plus 3
 * presets") — real ids standing in for the studio mock's leasing_only /
 * full_no_money / everything trio. `Clear all` (below) already covers the
 * fourth "reset to nothing" case, so it stays a separate, always-present
 * action rather than a fourth preset.
 */
const PERMISSION_LEVEL_PRESETS: Array<{ label: string; dataAttr: string; levels: Partial<Record<CoManagerPermissionId, ModuleAccessLevel>> }> = [
  {
    label: "Leasing only",
    dataAttr: "co-manager-preset-leasing-only",
    levels: { applications: "manage", leases: "manage" },
  },
  {
    label: "Full access but money",
    dataAttr: "co-manager-preset-full-no-money",
    levels: Object.fromEntries(
      CO_MANAGER_PERMISSION_OPTIONS.map(({ id }) => [
        id,
        id === "bankAccount" || id === "financials" || id === "payments" ? "none" : "manage",
      ]),
    ) as Partial<Record<CoManagerPermissionId, ModuleAccessLevel>>,
  },
  {
    label: "Everything",
    dataAttr: "co-manager-preset-everything",
    levels: Object.fromEntries(CO_MANAGER_PERMISSION_OPTIONS.map(({ id }) => [id, "manage"])) as Partial<
      Record<CoManagerPermissionId, ModuleAccessLevel>
    >,
  },
];

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

  const applyPreset = (levels: Partial<Record<CoManagerPermissionId, ModuleAccessLevel>>) => {
    const next: CoManagerPermissions = {};
    for (const { id } of CO_MANAGER_PERMISSION_OPTIONS) {
      const access = levels[id] ?? "none";
      const grant = levelsToGrant(accessToLevels(access, grantToLevels(value[id]).notification));
      if (grant !== undefined) next[id] = grant;
    }
    onChange(next);
    onRoleChange?.("custom");
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
        {PERMISSION_LEVEL_PRESETS.map((preset) => (
          <button
            key={preset.dataAttr}
            type="button"
            disabled={disabled}
            onClick={() => applyPreset(preset.levels)}
            className="rounded-full border border-border bg-card px-2.5 py-1 text-xs font-medium text-muted transition-colors hover:bg-accent/40 disabled:cursor-not-allowed disabled:opacity-50"
            data-attr={preset.dataAttr}
          >
            {preset.label}
          </button>
        ))}
        <span className="ml-auto text-xs text-muted" data-attr="co-manager-effective-access">
          {isEmpty
            ? "No access"
            : `${grantedCount} of ${CO_MANAGER_PERMISSION_OPTIONS.length} modules granted`}
        </span>
      </div>
      {isEmpty ? (
        <p className="rounded-lg border border-dashed border-border bg-accent/20 px-3 py-2 text-xs text-muted">
          No access. Choose a role, a preset, or set View, Edit, or Manage for each module below.
        </p>
      ) : null}
      <div className="space-y-4">
        {PERMISSION_EDITOR_GROUPS.map((group) => (
          <div key={group.label} className="space-y-2">
            <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted" data-attr={`co-manager-group-${group.label.toLowerCase()}`}>
              {group.label}
            </p>
            {group.ids.map((id) => {
        const label = CO_MANAGER_PERMISSION_OPTIONS.find((option) => option.id === id)!.label;
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
        ))}
      </div>
    </div>
  );
}
