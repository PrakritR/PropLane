"use client";
import { RowSelectCheckbox } from "@/components/ui/row-select-checkbox";
import { PortalRecordListSurface } from "@/components/portal/portal-record-list-surface";

import { usePublishTitleActions } from "@/components/portal/portal-title-actions-slot";

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Users, UserPlus, Copy } from "lucide-react";
import { Button } from "@/components/ui/button";
import { CheckboxMultiSelect } from "@/components/ui/checkbox-multi-select";
import { Modal } from "@/components/ui/modal";
import { PortalActiveFilterChips } from "@/components/portal/portal-filter-chips";
import { PortalFilterSortSheet, portalFilterActiveCount } from "@/components/portal/portal-filter-sort-sheet";
import { PORTAL_PROPERTY_FILTER_SHEET_CLASS } from "@/components/portal/portal-filter-shell";
import { ApplicationFilterSortFields } from "@/components/portal/application-filter-sort-fields";
import { PortalListControlStack } from "@/components/portal/portal-list-control-stack";
import { PortalInvitePaths, type PortalInvitePath } from "@/components/portal/portal-invite-paths";
import { PortalIconAction } from "@/components/portal/portal-icon-action";
import {
  ManagerPortalPageShell,
} from "@/components/portal/portal-metrics";
import {
  PortalDataTableEmpty,
  PORTAL_DETAIL_BTN,
  PortalTableDetailActions,
} from "@/components/portal/portal-data-table";
import { PORTAL_LIST_PAGE_BODY } from "@/components/portal/portal-inbox-ui";
import { TeamMembersBlock, TeamPendingInvitesBlock, type TeamMemberRow } from "@/components/portal/pro-team-blocks";
import type { PortalWorkspace } from "@/lib/workspaces/types";
import { cn } from "@/lib/utils";
import { PortalRecordDetailPage } from "@/components/portal/portal-record-detail-page";
import { useAppUi } from "@/components/providers/app-ui-provider";
import { usePortalRowSelection } from "@/hooks/use-portal-row-selection";
import { PORTAL_BULK_BAR_BTN } from "@/lib/portal-bulk-bar";
import type { AccountLinkInviteDto } from "@/lib/account-links";
import {
  buildAllModulesGrant,
  describeCoManagerPermissions,
  CO_MANAGER_PERMISSION_OPTIONS,
  EMPTY_CO_MANAGER_PERMISSIONS,
  normalizeCoManagerPermissions,
  normalizePropertyCoManagerPermissions,
  flatCoManagerPermissionsFromProperty,
  permissionsForProperty,
  type CoManagerBulkPreset,
  type CoManagerPermissionId,
  type CoManagerPermissions,
  type PropertyCoManagerPermissions,
} from "@/lib/co-manager-permissions";
import {
  PROPERTY_PIPELINE_EVENT,
  readPendingManagerPropertiesForUser,
  readExtraListingsForUser,
} from "@/lib/demo-property-pipeline";
import {
  buildManagerPropertyFilterOptions,
  ownedPropertyIdsForUser,
  readLinkedListingsForUser,
  resolvePropertyLabelForId,
  disambiguatePropertyOptionLabels,
  safePropertyOptionLabel,
  samePropertyId,
  syncManagerPortfolioFromServer,
  teamInviteEligiblePropertyIds,
} from "@/lib/manager-portfolio-access";
import {
  AXIS_ID_LABEL,
  generateRelationshipId,
  proRelationshipRowsFromInvites,
  readProRelationships,
  writeProRelationships,
  syncProRelationshipsFromServer,
  type ProRelationshipRecord,
} from "@/lib/pro-relationships";
import { maxAccountLinksForTier, managerPlanAllowsCoManagerInvites, normalizeManagerSkuTier } from "@/lib/manager-access";
import { useWorkspaces } from "@/components/portal/workspace-provider";
import {
  assignedIdsInWorkspace,
  grantBelongsToWorkspace,
  teamGrantVisibleInWorkspace,
} from "@/lib/workspaces/team-scope";
import {
  listOutgoingCoManagerLinks,
  listOutgoingCoManagersForProperty,
  resolveAssignedPropertyId,
  type CoManagerPropertyLink,
} from "@/lib/co-manager-property-links";
import { syncManagerApplicationsFromServer } from "@/lib/manager-applications-storage";
import {
  invalidateAccountLinksCache,
  seedAccountLinksCache,
} from "@/lib/portal-data-store";
import { syncLeasePipelineFromServer } from "@/lib/lease-pipeline-storage";
import { syncHouseholdChargesFromServer } from "@/lib/household-charges";
import { Input, Select } from "@/components/ui/input";
import { usePaidPortalBasePath } from "@/lib/portal-base-path-client";
import { teamLinkHref, teamMemberDetailHref } from "@/lib/portal-detail-routes";
import { usePortalNavigate } from "@/lib/portal-nav-client";
import { useManagerUserId } from "@/hooks/use-manager-user-id";
import {
  PortalNotificationPreviewModal,
  type NotificationConfirmDraft,
  type NotificationDeliveryChannels,
} from "@/components/portal/portal-notification-preview-modal";
import {
  PortalBulkMessageCarouselModal,
  type BulkMessageCarouselItem,
} from "@/components/portal/portal-bulk-message-carousel-modal";
import { deliverManagerDirectoryMessage } from "@/lib/manager-vendor-invite-client";
import {
  buildCoManagerInviteBody,
  buildCoManagerInviteDeclinedBody,
  buildCoManagerInviteWithdrawnBody,
  buildCoManagerLinkLeftBody,
  buildCoManagerLinkRemovedBody,
  coManagerInviteDeclinedSubject,
  coManagerInviteWithdrawnSubject,
  coManagerLinkLeftSubject,
  coManagerLinkRemovedSubject,
} from "@/lib/co-manager-link-email";
import { fetchAndCacheLandlordLegalName } from "@/lib/manager-landlord-profile";
import { formatProplaneIdForDisplay } from "@/lib/manager-id";
import { formatInviteMessageBody, formatInviteMessageSubject } from "@/lib/invite-message-body";
import { mintInviteLinkClient } from "@/lib/invite-links/mint-invite-link-client";
import { PhoneNumberField } from "@/components/ui/phone-number-field";
import {
  DEFAULT_NEW_INVITE_WORKSPACE_GRANT,
  normalizeWorkspacePermissions,
  type WorkspaceCoManagerGrant,
} from "@/lib/workspace-co-manager-permissions";

type TeamRemovePreviewItem = BulkMessageCarouselItem & {
  entry: TeamListEntry;
};

type LinkInvitePreview = {
  subject: string;
  body: string;
  recipientName: string;
  recipientUserId: string | null;
  recipientPhone?: string;
  recipientEmail?: string;
};

const TEAM_MEMBER_ROLE_LABEL = "Team";

type TeamListEntry = {
  id: string;
  name: string;
  axisId: string;
  statusLabel: string;
  preview: string;
  kind: "remote";
  invite: AccountLinkInviteDto;
} | {
  id: string;
  name: string;
  axisId: string;
  statusLabel: string;
  preview: string;
  kind: "local";
  row: ProRelationshipRecord;
};

type InviteDraft = {
  assignedPropertyIds: string[];
  propertyCoManagerPermissions: PropertyCoManagerPermissions;
  workspaceDefaultPermissions: CoManagerPermissions;
  workspacePermissions: WorkspaceCoManagerGrant;
};

function WorkspaceGrantFields({
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

/**
 * The properties this manager can assign to a co-manager.
 *
 * `notYetSynced` marks a listing that exists only in this browser's cache.
 * The server validates the invite against `manager_property_records`, so
 * offering one of those as selectable produced a 403 telling the manager they
 * do not manage a property sitting in their own Properties list — an accusation
 * for a sync gap they cannot see and did not cause (PRP-210). They stay VISIBLE,
 * because hiding a property the manager can see elsewhere is its own confusion;
 * they are simply not selectable until they exist server-side.
 */
function propertyChoices(userId: string): { id: string; label: string; notYetSynced?: boolean }[] {
  const live = readExtraListingsForUser(userId);
  const pend = readPendingManagerPropertiesForUser(userId);
  const out: { id: string; label: string; address?: string | null; notYetSynced?: boolean }[] = [];
  for (const p of live) {
    out.push({
      id: p.id,
      label: safePropertyOptionLabel([`${p.buildingName} · ${p.unitLabel || "Unit"}`, p.buildingName, p.address], p.id),
      address: p.address,
    });
  }
  for (const r of pend) {
    const joined = `${r.buildingName} · ${r.unitLabel}`;
    out.push({
      id: r.id,
      label: safePropertyOptionLabel([joined, r.buildingName, r.address], r.id),
      address: r.address,
      notYetSynced: true,
    });
  }
  // Two unnamed listings render the same placeholder, and picking the wrong row
  // here grants a third party access to the wrong property (PRP-211).
  return disambiguatePropertyOptionLabels(out);
}

function resolvePropertyLabel(id: string, fallback: string): string {
  return resolvePropertyLabelForId(id, fallback);
}

function teamPropertyPreview(propertyIds: string[], labelFor: (id: string) => string): string {
  if (propertyIds.length === 0) return "No properties assigned";
  const labels = propertyIds.slice(0, 2).map((id) => labelFor(id));
  const rest = propertyIds.length - labels.length;
  if (rest > 0) return `${labels.join(" · ")} · +${rest} more`;
  return labels.join(" · ");
}

/**
 * How long a pending invite has left, in words.
 *
 * A pending invite used to be acceptable forever, so nothing on this screen
 * ever told a manager that one had gone stale (PRP-205). Returns "" for a row
 * written before the column existed, rather than guessing a date.
 */
export function teamInvitePendingExpiryLabel(expiresAt: string | null | undefined, now = Date.now()): string {
  const at = expiresAt ? Date.parse(expiresAt) : Number.NaN;
  if (!Number.isFinite(at)) return "";
  const msLeft = at - now;
  if (msLeft <= 0) return "Expired";
  const days = Math.ceil(msLeft / 86_400_000);
  if (days <= 1) return "Expires today";
  return `Expires in ${days} days`;
}

function teamInviteStatusLabel(inv: AccountLinkInviteDto): string {
  if (inv.status === "pending") {
    const base = inv.direction === "incoming"
      ? "Needs approval"
      : inv.openInvite
        ? "Waiting to join"
        : "Invite sent";
    const expiry = teamInvitePendingExpiryLabel(inv.expiresAt);
    return expiry ? `${base} · ${expiry}` : base;
  }
  if (inv.direction === "incoming") return "Linked to you";
  return TEAM_MEMBER_ROLE_LABEL;
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
const CO_MANAGER_PERMISSION_PRESETS: { label: string; preset: CoManagerBulkPreset }[] = [
  { label: "All view", preset: "read" },
  { label: "All edit", preset: "edit" },
  { label: "All manage", preset: "full" },
];

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
function CoManagerPermissionsEditor({
  value,
  onChange,
  disabled,
  variant = "readWrite",
}: {
  value: CoManagerPermissions;
  onChange: (next: CoManagerPermissions) => void;
  disabled?: boolean;
  /** Kept for callers; both variants now expose the same four levels. */
  variant?: "readWrite" | "full";
}) {
  void variant;
  const presets = CO_MANAGER_PERMISSION_PRESETS;

  const setLevels = (id: CoManagerPermissionId, levels: GrantLevels) => {
    const next = { ...value };
    const grant = levelsToGrant(levels);
    if (grant === undefined) delete next[id];
    else next[id] = grant;
    onChange(next);
  };

  const isEmpty = Object.keys(value).length === 0;
  const grantedCount = CO_MANAGER_PERMISSION_OPTIONS.filter(({ id }) => levelsToAccess(grantToLevels(value[id])) !== "none").length;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-1.5">
        {presets.map((preset) => (
          <button
            key={preset.label}
            type="button"
            disabled={disabled}
            onClick={() => onChange(buildAllModulesGrant(preset.preset))}
            className="rounded-full border border-border bg-card px-2.5 py-1 text-xs font-medium text-foreground transition-colors hover:bg-accent/40 disabled:cursor-not-allowed disabled:opacity-50"
            data-attr={`co-manager-preset-${preset.label.toLowerCase().replace(/\s+/g, "-")}`}
          >
            {preset.label}
          </button>
        ))}
        <button
          type="button"
          disabled={disabled || isEmpty}
          onClick={() => onChange({})}
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
          No access. Choose View, Edit, or Manage for each module below, or start from a preset.
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

type PropertyPermissionsModalState = {
  propertyId: string;
  propertyLabel: string;
  draft: CoManagerPermissions;
  onSave: (next: CoManagerPermissions) => void;
};

function TeamMemberContactCard({ entry }: { entry: TeamListEntry }) {
  const email =
    entry.kind === "remote" ? entry.invite.linkedEmail?.trim() || null : null;
  const phone =
    entry.kind === "remote" ? entry.invite.linkedPhone?.trim() || null : null;
  const rows = [
    { label: "PropLane ID", value: entry.axisId },
    { label: "Status", value: entry.statusLabel },
    ...(email ? [{ label: "Email", value: email }] : []),
    ...(phone ? [{ label: "Phone", value: phone }] : []),
  ];
  return (
    <div className="rounded-2xl border border-border bg-card px-4 py-3" data-attr="team-member-contact-card">
      <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted">Contact</p>
      <dl className="mt-2 grid gap-2 sm:grid-cols-2">
        {rows.map((row) => (
          <div key={row.label}>
            <dt className="text-[10px] font-semibold uppercase tracking-wide text-muted">{row.label}</dt>
            <dd className="mt-0.5 text-sm text-foreground">{row.value}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

function inviteDraftFromRemote(inv: AccountLinkInviteDto): InviteDraft {
  const propertyCoManagerPermissions = normalizePropertyCoManagerPermissions(
    inv.propertyCoManagerPermissions ?? inv.coManagerPermissions,
    inv.assignedPropertyIds,
  );
  const workspaceDefaultPermissions = Object.keys(inv.coManagerPermissions ?? {}).length
    ? normalizeCoManagerPermissions(inv.coManagerPermissions)
    : Object.keys(flatCoManagerPermissionsFromProperty(propertyCoManagerPermissions)).length
      ? flatCoManagerPermissionsFromProperty(propertyCoManagerPermissions)
      : buildAllModulesGrant("read");
  return {
    assignedPropertyIds: [...inv.assignedPropertyIds],
    propertyCoManagerPermissions,
    workspaceDefaultPermissions,
    workspacePermissions: normalizeWorkspacePermissions(inv.workspacePermissions),
  };
}

function inviteDraftFromRelationship(row: ProRelationshipRecord): InviteDraft {
  const propertyCoManagerPermissions = normalizePropertyCoManagerPermissions(
    row.propertyCoManagerPermissions ?? row.coManagerPermissions,
    row.assignedPropertyIds,
  );
  return {
    assignedPropertyIds: [...row.assignedPropertyIds],
    propertyCoManagerPermissions,
    workspaceDefaultPermissions: Object.keys(row.coManagerPermissions ?? {}).length
      ? normalizeCoManagerPermissions(row.coManagerPermissions)
      : flatCoManagerPermissionsFromProperty(propertyCoManagerPermissions),
    workspacePermissions: normalizeWorkspacePermissions(
      (row as { workspacePermissions?: unknown }).workspacePermissions,
    ),
  };
}

function AddPropertyToCoManager({
  linkId,
  assignedPropertyIds,
  propertyOptions,
  onAddProperty,
  disabled,
}: {
  linkId: string;
  assignedPropertyIds: string[];
  propertyOptions: { id: string; label: string }[];
  onAddProperty: (linkId: string, propertyId: string) => void;
  disabled?: boolean;
}) {
  const unassigned = propertyOptions.filter((option) => !assignedPropertyIds.includes(option.id));
  if (unassigned.length === 0) {
    return null;
  }
  return (
    <div className="space-y-2">
      <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted">Add property access</p>
      <div className="flex flex-wrap gap-2">
        {unassigned.map((option) => (
          <Button
            key={option.id}
            type="button"
            variant="outline"
            className="rounded-full text-xs"
            disabled={disabled}
            onClick={() => onAddProperty(linkId, option.id)}
            data-attr="co-manager-add-property"
          >
            + {option.label}
          </Button>
        ))}
      </div>
    </div>
  );
}

/**
 * Settings → Workspaces renders the team inside each workspace card. The panel
 * keeps owning the invites, the modals and every action; the caller only
 * decides where each workspace's section goes.
 */
export type WorkspaceTeamApi = {
  /** The "Managers & permissions" section for one owned workspace: header with Invite, member rows, pending invites. */
  section: (workspace: PortalWorkspace) => ReactNode;
};

export function ProAccountLinksPanel({
  userId,
  linkId: linkIdProp,
  bare = false,
  renderWorkspaces,
}: {
  userId: string;
  linkId?: string;
  /** Inside Settings → Team: no page shell; the section header carries the title and the invite action sits in the tool row. */
  bare?: boolean;
  /**
   * Settings → Workspaces: instead of one list for the active workspace, hand
   * the caller a section per workspace (see WorkspaceTeamApi). Members are
   * grouped by the houses they were granted; the invite picker is scoped to the
   * card whose Invite was pressed.
   */
  renderWorkspaces?: (team: WorkspaceTeamApi) => ReactNode;
}) {
  const { email: managerEmail, ready: managerSessionReady } = useManagerUserId();
  const workspaces = useWorkspaces();
  const byWorkspace = typeof renderWorkspaces === "function";
  const ownedWorkspaces = useMemo(() => (workspaces?.workspaces ?? []).filter((w) => w.owned), [workspaces?.workspaces]);
  const activePropertyIds = workspaces?.active?.propertyIds;
  // Per-card rendering needs every grant, so the visibility scope is the union of
  // the owned workspaces' houses rather than the active workspace alone.
  const workspacePropertyIds = useMemo(
    () => (byWorkspace ? [...new Set(ownedWorkspaces.flatMap((w) => w.propertyIds))] : (activePropertyIds ?? [])),
    [byWorkspace, ownedWorkspaces, activePropertyIds],
  );
  const workspaceName = workspaces?.active?.name ?? "this workspace";
  // The card whose Invite was pressed; its houses are what the invite picker offers.
  const [inviteWorkspaceId, setInviteWorkspaceId] = useState<string | null>(null);
  const inviteWorkspace = byWorkspace ? (ownedWorkspaces.find((w) => w.id === inviteWorkspaceId) ?? workspaces?.active ?? null) : null;
  const pickerPropertyIds = useMemo(
    () => (byWorkspace ? (inviteWorkspace?.propertyIds ?? []) : workspacePropertyIds),
    [byWorkspace, inviteWorkspace, workspacePropertyIds],
  );
  const [managerDisplayName, setManagerDisplayName] = useState("Your property manager");
  const { showToast } = useAppUi();
  const navigate = usePortalNavigate();
  const portalBase = usePaidPortalBasePath();
  const routeLinkId = linkIdProp?.trim() || null;

  const [localTick, setLocalTick] = useState(0);
  const refreshLocal = useCallback(() => setLocalTick((n) => n + 1), []);

  useEffect(() => {
    if (!managerSessionReady) return;
    let cancelled = false;
    void (async () => {
      const name = await fetchAndCacheLandlordLegalName();
      if (cancelled) return;
      if (name) {
        setManagerDisplayName(name);
        return;
      }
      const email = managerEmail?.trim();
      setManagerDisplayName(email || "Your property manager");
    })();
    return () => {
      cancelled = true;
    };
  }, [managerSessionReady, managerEmail]);

  const [remoteLoaded, setRemoteLoaded] = useState(false);
  // Remote (account-backed) is the default; only a confirmed missing table
  // (migrationRequired) downgrades to localStorage-only mode.
  const [useRemote, setUseRemote] = useState(true);
  const [remoteInvites, setRemoteInvites] = useState<AccountLinkInviteDto[]>([]);
  // A failed load must NOT silently render "0 links" (a co-manager would think
  // their access vanished). We surface an explicit error + retry instead.
  const [loadError, setLoadError] = useState(false);
  const loadInFlightRef = useRef(false);
  const loadRetriedRef = useRef(false);
  const [inviteDrafts, setInviteDrafts] = useState<Record<string, InviteDraft>>({});
  const saveTimersRef = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  const [linkedPropertiesPopup, setLinkedPropertiesPopup] = useState<{
    label: string;
    propertyIds: string[];
  } | null>(null);

  const [teamPropertyFilters, setTeamPropertyFilters] = useState<string[]>([]);

  const [transferPropertyId, setTransferPropertyId] = useState<string | null>(null);
  const [transferCoManagerUserId, setTransferCoManagerUserId] = useState<string | null>(null);
  const [transferPermissions, setTransferPermissions] = useState<CoManagerPermissions>(EMPTY_CO_MANAGER_PERMISSIONS);
  const [transferBusy, setTransferBusy] = useState(false);
  const [propertyPermissionsModal, setPropertyPermissionsModal] = useState<PropertyPermissionsModalState | null>(null);
  const [permissionsMember, setPermissionsMember] = useState<TeamListEntry | null>(null);

  // Named function expression so the soft-retry below can re-invoke this exact
  // load directly. It must NOT hop through a ref: a ref captured this deep in the
  // handler chain is read during render by the React Compiler (react-hooks/refs).
  const loadRemoteInvites = useCallback(async function runLoadRemoteInvites(): Promise<void> {
    // In-flight guard: the initial-load effect and the post-purge refresh can
    // both fire; without this the auto-retry below could also stack.
    if (loadInFlightRef.current) return;
    loadInFlightRef.current = true;
    // On a transient failure, retry once after a short backoff before giving up
    // — a single blip must never surface as "0 links".
    const failSoft = (): boolean => {
      setUseRemote(true);
      if (!loadRetriedRef.current) {
        loadRetriedRef.current = true;
        window.setTimeout(() => void runLoadRemoteInvites(), 1200);
        return true; // retry scheduled
      }
      setLoadError(true);
      showToast("Couldn't load your linked accounts. Tap retry.");
      return false;
    };
    try {
      const res = await fetch("/api/pro/account-links", { credentials: "include" });
      let data: { invites?: AccountLinkInviteDto[]; migrationRequired?: boolean; error?: string } = {};
      try {
        data = (await res.json()) as typeof data;
      } catch {
        // Non-JSON (proxy/HTML error page) counts as a transient failure.
        failSoft();
        return;
      }
      if (data.migrationRequired) {
        // The invites table genuinely doesn't exist — localStorage-only mode.
        setUseRemote(false);
        setRemoteInvites([]);
        setLoadError(false);
        loadRetriedRef.current = false;
        return;
      }
      if (!res.ok) {
        // Transient server error: STAY in remote mode with last-known invites.
        // Downgrading to local here made saves silently diverge from the account.
        failSoft();
        return;
      }
      setUseRemote(true);
      setLoadError(false);
      loadRetriedRef.current = false;
      const invites = Array.isArray(data.invites) ? data.invites : [];
      setRemoteInvites(invites);
      seedAccountLinksCache(invites, data.migrationRequired);
      setInviteDrafts((prev) => {
        const next = { ...prev };
        for (const inv of invites.filter((i) => i.status === "accepted" || i.status === "pending")) {
          if (!saveTimersRef.current[inv.id]) {
            next[inv.id] = inviteDraftFromRemote(inv);
          }
        }
        return next;
      });
      const active = invites.filter((inv) => inv.status === "accepted");
      writeProRelationships(userId, proRelationshipRowsFromInvites(active));
    } catch {
      // Network error — keep remote mode so saves fail loudly instead of
      // silently writing localStorage that never reaches the account.
      failSoft();
    } finally {
      setRemoteLoaded(true);
      loadInFlightRef.current = false;
    }
  }, [showToast, userId]);

  useEffect(() => {
    const id = window.setTimeout(() => void loadRemoteInvites(), 0);
    return () => window.clearTimeout(id);
  }, [loadRemoteInvites]);

  useEffect(() => {
    let cancelled = false;
    // The route is under /api/pro, not /api/portal. This 404'd on every Team tab load, and a
    // 404 does not reject a fetch — the `.then` chain carried on and the panel looked fine, so
    // orphaned co-manager links were simply never purged. `account-links-sync.tsx` already
    // calls the correct path.
    void fetch("/api/pro/purge-orphaned-co-manager-links", {
      method: "POST",
      credentials: "include",
    })
      .then(() => syncProRelationshipsFromServer(userId))
      .then(() => loadRemoteInvites())
      .then(() => {
        if (!cancelled) refreshLocal();
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [userId, loadRemoteInvites, refreshLocal]);

  useEffect(() => {
    let cancelled = false;
    void syncManagerPortfolioFromServer(userId, { force: true }).then(() => {
      if (!cancelled) refreshLocal();
    });
    return () => {
      cancelled = true;
    };
  }, [refreshLocal, userId]);

  useEffect(() => {
    const on = () => refreshLocal();
    window.addEventListener("axis-pro-relationships", on);
    window.addEventListener(PROPERTY_PIPELINE_EVENT, on);
    return () => {
      window.removeEventListener("axis-pro-relationships", on);
      window.removeEventListener(PROPERTY_PIPELINE_EVENT, on);
    };
  }, [refreshLocal]);

  useEffect(() => {
    const saveTimers = saveTimersRef.current;
    return () => {
      for (const timer of Object.values(saveTimers)) {
        window.clearTimeout(timer);
      }
    };
  }, []);

  const localRows = useMemo(() => {
    void localTick;
    return readProRelationships(userId);
  }, [userId, localTick]);

  // Memoized so the reference is stable across renders. activeRemote feeds the
  // relationship-sync effect below; a fresh array each render would re-run that
  // effect every render, and its writeProRelationships dispatch bumps the nav
  // hook's tick, causing an infinite render loop.
  const activeRemote = useMemo(
    () => remoteInvites.filter((i) => i.status === "accepted"),
    [remoteInvites],
  );
  const incomingPending = useMemo(
    () => remoteInvites.filter((i) => i.status === "pending" && i.direction === "incoming"),
    [remoteInvites],
  );
  const outgoingPending = useMemo(
    () => remoteInvites.filter((i) => i.status === "pending" && i.direction === "outgoing"),
    [remoteInvites],
  );

  const teamFilterPropertyOptions = useMemo(() => {
    void localTick;
    return buildManagerPropertyFilterOptions(userId).filter((option) =>
      workspacePropertyIds.some((id) => samePropertyId(option.id, id)),
    );
  }, [userId, localTick, workspacePropertyIds]);

  const passesTeamPropertyFilter = useCallback((assignedPropertyIds: string[]) => {
    if (!teamGrantVisibleInWorkspace(assignedPropertyIds, workspacePropertyIds)) return false;
    if (teamPropertyFilters.length === 0) return true;
    const inWorkspace = assignedIdsInWorkspace(assignedPropertyIds, workspacePropertyIds);
    return inWorkspace.some((id) => teamPropertyFilters.some((filterId) => samePropertyId(id, filterId)));
  }, [teamPropertyFilters, workspacePropertyIds]);

  const visibleIncomingPending = useMemo(() => {
    if (!useRemote) return [];
    return incomingPending.filter((inv) => passesTeamPropertyFilter(inv.assignedPropertyIds));
  }, [useRemote, incomingPending, passesTeamPropertyFilter]);

  const visibleOutgoingPending = useMemo(() => {
    if (!useRemote) return [];
    return outgoingPending.filter((inv) => passesTeamPropertyFilter(inv.assignedPropertyIds));
  }, [useRemote, outgoingPending, passesTeamPropertyFilter]);

  const visibleActiveRemote = useMemo(() => {
    if (!useRemote) return [];
    return activeRemote.filter((inv) => passesTeamPropertyFilter(inv.assignedPropertyIds));
  }, [useRemote, activeRemote, passesTeamPropertyFilter]);

  const visibleLocalRows = useMemo(() => {
    return localRows.filter((r) => passesTeamPropertyFilter(r.assignedPropertyIds));
  }, [localRows, passesTeamPropertyFilter]);

  const propertyOptions = useMemo(() => {
    void localTick;
    return propertyChoices(userId).filter((option) =>
      pickerPropertyIds.some((id) => samePropertyId(option.id, id)),
    );
  }, [userId, localTick, pickerPropertyIds]);

  // Labels for every owned house, so a card's Properties column resolves even
  // when the house is not in the invite picker's workspace.
  const allOwnedPropertyOptions = useMemo(() => {
    void localTick;
    if (!byWorkspace) return [];
    return propertyChoices(userId).filter((option) =>
      workspacePropertyIds.some((id) => samePropertyId(option.id, id)),
    );
  }, [userId, localTick, byWorkspace, workspacePropertyIds]);

  // Properties this manager co-manages via an incoming account link (e.g. Brooklyn
  // when Ambika granted access). Shown under "You" so the panel matches Properties.
  const coManagedProperties = useMemo(() => {
    void localTick;
    return readLinkedListingsForUser(userId).map(({ listing, ownerUserId }) => ({
      id: listing.id,
      label: safePropertyOptionLabel(
        [`${listing.buildingName} · ${listing.unitLabel || "Unit"}`, listing.buildingName, listing.address],
        listing.id,
      ),
      ownerUserId,
    }));
  }, [userId, localTick]);

  const teamPropertyLabelById = useMemo(() => {
    const map = new Map<string, string>();
    for (const option of allOwnedPropertyOptions) map.set(option.id, option.label);
    for (const option of propertyOptions) map.set(option.id, option.label);
    for (const property of coManagedProperties) map.set(property.id, property.label);
    for (const inv of remoteInvites) {
      for (const [id, label] of Object.entries(inv.assignedPropertyLabels ?? {})) {
        if (typeof id === "string" && id.trim() && typeof label === "string" && label.trim()) {
          map.set(id, label.trim());
        }
      }
    }
    for (const workspace of ownedWorkspaces) {
      for (const [id, label] of Object.entries(workspace.propertyLabels ?? {})) {
        const trimmed = String(label ?? "").trim();
        if (!trimmed) continue;
        map.set(id, trimmed);
        for (const option of propertyOptions) {
          if (samePropertyId(option.id, id)) map.set(option.id, trimmed);
        }
        for (const option of allOwnedPropertyOptions) {
          if (samePropertyId(option.id, id)) map.set(option.id, trimmed);
        }
      }
    }
    return map;
  }, [allOwnedPropertyOptions, propertyOptions, coManagedProperties, remoteInvites, ownedWorkspaces]);

  const teamPropertyLabel = useCallback(
    (propertyId: string) =>
      teamPropertyLabelById.get(propertyId) ?? resolvePropertyLabel(propertyId, propertyId),
    [teamPropertyLabelById],
  );

  const [axisInput, setAxisInput] = useState("");
  const [linkModalOpen, setLinkModalOpen] = useState(false);

  const [linkInvitePreview, setLinkInvitePreview] = useState<LinkInvitePreview | null>(null);
  const [linkInviteBusy, setLinkInviteBusy] = useState(false);
  const [teamRemovePreview, setTeamRemovePreview] = useState<TeamRemovePreviewItem[] | null>(null);
  const [teamRemoveBusy, setTeamRemoveBusy] = useState(false);
  const [lookupBusy, setLookupBusy] = useState(false);
  const [draftAxisId, setDraftAxisId] = useState<string | null>(null);
  const [draftName, setDraftName] = useState<string | null>(null);
  const [draftUserId, setDraftUserId] = useState<string | null>(null);
  const [inviteeAtCap, setInviteeAtCap] = useState(false);

  const [selectedProps, setSelectedProps] = useState<Record<string, boolean>>({});
  const [propertyPermissionsDraft, setPropertyPermissionsDraft] = useState<PropertyCoManagerPermissions>({});
  const [inviteDefaultPermissions, setInviteDefaultPermissions] = useState<CoManagerPermissions>(() =>
    buildAllModulesGrant("read"),
  );
  const [inviteWorkspacePermissions, setInviteWorkspacePermissions] = useState<WorkspaceCoManagerGrant>(
    DEFAULT_NEW_INVITE_WORKSPACE_GRANT,
  );
  const [skuTier, setSkuTier] = useState<string | null>(null);
  const [invitePath, setInvitePath] = useState<PortalInvitePath>("link");
  const [inviteeName, setInviteeName] = useState("");
  const [inviteePhone, setInviteePhone] = useState("");
  const [inviteeEmail, setInviteeEmail] = useState("");
  const [mintedInviteUrl, setMintedInviteUrl] = useState<string | null>(null);
  const [inviteContinueBusy, setInviteContinueBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch("/api/manager/subscription", { credentials: "include" });
        const body = (await res.json()) as { tier?: string | null; isFree?: boolean };
        if (!res.ok || cancelled) return;
        if (body.isFree) {
          setSkuTier("free");
          return;
        }
        const t = body.tier?.trim() ?? null;
        setSkuTier(normalizeManagerSkuTier(t) ?? t);
      } catch {
        /* ignore */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const teamInviteEligibleIds = useMemo(() => {
    void localTick;
    return teamInviteEligiblePropertyIds(userId);
  }, [userId, localTick]);

  const ownsTeamInviteProperties = useMemo(() => {
    const owned = ownedPropertyIdsForUser(userId);
    return [...teamInviteEligibleIds].some((id) => owned.has(id));
  }, [userId, teamInviteEligibleIds]);

  const canSendTeamInvites = teamInviteEligibleIds.size > 0;

  const linkCap = maxAccountLinksForTier(skuTier);
  const participantUsedCount = remoteInvites.filter((i) => i.status === "pending" || i.status === "accepted").length;
  const atLinkCap = linkCap != null && (useRemote ? participantUsedCount >= linkCap : localRows.length >= linkCap);
  const planAllowsInvites = skuTier != null && managerPlanAllowsCoManagerInvites(skuTier);
  // Axis-ID / property-assignment path still needs at least one house to grant.
  const linkAccountBlocked =
    !canSendTeamInvites ||
    atLinkCap ||
    (ownsTeamInviteProperties && skuTier != null && !planAllowsInvites);
  // Invite-by-link can mint with zero properties (assign houses later — PRP-419).
  // Still honor plan + seat caps. Do not require a house just to open the mint UI.
  const inviteLinkBlocked =
    atLinkCap || (skuTier != null && !planAllowsInvites);

  const navigateToList = useCallback(() => {
    navigate(teamLinkHref(portalBase));
  }, [navigate, portalBase]);

  const teamEntries = useMemo((): TeamListEntry[] => {
    if (useRemote) {
      const invites = [
        ...visibleIncomingPending,
        ...visibleOutgoingPending,
        ...visibleActiveRemote,
      ];
      return invites.map((inv) => ({
        id: inv.id,
        name: inv.linkedDisplayName ?? inv.linkedAxisId,
        axisId: inv.linkedAxisId,
        statusLabel: teamInviteStatusLabel(inv),
        preview: teamPropertyPreview(
          assignedIdsInWorkspace(inv.assignedPropertyIds, workspacePropertyIds),
          teamPropertyLabel,
        ),
        kind: "remote" as const,
        invite: inv,
      }));
    }
    return visibleLocalRows.map((row) => ({
      id: row.id,
      name: row.linkedDisplayName ?? row.linkedAxisId,
      axisId: row.linkedAxisId,
      statusLabel: TEAM_MEMBER_ROLE_LABEL,
      preview: teamPropertyPreview(
        assignedIdsInWorkspace(row.assignedPropertyIds, workspacePropertyIds),
        teamPropertyLabel,
      ),
      kind: "local" as const,
      row,
    }));
  }, [
    useRemote,
    visibleIncomingPending,
    visibleOutgoingPending,
    visibleActiveRemote,
    visibleLocalRows,
    teamPropertyLabel,
    workspacePropertyIds,
  ]);

  const openTeamDetail = useCallback(
    (id: string) => {
      navigate(teamMemberDetailHref(portalBase, id));
    },
    [navigate, portalBase],
  );

  const { selectedIds, toggleSelected, clearSelection } = usePortalRowSelection(
    teamPropertyFilters.join(","),
  );

  const routeEntry = useMemo(() => {
    if (!routeLinkId) return null;
    return teamEntries.find((entry) => entry.id === routeLinkId) ?? null;
  }, [routeLinkId, teamEntries]);

  const detailPropertySelectionKey = routeLinkId ? `${routeLinkId}-properties` : "team-detail-idle";
  const {
    selectedIds: selectedDetailPropertyIds,
    toggleSelected: toggleDetailProperty,
    clearSelection: clearDetailPropertySelection,
  } = usePortalRowSelection(detailPropertySelectionKey);

  const detailPropertiesEditable = useMemo(() => {
    if (!routeEntry) return false;
    if (routeEntry.kind === "local") return true;
    return routeEntry.invite.direction === "outgoing";
  }, [routeEntry]);

  const tierShort =
    skuTier === "free"
      ? "Free"
      : skuTier === "pro"
        ? "Pro"
        : skuTier === "business"
          ? "Business"
          : skuTier?.trim()
            ? skuTier
            : null;

  const copyInviteAcceptLink = useCallback(
    async (inviteId: string, opts?: { openInvite?: boolean; inviteUrl?: string }) => {
      let url = opts?.inviteUrl?.trim() || "";
      if (!url && opts?.openInvite) {
        try {
          const res = await fetch(`/api/pro/account-links/${encodeURIComponent(inviteId)}/link`, {
            method: "POST",
            credentials: "include",
          });
          const data = (await res.json()) as { inviteUrl?: string; error?: string };
          if (!res.ok || !data.inviteUrl) {
            showToast(data.error ?? "Could not copy the invite link.");
            return;
          }
          url = data.inviteUrl;
        } catch {
          showToast("Could not copy the invite link.");
          return;
        }
      }
      if (!url) url = teamMemberDetailHref(portalBase, inviteId);
      try {
        await navigator.clipboard.writeText(url);
        showToast("Invite link copied.");
      } catch {
        showToast("Could not copy the invite link.");
      }
    },
    [portalBase, showToast],
  );

  const renderInviteAcceptLinkCard = (invite: AccountLinkInviteDto) => {
    const url = invite.openInvite
      ? "Shareable join link - copy to reveal a fresh URL"
      : teamMemberDetailHref(portalBase, invite.id);
    return (
      <div
        className="rounded-2xl border border-primary/20 bg-primary/[0.04] px-4 py-3"
        data-attr="co-manager-invite-link-card"
      >
        <p className="text-xs font-semibold uppercase tracking-wide text-muted">Invite link</p>
        {invite.openInvite ? null : (
          <p className="mt-1 break-all font-mono text-xs text-foreground">{url}</p>
        )}
        <p className="mt-2 text-xs leading-relaxed text-muted">
          {invite.openInvite
            ? "Share this link. She signs in or creates an account, then joins. Copying issues a fresh link; the previous one stops working."
            : "Share this link with the co-manager. When they sign in and open it, they can accept the invite."}
        </p>
        <Button
          type="button"
          variant="outline"
          className="mt-3 h-9 min-h-0 rounded-full px-4 text-[13px]"
          data-attr="co-manager-copy-invite-link"
          onClick={() => void copyInviteAcceptLink(invite.id, { openInvite: invite.openInvite })}
        >
          Copy invite link
        </Button>
      </div>
    );
  };

  const lookup = async (): Promise<{ axisId: string; name: string; userId: string | null } | null> => {
    const raw = axisInput.trim();
    if (!raw) {
      showToast(`Enter a ${AXIS_ID_LABEL}.`);
      return null;
    }
    setLookupBusy(true);
    setInviteeAtCap(false);
    try {
      const res = await fetch(`/api/pro/lookup-axis-id?axisId=${encodeURIComponent(raw)}`, {
        credentials: "include",
      });
      const body = (await res.json()) as {
        ok?: boolean;
        error?: string;
        displayName?: string;
        userId?: string;
        role?: string;
      };
      if (!res.ok || !body.ok) {
        showToast(body.error ?? "Lookup failed.");
        setDraftAxisId(null);
        return null;
      }
      const name = body.displayName ?? raw;
      const userId = body.userId ?? null;
      setDraftAxisId(raw);
      setDraftName(name);
      setDraftUserId(userId);
      showToast("Account verified.");
      return { axisId: raw, name, userId };
    } catch {
      showToast("Network error.");
      return null;
    } finally {
      setLookupBusy(false);
    }
  };

  /** Clear the whole in-progress link draft (used on cancel/close and after send). */
  const resetLinkDraft = () => {
    setAxisInput("");
    setDraftAxisId(null);
    setDraftName(null);
    setDraftUserId(null);
    setSelectedProps({});
    setPropertyPermissionsDraft({});
    setInviteeAtCap(false);
    setInvitePath("link");
    setInviteeName("");
    setInviteePhone("");
    setInviteeEmail("");
    setMintedInviteUrl(null);
    setInviteContinueBusy(false);
  };

  const openLinkModal = (workspaceId?: string) => {
    setInviteWorkspaceId(workspaceId ?? null);
    if (inviteLinkBlocked) {
      if (!canSendTeamInvites) {
        showToast("You do not have Team permission to invite co-managers.");
      } else if (atLinkCap) {
        showToast("You have reached your co-manager link limit.");
      } else {
        showToast("Upgrade to Pro or Business before linking co-managers.");
      }
      return;
    }
    resetLinkDraft();
    setInviteWorkspaceId(workspaceId ?? null);
    setLinkModalOpen(true);
  };

  const closeLinkModal = () => {
    setLinkModalOpen(false);
    resetLinkDraft();
  };

  const linkInvitePropertySelectOptions = useMemo(() => {
    const options: { value: string; label: string; disabled?: boolean; hint?: string }[] = [];
    const seen = new Set<string>();
    const eligible = (id: string) => [...teamInviteEligibleIds].some((eid) => samePropertyId(id, eid));

    if (byWorkspace) {
      // The card already listed these houses — offer every one, even when the
      // local listing store uses a different id spelling than the workspace row.
      for (const id of pickerPropertyIds) {
        const fromChoices = propertyOptions.find((o) => samePropertyId(o.id, id));
        const value = fromChoices?.id ?? id;
        const label =
          inviteWorkspace?.propertyLabels?.[id]?.trim() ||
          inviteWorkspace?.propertyLabels?.[value]?.trim() ||
          teamPropertyLabel(id) ||
          teamPropertyLabel(value);
        if (seen.has(value)) continue;
        seen.add(value);
        options.push({
          value,
          label,
          disabled: Boolean(fromChoices?.notYetSynced),
          hint: fromChoices?.notYetSynced ? "Still saving — you can assign this once it finishes." : undefined,
        });
      }
      return options;
    }

    for (const p of propertyOptions) {
      if (teamInviteEligibleIds.size > 0 && !eligible(p.id)) continue;
      seen.add(p.id);
      options.push({
        value: p.id,
        label: p.label,
        disabled: Boolean(p.notYetSynced),
        hint: p.notYetSynced ? "Still saving — you can assign this once it finishes." : undefined,
      });
    }
    for (const property of coManagedProperties) {
      if (teamInviteEligibleIds.size > 0 && !eligible(property.id)) continue;
      if (seen.has(property.id) || options.some((option) => samePropertyId(option.value, property.id))) continue;
      options.push({ value: property.id, label: property.label });
    }
    return options;
  }, [propertyOptions, coManagedProperties, teamInviteEligibleIds, byWorkspace, pickerPropertyIds, inviteWorkspace, teamPropertyLabel]);

  const handleLinkPropertySelectionChange = (nextIds: string[]) => {
    const nextSet = new Set(nextIds);
    setSelectedProps(() => {
      const next: Record<string, boolean> = {};
      for (const id of nextIds) next[id] = true;
      return next;
    });
    setPropertyPermissionsDraft((perms) => {
      const updated = { ...perms };
      for (const id of nextIds) {
        if (!updated[id]) updated[id] = inviteDefaultPermissions;
      }
      for (const id of Object.keys(updated)) {
        if (!nextSet.has(id)) delete updated[id];
      }
      return updated;
    });
  };

  useEffect(() => {
    if (!linkModalOpen) return;
    const ids = linkInvitePropertySelectOptions.filter((option) => !option.disabled).map((option) => option.value);
    handleLinkPropertySelectionChange(ids);
    // Default every house currently in this workspace when Invite opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- open + workspace only
  }, [linkModalOpen, inviteWorkspaceId]);

  const selectedInvitePropertyIds = () =>
    Object.entries(selectedProps)
      .filter(([, v]) => v)
      .map(([k]) => k);

  const inviteFacts = (inviteUrl?: string) => {
    const ids = selectedInvitePropertyIds();
    return {
      kind: "workspace" as const,
      inviterName: managerDisplayName,
      workspaceName: inviteWorkspace?.name ?? workspaceName,
      propertyLabels: ids.map((id) => teamPropertyLabel(id)),
      inviteUrl,
      proplaneCode: draftAxisId ?? undefined,
      phone: inviteePhone.trim() || undefined,
      email: inviteeEmail.trim() || undefined,
    };
  };

  const mintWorkspaceInviteUrl = async (): Promise<string | null> => {
    if (mintedInviteUrl) return mintedInviteUrl;
    const ids = selectedInvitePropertyIds();
    const result = await mintInviteLinkClient({
      kind: "manager",
      workspaceId: inviteWorkspaceId,
      assignedPropertyIds: ids,
      propertyPermissions: normalizePropertyCoManagerPermissions(propertyPermissionsDraft, ids),
      propertyLabelsById: Object.fromEntries(ids.map((id) => [id, teamPropertyLabel(id)])),
    });
    if (!result.ok) {
      showToast(result.error);
      return null;
    }
    setMintedInviteUrl(result.url);
    return result.url;
  };

  const openInviteCompose = (url: string | undefined, recipient: {
    name: string;
    userId: string | null;
    phone?: string;
    email?: string;
  }) => {
    const facts = inviteFacts(url);
    setLinkInvitePreview({
      subject: formatInviteMessageSubject(facts),
      body: formatInviteMessageBody(facts),
      recipientName: recipient.name,
      recipientUserId: recipient.userId,
      recipientPhone: recipient.phone,
      recipientEmail: recipient.email,
    });
    setLinkModalOpen(false);
  };

  const continueWorkspaceInvite = async () => {
    if (inviteLinkBlocked) {
      showToast("You cannot send this invite on the current plan.");
      return;
    }
    if (invitePath === "message") {
      if (!inviteeName.trim() || !inviteePhone.trim()) {
        showToast("Enter a name and phone to invite via message.");
        return;
      }
    }
    let codeId = draftAxisId;
    let codeName = draftName;
    let codeUserId = draftUserId;
    if (invitePath === "code") {
      if (!codeId || !codeUserId) {
        const looked = await lookup();
        if (!looked?.userId) return;
        codeId = looked.axisId;
        codeName = looked.name;
        codeUserId = looked.userId;
      }
    }
    setInviteContinueBusy(true);
    try {
      const alreadyMinted = Boolean(mintedInviteUrl);
      const url = await mintWorkspaceInviteUrl();
      if (!url) return;
      if (invitePath === "link" && !alreadyMinted) return;
      if (invitePath === "message") {
        openInviteCompose(url, {
          name: inviteeName.trim(),
          userId: draftUserId,
          phone: inviteePhone.trim(),
          email: inviteeEmail.trim() || undefined,
        });
        return;
      }
      if (invitePath === "code") {
        openInviteCompose(url, {
          name: codeName ?? codeId ?? "Team member",
          userId: codeUserId,
          phone: inviteePhone.trim() || undefined,
          email: inviteeEmail.trim() || undefined,
        });
        return;
      }
      openInviteCompose(url, {
        name: inviteeName.trim() || "Recipient",
        userId: draftUserId,
        phone: inviteePhone.trim() || undefined,
        email: inviteeEmail.trim() || undefined,
      });
    } finally {
      setInviteContinueBusy(false);
    }
  };

  const confirmLinkInvite = async (
    skipMessage: boolean,
    channels?: NotificationDeliveryChannels,
    messageDraft?: NotificationConfirmDraft,
  ) => {
    if (!linkInvitePreview || linkInviteBusy) return;
    const ids = selectedInvitePropertyIds();

    const payout = 15;
    const propertyCoManagerPermissions = normalizePropertyCoManagerPermissions(propertyPermissionsDraft, ids);

    setLinkInviteBusy(true);
    let pendingInviteId: string | null = null;
    try {
      if (draftAxisId && draftUserId && useRemote && remoteLoaded) {
        try {
          const res = await fetch("/api/pro/account-links", {
            method: "POST",
            credentials: "include",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              inviteeAxisId: draftAxisId,
              tabKind: "manager",
              assignedPropertyIds: ids,
              payoutPercentForManager: payout,
              propertyCoManagerPermissions,
              coManagerPermissions: inviteDefaultPermissions,
              workspaceId: inviteWorkspaceId,
              workspacePermissions: inviteWorkspacePermissions,
              skipInviteNotification: true,
            }),
          });
          const data = (await res.json()) as {
            error?: string;
            migrationRequired?: boolean;
            invite?: { id?: string };
          };
          if (!res.ok) {
            setInviteeAtCap(Boolean(data.error?.includes("Invitee needs to upgrade")));
            showToast(data.error ?? "Could not send invite.");
            return;
          }
          pendingInviteId = data.invite?.id?.trim() || null;
        } catch {
          showToast("Network error.");
          return;
        }
      } else if (draftAxisId && draftUserId) {
        const all = readProRelationships(userId);
        const dupe = all.some((r) => r.linkedAxisId === draftAxisId);
        if (dupe) {
          showToast("You already have a link with this account.");
          return;
        }
        const row: ProRelationshipRecord = {
          id: generateRelationshipId(),
          linkedAxisId: draftAxisId,
          linkedDisplayName: draftName ?? undefined,
          linkedUserId: draftUserId,
          linkDirection: "outgoing",
          perspective: "manager_tab",
          payoutPercentForManager: payout,
          assignedPropertyIds: ids,
          coManagerPermissions: flatCoManagerPermissionsFromProperty(propertyCoManagerPermissions),
          propertyCoManagerPermissions,
          createdAt: new Date().toISOString(),
        };
        writeProRelationships(userId, [...all, row]);
        refreshLocal();
      }

      if (!skipMessage) {
        const toUserIds = linkInvitePreview.recipientUserId ? [linkInvitePreview.recipientUserId] : undefined;
        const email = linkInvitePreview.recipientEmail?.trim() ?? "";
        if (toUserIds?.length || email) {
          const result = await deliverManagerDirectoryMessage(
            {
              name: linkInvitePreview.recipientName,
              email,
              subject: linkInvitePreview.subject,
              body: messageDraft?.body?.trim() || linkInvitePreview.body,
            },
            false,
            channels,
            messageDraft,
            { toUserIds, eventCategory: "account" },
          );
          if (!result.ok) {
            if (pendingInviteId) await cancelInvite(pendingInviteId);
            showToast(result.message);
            if (useRemote && remoteLoaded) {
              await loadRemoteInvites();
            }
            return;
          }
        }
      }

      if (useRemote && remoteLoaded) {
        await loadRemoteInvites();
        resetLinkDraft();
        setLinkInvitePreview(null);
        if (pendingInviteId) {
          await copyInviteAcceptLink(pendingInviteId);
        }
        showToast(
          skipMessage
            ? pendingInviteId
              ? "Invite created. Invite link copied — share it so they can accept."
              : "Invite created, but nothing was sent. Tell them to open PropLane → Teams to accept it."
            : pendingInviteId
              ? "Invite sent and invite link copied."
              : "Invite sent and team member notified.",
        );
        return;
      }

      resetLinkDraft();
      setLinkInvitePreview(null);
      refreshLocal();
      showToast(
        skipMessage
          ? "Link saved locally. Nothing was sent — tell them to open PropLane → Co-managers."
          : "Link saved and team member notified.",
      );
    } finally {
      setLinkInviteBusy(false);
      syncWorkspaceRollup();
    }
  };

  const patchInvite = async (
    id: string,
    payload: Record<string, unknown>,
    okToast?: string,
  ): Promise<boolean> => {
    try {
      const res = await fetch(`/api/pro/account-links/${encodeURIComponent(id)}`, {
        method: "PATCH",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = (await res.json()) as { error?: string; invite?: AccountLinkInviteDto };
      if (!res.ok) {
        showToast(data.error ?? "Request failed.");
        invalidateAccountLinksCache();
        await loadRemoteInvites();
        return false;
      }
      if (data.invite) {
        setInviteDrafts((prev) => ({ ...prev, [id]: inviteDraftFromRemote(data.invite!) }));
      }
      invalidateAccountLinksCache();
      await loadRemoteInvites();
      const scopeChanged =
        payload.action === "revoke" ||
        payload.action === "accept" ||
        payload.assignedPropertyIds !== undefined;
      if (scopeChanged) {
        // Dropping a property from a link (or revoking) must immediately refresh
        // portfolio-scoped residents / leases / charges for this workspace.
        await syncManagerPortfolioFromServer(userId, { force: true });
        await Promise.allSettled([
          syncManagerApplicationsFromServer({ managerUserId: userId, force: true }),
          syncLeasePipelineFromServer(userId),
          syncHouseholdChargesFromServer(),
        ]);
        refreshLocal();
      }
      if (okToast) showToast(okToast);
      return true;
    } catch {
      showToast("Network error.");
      invalidateAccountLinksCache();
      await loadRemoteInvites();
      return false;
    }
  };

  const scheduleInviteSave = useCallback(
    (inviteId: string, draft: InviteDraft, partial?: { propertyId: string; permissions: CoManagerPermissions }) => {
      setInviteDrafts((d) => ({ ...d, [inviteId]: draft }));
      if (saveTimersRef.current[inviteId]) {
        clearTimeout(saveTimersRef.current[inviteId]);
      }
      saveTimersRef.current[inviteId] = setTimeout(() => {
        delete saveTimersRef.current[inviteId];
        if (partial) {
          void patchInvite(inviteId, {
            propertyId: partial.propertyId,
            permissions: normalizeCoManagerPermissions(partial.permissions),
          });
        } else {
          void patchInvite(inviteId, {
            assignedPropertyIds: draft.assignedPropertyIds,
            propertyCoManagerPermissions: draft.propertyCoManagerPermissions,
            coManagerPermissions: draft.workspaceDefaultPermissions,
            workspacePermissions: draft.workspacePermissions,
          });
        }
      }, 300);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const getInviteDraft = (inv: AccountLinkInviteDto): InviteDraft =>
    inviteDrafts[inv.id] ?? inviteDraftFromRemote(inv);

  const addPropertyToInvite = (inv: AccountLinkInviteDto, propId: string) => {
    if (!propId.trim()) {
      showToast("Select a property to add.");
      return;
    }
    const draft = getInviteDraft(inv);
    if (draft.assignedPropertyIds.includes(propId)) {
      showToast("That property is already assigned.");
      return;
    }
    const nextAssigned = [...draft.assignedPropertyIds, propId];
    applyAssignedPropertyChange(inv.id, nextAssigned, draft, useRemote && remoteLoaded);
    showToast("Property added.");
  };

  const applyAssignedPropertyChange = (
    linkId: string,
    nextAssigned: string[],
    draft: InviteDraft,
    remote: boolean,
  ) => {
    const nextPerms = normalizePropertyCoManagerPermissions(
      {
        ...draft.propertyCoManagerPermissions,
        ...Object.fromEntries(
          nextAssigned
            .filter((id) => !draft.assignedPropertyIds.includes(id))
            .map((id) => [id, draft.workspaceDefaultPermissions]),
        ),
      },
      nextAssigned,
    );
    if (remote) {
      const inv = activeRemote.find((row) => row.id === linkId);
      if (inv) {
        scheduleInviteSave(inv.id, {
          ...draft,
          assignedPropertyIds: nextAssigned,
          propertyCoManagerPermissions: nextPerms,
        });
      }
      return;
    }
    const all = readProRelationships(userId);
    const next = all.map((r) => {
      if (r.id !== linkId) return r;
      return { ...r, assignedPropertyIds: nextAssigned, propertyCoManagerPermissions: nextPerms };
    });
    writeProRelationships(userId, next);
    refreshLocal();
  };

  const addPropertyToLocalRow = (rowId: string, propId: string) => {
    if (!propId.trim()) {
      showToast("Select a property to add.");
      return;
    }
    const all = readProRelationships(userId);
    const row = all.find((r) => r.id === rowId);
    if (!row) return;
    if (row.assignedPropertyIds.includes(propId)) {
      showToast("That property is already assigned.");
      return;
    }
    const nextAssigned = [...row.assignedPropertyIds, propId];
    applyAssignedPropertyChange(rowId, nextAssigned, inviteDraftFromRelationship(row), false);
    showToast("Property added.");
  };

  const updatePropertyPermissions = (inv: AccountLinkInviteDto, propertyId: string, permissions: CoManagerPermissions) => {
    const draft = getInviteDraft(inv);
    const normalized = normalizeCoManagerPermissions(permissions);
    const next: InviteDraft = {
      assignedPropertyIds: draft.assignedPropertyIds,
      propertyCoManagerPermissions: {
        ...draft.propertyCoManagerPermissions,
        [propertyId]: normalized,
      },
      workspaceDefaultPermissions: draft.workspaceDefaultPermissions,
      workspacePermissions: draft.workspacePermissions,
    };
    if (useRemote && remoteLoaded) {
      scheduleInviteSave(inv.id, next, { propertyId, permissions: normalized });
      return;
    }
    const all = readProRelationships(userId);
    const updated = all.map((r) =>
      r.id === inv.id
        ? {
            ...r,
            propertyCoManagerPermissions: next.propertyCoManagerPermissions,
            coManagerPermissions: normalized,
          }
        : r,
    );
    writeProRelationships(userId, updated);
    refreshLocal();
  };

  const removePropertyFromLink = async (inv: AccountLinkInviteDto, propId: string) => {
    const draft = getInviteDraft(inv);
    const assignedId = resolveAssignedPropertyId(propId, draft.assignedPropertyIds);
    if (!assignedId) return;
    if (draft.assignedPropertyIds.length === 1) {
      await removeLink(inv.id);
      return;
    }
    const nextAssigned = draft.assignedPropertyIds.filter((id) => id !== assignedId);
    const nextPerms = normalizePropertyCoManagerPermissions(draft.propertyCoManagerPermissions, nextAssigned);
    if (useRemote && remoteLoaded) {
      // Optimistically shrink local invite + relationship scope so Residents
      // drops the unlinked property before the PATCH round-trip finishes.
      setRemoteInvites((prev) =>
        prev.map((row) =>
          row.id === inv.id
            ? { ...row, assignedPropertyIds: nextAssigned, propertyCoManagerPermissions: nextPerms }
            : row,
        ),
      );
      setInviteDrafts((d) => ({
        ...d,
        [inv.id]: { ...getInviteDraft(inv), assignedPropertyIds: nextAssigned, propertyCoManagerPermissions: nextPerms },
      }));
      const nextInvites = remoteInvites.map((row) =>
        row.id === inv.id
          ? { ...row, assignedPropertyIds: nextAssigned, propertyCoManagerPermissions: nextPerms }
          : row,
      );
      seedAccountLinksCache(nextInvites);
      writeProRelationships(userId, proRelationshipRowsFromInvites(nextInvites.filter((i) => i.status === "accepted")));
      scheduleInviteSave(inv.id, { ...getInviteDraft(inv), assignedPropertyIds: nextAssigned, propertyCoManagerPermissions: nextPerms });
      showToast("Property removed from this team member.");
      return;
    }
    const all = readProRelationships(userId);
    const next = all.map((r) => {
      if (r.id !== inv.id) return r;
      return { ...r, assignedPropertyIds: nextAssigned, propertyCoManagerPermissions: nextPerms };
    });
    writeProRelationships(userId, next);
    refreshLocal();
    showToast("Property removed from this team member.");
  };

  const removePropertyFromLocalRow = (rowId: string, propId: string) => {
    const all = readProRelationships(userId);
    const row = all.find((r) => r.id === rowId);
    const assignedId = row ? resolveAssignedPropertyId(propId, row.assignedPropertyIds) : null;
    if (!row || !assignedId) return;
    if (row.assignedPropertyIds.length === 1) {
      void removeLink(rowId);
      return;
    }
    const nextAssigned = row.assignedPropertyIds.filter((id) => id !== assignedId);
    const nextPerms = normalizePropertyCoManagerPermissions(row.propertyCoManagerPermissions, nextAssigned);
    writeProRelationships(
      userId,
      all.map((r) =>
        r.id === rowId ? { ...r, assignedPropertyIds: nextAssigned, propertyCoManagerPermissions: nextPerms } : r,
      ),
    );
    refreshLocal();
    showToast("Property removed from this team member.");
  };

  const openTransferForProperty = (propertyId: string, coManagerUserId: string) => {
    setTransferPropertyId(propertyId);
    setTransferCoManagerUserId(coManagerUserId);
    setTransferPermissions(EMPTY_CO_MANAGER_PERMISSIONS);
  };

  const openTransferForCoManager = async (
    propertyId: string,
    axisId: string,
    knownUserId?: string,
  ) => {
    let coManagerUserId = knownUserId?.trim();
    if (!coManagerUserId) {
      try {
        const res = await fetch(`/api/pro/lookup-axis-id?axisId=${encodeURIComponent(axisId)}`, {
          credentials: "include",
        });
        const body = (await res.json()) as { ok?: boolean; userId?: string; error?: string };
        if (!res.ok || !body.ok || !body.userId) {
          showToast(body.error ?? "Could not resolve team account.");
          return;
        }
        coManagerUserId = body.userId;
      } catch {
        showToast("Network error.");
        return;
      }
    }
    openTransferForProperty(propertyId, coManagerUserId);
  };

  const removeLink = async (id: string) => {
    if (useRemote && remoteLoaded) {
      const ok = await patchInvite(id, { action: "revoke" }, "Disconnected.");
      writeProRelationships(userId, readProRelationships(userId).filter((row) => row.id !== id));
      setInviteDrafts((d) => {
        const next = { ...d };
        delete next[id];
        return next;
      });
      await loadRemoteInvites();
      refreshLocal();
      if (ok && routeLinkId === id) navigateToList();
      return;
    }
    const all = readProRelationships(userId).filter((r) => r.id !== id);
    writeProRelationships(userId, all);
    refreshLocal();
    showToast("Disconnected.");
    if (routeLinkId === id) navigateToList();
  };

  // The plan card's team meter and each workspace's roll-up come from the
  // workspaces payload, so a team change re-reads it once the link is saved.
  const syncWorkspaceRollup = () => {
    void workspaces?.refresh().catch(() => undefined);
  };

  const respondInvite = async (id: string, action: "accept" | "reject") => {
    const ok = await patchInvite(
      id,
      { action },
      action === "accept" ? "Invite accepted. Link is active." : "Invite declined.",
    );
    if (ok) syncWorkspaceRollup();
    if (ok && routeLinkId === id) navigateToList();
  };

  const cancelInvite = async (id: string) => {
    const ok = await patchInvite(id, { action: "cancel" }, "Invite withdrawn.");
    if (ok && routeLinkId === id) navigateToList();
  };

  const outgoingCoManagerLinks = useMemo(
    () =>
      listOutgoingCoManagerLinks({
        useRemote,
        remoteInvites,
        localRows,
        inviteDrafts,
      }),
    [useRemote, remoteInvites, localRows, inviteDrafts],
  );

  const coManagersForProperty = useCallback(
    (propertyId: string) => listOutgoingCoManagersForProperty(propertyId, outgoingCoManagerLinks),
    [outgoingCoManagerLinks],
  );

  const removeCoManagerFromProperty = async (link: CoManagerPropertyLink, propertyId: string) => {
    if (useRemote && remoteLoaded) {
      const inv = activeRemote.find((row) => row.id === link.id);
      if (!inv) return;
      await removePropertyFromLink(inv, propertyId);
      return;
    }
    removePropertyFromLocalRow(link.id, propertyId);
  };

  const openPropertyPermissionsModal = (
    propertyId: string,
    perms: CoManagerPermissions,
    onSave: (next: CoManagerPermissions) => void,
  ) => {
    setPropertyPermissionsModal({
      propertyId,
      propertyLabel: teamPropertyLabel(propertyId),
      draft: normalizeCoManagerPermissions(perms),
      onSave,
    });
  };

  const renderCoManagerPropertyActions = (
    propertyId: string,
    link: CoManagerPropertyLink,
    readOnly: boolean,
    perms: CoManagerPermissions,
    onPermissionsChange: (next: CoManagerPermissions) => void,
  ) => {
    if (readOnly) return null;
    return (
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          variant="outline"
          className="h-8 rounded-full px-4 text-xs"
          onClick={() => openTransferForCoManager(propertyId, link.linkedAxisId, link.linkedUserId)}
          data-attr="co-manager-make-owner"
        >
          Make owner
        </Button>
        <Button
          type="button"
          variant="outline"
          className="h-8 rounded-full px-4 text-xs"
          onClick={() => openPropertyPermissionsModal(propertyId, perms, onPermissionsChange)}
          data-attr="co-manager-edit-permissions"
        >
          Edit permissions
        </Button>
        <Button
          type="button"
          variant="outline"
          className={`${PORTAL_DETAIL_BTN} border-rose-200 text-rose-800 hover:bg-[var(--status-overdue-bg)] portal-danger-outline h-8 rounded-full px-4 text-xs`}
          onClick={() => removeCoManagerFromProperty(link, propertyId)}
          data-attr="co-manager-remove-property-access"
        >
          Remove access
        </Button>
      </div>
    );
  };

  const bulkRemoveDetailProperties = async () => {
    if (!routeEntry || selectedDetailPropertyIds.size === 0) return;
    const removeSet = new Set(
      [...selectedDetailPropertyIds]
        .map((pid) => {
          if (routeEntry.kind === "remote") {
            return resolveAssignedPropertyId(pid, getInviteDraft(routeEntry.invite).assignedPropertyIds);
          }
          return resolveAssignedPropertyId(pid, routeEntry.row.assignedPropertyIds);
        })
        .filter((id): id is string => Boolean(id)),
    );
    if (removeSet.size === 0) {
      clearDetailPropertySelection();
      return;
    }

    if (routeEntry.kind === "remote") {
      const inv = routeEntry.invite;
      const draft = getInviteDraft(inv);
      const nextAssigned = draft.assignedPropertyIds.filter((id) => !removeSet.has(id));
      if (nextAssigned.length === 0) {
        await removeLink(inv.id);
        clearDetailPropertySelection();
        return;
      }
      const nextPerms = normalizePropertyCoManagerPermissions(draft.propertyCoManagerPermissions, nextAssigned);
      if (useRemote && remoteLoaded) {
        setRemoteInvites((prev) =>
          prev.map((row) =>
            row.id === inv.id
              ? { ...row, assignedPropertyIds: nextAssigned, propertyCoManagerPermissions: nextPerms }
              : row,
          ),
        );
        setInviteDrafts((d) => ({
          ...d,
          [inv.id]: { ...getInviteDraft(inv), assignedPropertyIds: nextAssigned, propertyCoManagerPermissions: nextPerms },
        }));
        const nextInvites = remoteInvites.map((row) =>
          row.id === inv.id
            ? { ...row, assignedPropertyIds: nextAssigned, propertyCoManagerPermissions: nextPerms }
            : row,
        );
        seedAccountLinksCache(nextInvites);
        writeProRelationships(userId, proRelationshipRowsFromInvites(nextInvites.filter((i) => i.status === "accepted")));
        scheduleInviteSave(inv.id, { ...getInviteDraft(inv), assignedPropertyIds: nextAssigned, propertyCoManagerPermissions: nextPerms });
        showToast(
          removeSet.size === 1 ? "Property removed from this team member." : `${removeSet.size} properties removed.`,
        );
      } else {
        const all = readProRelationships(userId);
        const next = all.map((r) =>
          r.id === inv.id
            ? { ...r, assignedPropertyIds: nextAssigned, propertyCoManagerPermissions: nextPerms }
            : r,
        );
        writeProRelationships(userId, next);
        refreshLocal();
        showToast(
          removeSet.size === 1 ? "Property removed from this team member." : `${removeSet.size} properties removed.`,
        );
      }
    } else {
      const row = routeEntry.row;
      const nextAssigned = row.assignedPropertyIds.filter((id) => !removeSet.has(id));
      const all = readProRelationships(userId);
      if (nextAssigned.length === 0) {
        await removeLink(row.id);
        clearDetailPropertySelection();
        return;
      }
      const nextPerms = normalizePropertyCoManagerPermissions(row.propertyCoManagerPermissions ?? {}, nextAssigned);
      writeProRelationships(
        userId,
        all.map((rel) =>
          rel.id === row.id
            ? { ...rel, assignedPropertyIds: nextAssigned, propertyCoManagerPermissions: nextPerms }
            : rel,
        ),
      );
      refreshLocal();
      showToast(
        removeSet.size === 1 ? "Property removed from this team member." : `${removeSet.size} properties removed.`,
      );
    }
    clearDetailPropertySelection();
  };

  const renderTeamPropertyAccessCard = (
    propertyId: string,
    perms: CoManagerPermissions,
    link: CoManagerPropertyLink,
    readOnly: boolean,
    onChange: (next: CoManagerPermissions) => void,
  ) => {
    const label = teamPropertyLabel(propertyId);
    const showSelection = detailPropertiesEditable && !readOnly;
    return (
      <div
        key={propertyId}
        className="rounded-2xl border border-border bg-card"
        data-attr="team-property-access-row"
      >
        <div className="flex flex-col gap-3 px-3 py-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="flex min-w-0 flex-1 items-start gap-3">
            {showSelection ? (
              <RowSelectCheckbox
                checked={selectedDetailPropertyIds.has(propertyId)}
                onChange={() => toggleDetailProperty(propertyId)}
                className="mt-0.5 h-4 w-4 shrink-0 rounded border-border text-primary"
                aria-label={`Select ${label}`}
                data-attr="team-property-select"
              />
            ) : null}
            <div className="min-w-0">
              <p className="text-sm font-semibold text-foreground">{label}</p>
              <p className="mt-0.5 text-xs text-muted">{describeCoManagerPermissions(perms)}</p>
            </div>
          </div>
          {!readOnly
            ? renderCoManagerPropertyActions(propertyId, link, readOnly, perms, onChange)
            : null}
        </div>
      </div>
    );
  };

  const renderPropertyPermissionsSection = (
    propertyId: string,
    draft: InviteDraft,
    inv: AccountLinkInviteDto,
    readOnly: boolean,
  ) => {
    const perms = permissionsForProperty(draft.propertyCoManagerPermissions, propertyId);
    return renderTeamPropertyAccessCard(
      propertyId,
      perms,
      {
        id: inv.id,
        linkedAxisId: inv.linkedAxisId,
        linkedDisplayName: inv.linkedDisplayName,
        linkedUserId: inv.linkedUserId,
        assignedPropertyIds: draft.assignedPropertyIds,
        propertyCoManagerPermissions: draft.propertyCoManagerPermissions,
      },
      readOnly,
      readOnly ? () => {} : (next) => updatePropertyPermissions(inv, propertyId, next),
    );
  };

  const renderLocalPropertyPermissionsSection = (propertyId: string, row: ProRelationshipRecord) => {
    const perms = normalizeCoManagerPermissions(
      row.propertyCoManagerPermissions?.[propertyId] ?? row.coManagerPermissions,
    );
    return renderTeamPropertyAccessCard(
      propertyId,
      perms,
      {
        id: row.id,
        linkedAxisId: row.linkedAxisId,
        linkedDisplayName: row.linkedDisplayName,
        linkedUserId: row.linkedUserId,
        assignedPropertyIds: row.assignedPropertyIds,
        propertyCoManagerPermissions: row.propertyCoManagerPermissions ?? {},
      },
      false,
      (next) => {
        const all = readProRelationships(userId);
        const updated = all.map((rel) =>
          rel.id === row.id
            ? {
                ...rel,
                propertyCoManagerPermissions: {
                  ...(rel.propertyCoManagerPermissions ?? {}),
                  [propertyId]: next,
                },
              }
            : rel,
        );
        writeProRelationships(userId, updated);
        refreshLocal();
      },
    );
  };

  const submitTransfer = async () => {
    if (!transferPropertyId || !transferCoManagerUserId) return;
    setTransferBusy(true);
    try {
      const res = await fetch(
        `/api/pro/properties/${encodeURIComponent(transferPropertyId)}/transfer-ownership`,
        {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            newManagerUserId: transferCoManagerUserId,
            formerOwnerPermissions: transferPermissions,
          }),
        },
      );
      const data = (await res.json()) as { error?: string; propertyLabel?: string };
      if (!res.ok) {
        showToast(data.error ?? "Transfer failed.");
        return;
      }
      showToast(`${data.propertyLabel ?? "Property"} ownership transferred.`);
      setTransferPropertyId(null);
      setTransferCoManagerUserId(null);
      setTransferPermissions(EMPTY_CO_MANAGER_PERMISSIONS);
      await loadRemoteInvites();
      await syncManagerPortfolioFromServer(userId, { force: true });
      refreshLocal();
    } catch {
      showToast("Network error.");
    } finally {
      setTransferBusy(false);
    }
  };

  useEffect(() => {
    if (!useRemote || activeRemote.length === 0) {
      if (useRemote && remoteLoaded) {
        writeProRelationships(userId, []);
      }
      return;
    }
    writeProRelationships(userId, proRelationshipRowsFromInvites(activeRemote));
  }, [activeRemote, remoteLoaded, useRemote, userId]);

  const activeCards = useRemote ? activeRemote : localRows;
  const hasCoManagerLinks =
    activeCards.length > 0 ||
    (useRemote && (incomingPending.length > 0 || outgoingPending.length > 0));
  const hasVisibleTeamRows =
    visibleIncomingPending.length > 0 ||
    visibleOutgoingPending.length > 0 ||
    visibleActiveRemote.length > 0 ||
    visibleLocalRows.length > 0;
  const selectedPropIds = Object.entries(selectedProps)
    .filter(([, v]) => v)
    .map(([k]) => k);

  const buildTeamRemovePreviewItem = useCallback(
    (entry: TeamListEntry): TeamRemovePreviewItem => {
      const propertyLabels =
        entry.kind === "remote"
          ? entry.invite.assignedPropertyIds.map((id) => teamPropertyLabel(id))
          : entry.row.assignedPropertyIds.map((id) => teamPropertyLabel(id));
      const linkedUserId =
        entry.kind === "remote" ? entry.invite.linkedUserId : entry.row.linkedUserId?.trim() ?? "";
      let subject: string;
      let body: string;
      if (entry.kind === "remote") {
        const inv = entry.invite;
        const isOutgoingPending = inv.status === "pending" && inv.direction === "outgoing";
        const isIncomingPending = inv.status === "pending" && inv.direction === "incoming";
        const isIncomingAccepted = inv.status === "accepted" && inv.direction === "incoming";
        if (isOutgoingPending) {
          subject = coManagerInviteWithdrawnSubject(managerDisplayName);
          body = buildCoManagerInviteWithdrawnBody({ actorName: managerDisplayName });
        } else if (isIncomingPending) {
          subject = coManagerInviteDeclinedSubject(managerDisplayName);
          body = buildCoManagerInviteDeclinedBody({ inviteeName: managerDisplayName });
        } else if (isIncomingAccepted) {
          subject = coManagerLinkLeftSubject(managerDisplayName);
          body = buildCoManagerLinkLeftBody({ inviteeName: managerDisplayName, propertyLabels });
        } else {
          subject = coManagerLinkRemovedSubject(managerDisplayName);
          body = buildCoManagerLinkRemovedBody({ actorName: managerDisplayName, propertyLabels });
        }
      } else {
        subject = coManagerLinkRemovedSubject(managerDisplayName);
        body = buildCoManagerLinkRemovedBody({ actorName: managerDisplayName, propertyLabels });
      }
      return {
        id: entry.id,
        label: entry.name,
        recipient: entry.name,
        subject,
        body,
        emailAvailable: Boolean(linkedUserId),
        smsAvailable: false,
        entry,
      };
    },
    [managerDisplayName, teamPropertyLabel],
  );

  const executeTeamRemoveEntry = async (entry: TeamListEntry) => {
    if (entry.kind === "remote") {
      const inv = entry.invite;
      if (inv.status === "pending" && inv.direction === "incoming") {
        await respondInvite(inv.id, "reject");
      } else if (inv.status === "pending" && inv.direction === "outgoing") {
        await cancelInvite(inv.id);
      } else {
        await removeLink(inv.id);
      }
    } else {
      await removeLink(entry.row.id);
    }
  };

  const openTeamRemovePreview = (entries: TeamListEntry[]) => {
    if (entries.length === 0) return;
    setTeamRemovePreview(entries.map(buildTeamRemovePreviewItem));
  };

  const confirmTeamRemove = async (
    skipMessage: boolean,
    channels?: NotificationDeliveryChannels,
    messageDraft?: NotificationConfirmDraft,
    opts?: {
      scope?: "all" | "single";
      singleId?: string;
      drafts?: Record<string, { subject: string; body: string }>;
    },
  ) => {
    if (!teamRemovePreview || teamRemoveBusy) return;
    const scope = opts?.scope ?? "all";
    const targetItems =
      scope === "single" && opts?.singleId
        ? teamRemovePreview.filter((item) => item.id === opts.singleId)
        : teamRemovePreview;
    if (targetItems.length === 0) return;

    setTeamRemoveBusy(true);
    try {
      const processedIds = new Set<string>();
      let notifiedCount = 0;
      for (const item of targetItems) {
        const linkedUserId =
          item.entry.kind === "remote"
            ? item.entry.invite.linkedUserId
            : item.entry.row.linkedUserId?.trim() ?? "";
        const fromCarousel = opts?.drafts?.[item.id];
        const rowDraft = fromCarousel
          ? { subject: fromCarousel.subject, body: fromCarousel.body }
          : messageDraft;
        if (!skipMessage && linkedUserId) {
          const preview = {
            name: item.label,
            email: "",
            subject: rowDraft?.subject?.trim() || item.subject,
            body: rowDraft?.body?.trim() || item.body,
          };
          const result = await deliverManagerDirectoryMessage(preview, false, channels, rowDraft, {
            toUserIds: [linkedUserId],
          });
          if (!result.ok) {
            showToast(result.message);
            const remaining = teamRemovePreview.filter((entry) => !processedIds.has(entry.id));
            if (remaining.length > 0) setTeamRemovePreview(remaining);
            return;
          }
          notifiedCount += 1;
        }
        await executeTeamRemoveEntry(item.entry);
        processedIds.add(item.id);
      }
      setTeamRemovePreview(null);
      if (scope === "all") {
        clearSelection();
        clearDetailPropertySelection();
      } else if (opts?.singleId) {
        toggleSelected(opts.singleId);
      }
      const count = processedIds.size;
      showToast(
        skipMessage
          ? count === 1
            ? "Team member disconnected."
            : `${count} team members disconnected.`
          : notifiedCount === 0
            ? count === 1
              ? "Team member disconnected."
              : `${count} team members disconnected.`
            : notifiedCount === count
              ? count === 1
                ? "Team member disconnected and notified."
                : `${count} team members disconnected and notified.`
              : `${count} team members disconnected; ${notifiedCount} notified.`,
      );
    } finally {
      setTeamRemoveBusy(false);
      syncWorkspaceRollup();
    }
  };

  const bulkRemoveSelected = () => {
    const selected = teamEntries.filter((entry) => selectedIds.has(entry.id));
    openTeamRemovePreview(selected);
  };

  const teamDangerBtnClass = `${PORTAL_DETAIL_BTN} border-rose-200 text-rose-800 hover:bg-[var(--status-overdue-bg)] portal-danger-outline`;

  const renderDetailHeaderActions = (entry: TeamListEntry) => {
    if (entry.kind === "remote") {
      const inv = entry.invite;
      if (inv.status === "pending" && inv.direction === "incoming") {
        return (
          <PortalTableDetailActions>
            <Button
              type="button"
              variant="primary"
              className={PORTAL_DETAIL_BTN}
              onClick={() => void respondInvite(inv.id, "accept")}
              data-attr="co-manager-accept-invite"
            >
              Accept
            </Button>
            <Button
              type="button"
              variant="outline"
              className={PORTAL_DETAIL_BTN}
              onClick={() => void respondInvite(inv.id, "reject")}
              data-attr="co-manager-decline-invite"
            >
              Decline
            </Button>
          </PortalTableDetailActions>
        );
      }
      if (inv.status === "pending" && inv.direction === "outgoing") {
        return (
          <PortalTableDetailActions>
            <Button
              type="button"
              variant="outline"
              className={PORTAL_DETAIL_BTN}
              onClick={() => void cancelInvite(inv.id)}
              data-attr="co-manager-withdraw-invite"
            >
              Withdraw invite
            </Button>
          </PortalTableDetailActions>
        );
      }
      return null;
    }
    return null;
  };

  const renderDetailFooter = (entry: TeamListEntry) => {
    if (entry.kind === "remote") {
      const inv = entry.invite;
      // Pending links carry their own accept / decline / cancel affordances in
      // the header. Every other state needs this one — gating on "accepted"
      // alone left a declined or cancelled link's detail page with no action at
      // all, so a dead record could not be cleared.
      if (inv.status === "pending") return null;
      const readOnly = inv.status === "accepted" && inv.direction === "incoming";
      return (
        <Button
          type="button"
          variant="outline"
          className={`${teamDangerBtnClass} w-full sm:w-auto`}
          onClick={() => openTeamRemovePreview([entry])}
          data-attr="co-manager-remove-link"
        >
          {readOnly ? "Leave team" : "Disconnect"}
        </Button>
      );
    }
    return (
      <Button
        type="button"
        variant="outline"
        className={`${teamDangerBtnClass} w-full sm:w-auto`}
        onClick={() => openTeamRemovePreview([entry])}
        data-attr="co-manager-remove-link"
      >
        Disconnect
      </Button>
    );
  };

  const openPermissionsForSelectedDetailProperty = () => {
    if (!routeEntry || selectedDetailPropertyIds.size !== 1) return;
    const propertyId = [...selectedDetailPropertyIds][0]!;
    if (routeEntry.kind === "remote") {
      const inv = routeEntry.invite;
      const draft = getInviteDraft(inv);
      const perms = permissionsForProperty(draft.propertyCoManagerPermissions, propertyId);
      openPropertyPermissionsModal(propertyId, perms, (next) =>
        updatePropertyPermissions(inv, propertyId, next),
      );
      return;
    }
    const row = routeEntry.row;
    const perms = normalizeCoManagerPermissions(
      row.propertyCoManagerPermissions?.[propertyId] ?? row.coManagerPermissions,
    );
    openPropertyPermissionsModal(propertyId, perms, (next) => {
      const all = readProRelationships(userId);
      const updated = all.map((rel) =>
        rel.id === row.id
          ? {
              ...rel,
              propertyCoManagerPermissions: {
                ...(rel.propertyCoManagerPermissions ?? {}),
                [propertyId]: next,
              },
            }
          : rel,
      );
      writeProRelationships(userId, updated);
      refreshLocal();
    });
  };

  const openMakeOwnerForSelectedDetailProperty = () => {
    if (!routeEntry || selectedDetailPropertyIds.size !== 1) return;
    const propertyId = [...selectedDetailPropertyIds][0]!;
    if (routeEntry.kind === "remote") {
      const inv = routeEntry.invite;
      openTransferForCoManager(propertyId, inv.linkedAxisId, inv.linkedUserId);
      return;
    }
    const row = routeEntry.row;
    openTransferForCoManager(propertyId, row.linkedAxisId, row.linkedUserId ?? "");
  };

  const renderInviteDetail = (inv: AccountLinkInviteDto, entry: TeamListEntry) => {
    const draft = getInviteDraft(inv);
    const readOnly = inv.direction === "incoming";
    return (
      <div className="space-y-4" data-attr="team-member-property-access">
        <TeamMemberContactCard entry={entry} />
        {inv.status === "pending" && inv.direction === "outgoing"
          ? renderInviteAcceptLinkCard(inv)
          : null}
        {!readOnly ? (
          <AddPropertyToCoManager
            linkId={inv.id}
            assignedPropertyIds={draft.assignedPropertyIds}
            propertyOptions={propertyOptions}
            onAddProperty={(id, propertyId) => void addPropertyToInvite(inv, propertyId)}
          />
        ) : (
          <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted">
            Properties they granted you
          </p>
        )}

        <CheckboxMultiSelect
          label="Houses"
          labelClassName="text-xs font-semibold text-foreground"
          options={propertyOptions.map((option) => ({ value: option.id, label: option.label }))}
          selected={draft.assignedPropertyIds}
          onChange={(ids) => {
            if (readOnly) return;
            applyAssignedPropertyChange(inv.id, ids, draft, true);
          }}
          emptyLabel="Select houses…"
          searchPlaceholder="Search houses…"
          dataAttr="team-member-houses"
        />
        <CoManagerPermissionsEditor
          value={draft.workspaceDefaultPermissions}
          disabled={readOnly}
          onChange={(next) => {
            const nextPerms = normalizePropertyCoManagerPermissions(
              Object.fromEntries(draft.assignedPropertyIds.map((id) => [id, next])),
              draft.assignedPropertyIds,
            );
            const nextDraft: InviteDraft = {
              ...draft,
              workspaceDefaultPermissions: next,
              propertyCoManagerPermissions: nextPerms,
            };
            scheduleInviteSave(inv.id, nextDraft);
          }}
        />
        <WorkspaceGrantFields
          value={draft.workspacePermissions}
          disabled={readOnly}
          onChange={(next) => {
            scheduleInviteSave(inv.id, { ...draft, workspacePermissions: next });
          }}
        />
      </div>
    );
  };

  const renderLocalRowDetail = (r: ProRelationshipRecord, entry: TeamListEntry) => (
    <div className="space-y-4" data-attr="team-member-property-access">
      <TeamMemberContactCard entry={entry} />
      <AddPropertyToCoManager
        linkId={r.id}
        assignedPropertyIds={r.assignedPropertyIds}
        propertyOptions={propertyOptions}
        onAddProperty={(id, propertyId) => addPropertyToLocalRow(id, propertyId)}
      />

      {r.assignedPropertyIds.length === 0 ? (
        <p className="text-sm text-muted">No properties in this link yet.</p>
      ) : (
        <div className="space-y-3">
          {r.assignedPropertyIds.map((pid) => renderLocalPropertyPermissionsSection(pid, r))}
        </div>
      )}
    </div>
  );

  const renderDetailBody = (entry: TeamListEntry) => {
    if (entry.kind === "remote") return renderInviteDetail(entry.invite, entry);
    return renderLocalRowDetail(entry.row, entry);
  };

  const teamFilterSheet = (
    <PortalFilterSortSheet
      activeCount={portalFilterActiveCount([teamPropertyFilters])}
      compactPanel
      commandStripTrigger
      filterFieldCount={1}
      constrainDropdownToTitleBand
      mobileFlushBody
      className={PORTAL_PROPERTY_FILTER_SHEET_CLASS}
      onReset={() => setTeamPropertyFilters([])}
      dataAttr="team-links-filter-sheet-open"
    >
      <ApplicationFilterSortFields
        propertyOptions={teamFilterPropertyOptions}
        propertyFilters={teamPropertyFilters}
        onPropertyFiltersChange={setTeamPropertyFilters}
        dataAttr="team-filter-property"
      />
    </PortalFilterSortSheet>
  );

  const teamActiveFilterChips = teamPropertyFilters.length > 0 ? (
    <div className="mb-3">
      <PortalActiveFilterChips
        chips={[
          {
            id: "property",
            label: teamPropertyFilters.length === 1 ? `Property: ${teamPropertyFilters[0]}` : `${teamPropertyFilters.length} properties`,
            onRemove: () => setTeamPropertyFilters([]),
          },
        ]}
      />
    </div>
  ) : null;

  const teamModals = (
    <>
        <Modal
          open={linkModalOpen}
          title={`Invite to ${inviteWorkspace?.name ?? workspaceName}`}
          assistantContext="Invite to workspace"
          assistantStorageScopeKey="Invite to workspace"
          onClose={closeLinkModal}
          panelClassName="max-w-2xl"
          footer={
            <div className="flex w-full items-center justify-end gap-2">
              <Button
                type="button"
                variant="primary"
                className="rounded-full"
                loading={inviteContinueBusy || lookupBusy}
                disabled={inviteContinueBusy || lookupBusy || inviteLinkBlocked}
                onClick={() => void continueWorkspaceInvite()}
                data-attr="co-manager-link-continue"
              >
                Continue
              </Button>
            </div>
          }
        >
          <div className="space-y-5">
            <PortalInvitePaths value={invitePath} onChange={setInvitePath} disabled={inviteContinueBusy} />

            {invitePath === "message" ? (
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <label className="block">
                  <span className="text-xs font-semibold text-muted">Name</span>
                  <Input
                    className="mt-1"
                    value={inviteeName}
                    onChange={(e) => setInviteeName(e.target.value)}
                    autoFocus
                    data-attr="workspace-invite-name"
                  />
                </label>
                <div>
                  <span className="text-xs font-semibold text-muted">Phone</span>
                  <div className="mt-1">
                    <PhoneNumberField
                      id="workspace-invite-phone"
                      value={inviteePhone}
                      onChange={setInviteePhone}
                      dataAttr="workspace-invite-phone"
                    />
                  </div>
                </div>
                <label className="block sm:col-span-2">
                  <span className="text-xs font-semibold text-muted">Email</span>
                  <Input
                    type="email"
                    className="mt-1"
                    value={inviteeEmail}
                    onChange={(e) => setInviteeEmail(e.target.value)}
                    data-attr="workspace-invite-email"
                  />
                </label>
              </div>
            ) : null}

            {invitePath === "code" ? (
              <div className="space-y-3">
                {draftAxisId ? (
                  <div className="rounded-xl border border-primary/25 bg-primary/[0.05] px-4 py-3">
                    <p className="text-sm font-semibold text-foreground">{draftName}</p>
                    <p className="mt-0.5 font-mono text-xs text-muted">
                      {formatProplaneIdForDisplay(draftAxisId)}
                    </p>
                  </div>
                ) : (
                  <form
                    onSubmit={(e) => {
                      e.preventDefault();
                      void lookup();
                    }}
                  >
                    <label className="block">
                      <span className="text-xs font-semibold text-muted">{AXIS_ID_LABEL}</span>
                      <Input
                        type="text"
                        value={axisInput}
                        onChange={(e) => setAxisInput(e.target.value)}
                        placeholder="e.g. PROPLANE-1A2B3C4D"
                        autoFocus
                        className="mt-1 font-mono"
                        data-attr="co-manager-proplane-id-input"
                      />
                    </label>
                  </form>
                )}
              </div>
            ) : null}

            {invitePath === "link" && mintedInviteUrl ? (
              <div className="flex items-center gap-2">
                <Input readOnly value={mintedInviteUrl} className="font-mono text-xs" data-attr="workspace-invite-url" />
                <Button
                  type="button"
                  variant="outline"
                  className="shrink-0"
                  data-attr="workspace-invite-copy"
                  onClick={() => {
                    void navigator.clipboard.writeText(mintedInviteUrl).then(
                      () => showToast("Invite link copied."),
                      () => showToast("Could not copy. Select the link and copy it manually."),
                    );
                  }}
                >
                  <Copy className="h-4 w-4" />
                  <span className="ml-1.5">Copy</span>
                </Button>
              </div>
            ) : null}

            {inviteeAtCap ? (
              <p className="rounded-xl portal-banner-danger px-4 py-3 text-xs font-medium text-[var(--status-overdue-fg)]">
                That account is already at its link limit and cannot accept new links.
              </p>
            ) : null}

            {linkInvitePropertySelectOptions.length === 0 ? (
              <p className="text-sm text-muted">No houses in this workspace yet.</p>
            ) : (
              <CheckboxMultiSelect
                label="Properties"
                labelClassName="text-xs font-semibold text-muted"
                options={linkInvitePropertySelectOptions}
                selected={selectedPropIds}
                onChange={handleLinkPropertySelectionChange}
                emptyLabel="Select properties…"
                searchPlaceholder="Search properties…"
                dataAttr="co-manager-invite-properties"
              />
            )}

            <CoManagerPermissionsEditor
              value={inviteDefaultPermissions}
              onChange={(next) => {
                setInviteDefaultPermissions(next);
                const ids = selectedInvitePropertyIds();
                setPropertyPermissionsDraft(Object.fromEntries(ids.map((id) => [id, next])));
              }}
            />
            <WorkspaceGrantFields value={inviteWorkspacePermissions} onChange={setInviteWorkspacePermissions} />
          </div>
        </Modal>

        <Modal
          open={propertyPermissionsModal !== null}
          title={
            propertyPermissionsModal
              ? `Edit permissions · ${propertyPermissionsModal.propertyLabel}`
              : "Edit permissions"
          }
          onClose={() => setPropertyPermissionsModal(null)}
        >
          {propertyPermissionsModal ? (
            <div className="space-y-4">
              <CoManagerPermissionsEditor
                value={propertyPermissionsModal.draft}
                onChange={(draft) =>
                  setPropertyPermissionsModal((current) => (current ? { ...current, draft } : current))
                }
              />
              <div className="flex justify-end gap-2">
                <Button
                  type="button"
                  className="rounded-full"
                  data-attr="co-manager-save-permissions"
                  onClick={() => {
                    propertyPermissionsModal.onSave(propertyPermissionsModal.draft);
                    setPropertyPermissionsModal(null);
                    showToast("Permissions updated.");
                  }}
                >
                  Save permissions
                </Button>
              </div>
            </div>
          ) : null}
        </Modal>

        <Modal
          open={permissionsMember !== null}
          title={permissionsMember ? `Edit permissions · ${permissionsMember.name}` : "Edit permissions"}
          onClose={() => setPermissionsMember(null)}
          panelClassName="max-w-2xl"
          dataAttr="team-member-permissions-modal"
        >
          {permissionsMember ? renderDetailBody(permissionsMember) : null}
        </Modal>

        <Modal
          open={linkedPropertiesPopup !== null}
          title={linkedPropertiesPopup ? `Linked properties · ${linkedPropertiesPopup.label}` : "Linked properties"}
          onClose={() => setLinkedPropertiesPopup(null)}
        >
          {linkedPropertiesPopup && linkedPropertiesPopup.propertyIds.length > 0 ? (
            <ul className="space-y-2">
              {linkedPropertiesPopup.propertyIds.map((pid) => (
                <li
                  key={pid}
                  className="rounded-xl border border-border bg-accent/25 px-3 py-2 text-sm text-foreground"
                >
                  {teamPropertyLabel(pid)}
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-muted">No properties linked yet.</p>
          )}
        </Modal>

        {transferPropertyId ? (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 [html[data-theme=dark]_&]:bg-black/65">
            <div className="w-full max-w-lg rounded-2xl border border-border bg-card p-6 shadow-lg">
              <p className="text-lg font-semibold text-foreground">Transfer ownership</p>
              <p className="mt-2 text-sm text-muted">
                Promote a team member to main manager of{" "}
                <span className="font-medium text-foreground">
                  {teamPropertyLabel(transferPropertyId)}
                </span>
                . Choose the permissions you keep as a team member.
              </p>

              <label className="mt-4 block text-xs font-semibold text-muted">
                New main manager
                <Select
                  value={transferCoManagerUserId ?? ""}
                  onChange={(e) => setTransferCoManagerUserId(e.target.value || null)}
                  className="mt-1 h-10 w-full rounded-lg border border-border bg-card px-3 text-sm text-foreground"
                >
                  {coManagersForProperty(transferPropertyId).map((cm) => (
                    <option key={cm.id} value={cm.linkedUserId}>
                      {cm.linkedDisplayName ?? cm.linkedAxisId}
                    </option>
                  ))}
                </Select>
              </label>

              <div className="mt-4">
                <p className="text-xs font-semibold uppercase tracking-wide text-muted">Your team permissions</p>
                <div className="mt-2">
                  <CoManagerPermissionsEditor value={transferPermissions} onChange={setTransferPermissions} variant="readWrite" />
                </div>
              </div>

              <div className="mt-6 flex justify-start gap-2">
                <Button
                  type="button"
                  variant="outline"
                  className="rounded-full"
                  disabled={transferBusy}
                  onClick={() => {
                    setTransferPropertyId(null);
                    setTransferCoManagerUserId(null);
                    setTransferPermissions(EMPTY_CO_MANAGER_PERMISSIONS);
                  }}
                >
                  Cancel
                </Button>
                <Button type="button" className="rounded-full" disabled={transferBusy} onClick={() => submitTransfer()}>
                  {transferBusy ? "Transferring…" : "Confirm transfer"}
                </Button>
              </div>
            </div>
          </div>
        ) : null}

      <PortalNotificationPreviewModal
        open={linkInvitePreview !== null}
        title="New message"
        onClose={() => setLinkInvitePreview(null)}
        recipient={linkInvitePreview?.recipientName ?? ""}
        recipientPhone={linkInvitePreview?.recipientPhone}
        subject={linkInvitePreview?.subject ?? ""}
        body={linkInvitePreview?.body ?? ""}
        showChannelPicker
        deliverViaKind="account"
        dynamicSendLabel
        emailAvailable={Boolean(linkInvitePreview?.recipientUserId || linkInvitePreview?.recipientEmail)}
        smsAvailable={Boolean(linkInvitePreview?.recipientPhone?.trim() || linkInvitePreview?.recipientUserId)}
        defaultViaSms={Boolean(linkInvitePreview?.recipientPhone?.trim())}
        confirmLabel="Send invite"
        confirmLabelWithoutMessage="Continue without sending"
        skipMessageLabel="Don't send a message"
        confirmBusy={linkInviteBusy}
        confirmBusyLabel="Sending…"
        cancelLabel="Back"
        onConfirm={(skipMessage, channels, messageDraft) =>
          void confirmLinkInvite(skipMessage, channels, messageDraft)
        }
      />
      {teamRemovePreview && teamRemovePreview.length === 1 ? (
        <PortalNotificationPreviewModal
          open
          title="Disconnect team member — notification preview"
          onClose={() => setTeamRemovePreview(null)}
          recipient={teamRemovePreview[0]!.recipient}
          subject={teamRemovePreview[0]!.subject}
          body={teamRemovePreview[0]!.body}
          showChannelPicker
          emailAvailable={teamRemovePreview[0]!.emailAvailable}
          smsAvailable={false}
          defaultViaSms={false}
          confirmLabel="Disconnect & send message"
          confirmLabelWithoutMessage="Disconnect only"
          skipMessageLabel="Don't message team member"
          confirmBusy={teamRemoveBusy}
          confirmBusyLabel="Disconnecting…"
          cancelLabel="Cancel"
          onConfirm={(skipMessage, channels, messageDraft) =>
            void confirmTeamRemove(skipMessage, channels, messageDraft)
          }
        />
      ) : null}
      {teamRemovePreview && teamRemovePreview.length > 1 ? (
        <PortalBulkMessageCarouselModal
          open
          title={`Disconnect team members — notification preview (${teamRemovePreview.length})`}
          items={teamRemovePreview}
          confirmLabel="Disconnect all & send"
          confirmLabelSingle="Disconnect & send"
          confirmLabelWithoutMessage="Disconnect without messaging"
          skipMessageLabel="Don't message team members"
          confirmBusy={teamRemoveBusy}
          confirmBusyLabel="Disconnecting…"
          onClose={() => setTeamRemovePreview(null)}
          onConfirm={(scope, { skipMessage, channels, drafts, singleId }) =>
            void confirmTeamRemove(skipMessage, channels, undefined, {
              scope,
              singleId,
              drafts,
            })
          }
        />
      ) : null}
    </>
  );

  const teamListAlerts = (
    <>
      {loadError ? (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border px-4 py-3 text-sm portal-banner-danger">
          <span className="text-[var(--status-overdue-fg)]">
            Couldn&apos;t load your linked accounts. Your access hasn&apos;t changed; this is a
            temporary load error.
          </span>
          <Button
            type="button"
            variant="secondary"
            onClick={() => {
              loadRetriedRef.current = false;
              setLoadError(false);
              void loadRemoteInvites();
            }}
            data-attr="co-manager-retry-load"
          >
            Retry
          </Button>
        </div>
      ) : null}

      {skuTier != null && !planAllowsInvites ? (
        <p className="rounded-xl portal-banner-danger px-4 py-3 text-xs font-medium text-[var(--status-overdue-fg)]">
          Upgrade to Pro or Business to link team accounts. Free plans cannot send or accept co-manager invites.
        </p>
      ) : null}

      {inviteeAtCap ? (
        <p className="text-xs font-medium text-[var(--status-overdue-fg)]">
          That account is already at its link limit and cannot accept new links.
        </p>
      ) : null}
    </>
  );

  const memberRows: TeamMemberRow[] = [
    {
      id: "owner",
      name: managerDisplayName === "Your property manager" ? (managerEmail ?? "You") : managerDisplayName,
      detail: managerEmail ?? "You",
      role: "owner",
      propertiesLabel: `All houses in ${workspaceName}`,
      joinedAt: null,
    },
    ...teamEntries
      .filter((entry) => entry.kind === "local" || entry.invite.status === "accepted")
      .map((entry) => ({
        id: entry.id,
        name: entry.name || entry.axisId || "Team member",
        detail: (entry.kind === "remote" ? entry.invite.linkedEmail?.trim() : "") || entry.axisId,
        role: "co_manager" as const,
        propertiesLabel: entry.preview || "No houses yet",
        joinedAt: entry.kind === "remote" ? entry.invite.respondedAt : null,
        onEdit: () => setPermissionsMember(entry),
        onDisconnect: () => openTeamRemovePreview([entry]),
      })),
  ];
  const pendingInvites = [...visibleIncomingPending, ...visibleOutgoingPending];
  const teamListBody = !hasVisibleTeamRows && hasCoManagerLinks ? (
    <PortalDataTableEmpty
      icon="team"
      message="No team members match this property filter. Try All properties or pick another listing."
    />
  ) : (
    <div className={cn(PORTAL_LIST_PAGE_BODY, "space-y-3")} data-attr="co-manager-unified-view">
      <TeamMembersBlock members={memberRows} />
      <TeamPendingInvitesBlock
        invites={pendingInvites}
        propertiesLabel={(inv) => teamPropertyPreview(inv.assignedPropertyIds, teamPropertyLabel) || "No houses yet"}
        expiryLabel={teamInvitePendingExpiryLabel}
        onCopyLink={(inv) => void copyInviteAcceptLink(inv.id, { openInvite: inv.openInvite })}
        onRevoke={(inv) => void cancelInvite(inv.id)}
        onAccept={(inv) => void respondInvite(inv.id, "accept")}
        onDecline={(inv) => void respondInvite(inv.id, "reject")}
        onOpen={(inv) => openTeamDetail(inv.id)}
      />
    </div>
  );

  const inviteAction = (
    <PortalIconAction
      icon={UserPlus}
      label="Invite"
      data-attr="co-manager-invite-top"
      disabled={inviteLinkBlocked}
      onClick={() => openLinkModal()}
    />
  );
  const titleControls = (
    <div className="flex items-center gap-1 sm:gap-1.5" data-attr="team-title-actions">
      {teamFilterSheet}
      {inviteAction}
    </div>
  );
  const publishedToTitle = usePublishTitleActions(titleControls, Boolean(bare) && !byWorkspace && !routeLinkId);

  // Settings → Workspaces: one "Managers & permissions" section per owned card.
  const workspaceTeamSection = (workspace: PortalWorkspace): ReactNode => {
    const belongs = (assigned: string[], grantWorkspaceId?: string | null) =>
      grantBelongsToWorkspace(assigned, workspace, grantWorkspaceId);
    const memberEntries = teamEntries.filter((entry) =>
      entry.kind === "local"
        ? belongs(entry.row.assignedPropertyIds)
        : entry.invite.status === "accepted" && belongs(entry.invite.assignedPropertyIds, entry.invite.workspaceId),
    );
    const previewFor = (assigned: string[]) => {
      const here = assignedIdsInWorkspace(assigned, workspace.propertyIds);
      return here.length === 0 ? "No houses yet" : teamPropertyPreview(here, teamPropertyLabel);
    };
    const rows: TeamMemberRow[] = [
      {
        id: "owner",
        name: managerDisplayName === "Your property manager" ? (managerEmail ?? "You") : managerDisplayName,
        detail: managerEmail ?? "You",
        role: "owner",
        propertiesLabel: `All houses in ${workspace.name}`,
        joinedAt: null,
      },
      ...memberEntries.map((entry) => ({
        id: entry.id,
        name: entry.name || entry.axisId || "Team member",
        detail: (entry.kind === "remote" ? entry.invite.linkedEmail?.trim() : "") || entry.axisId,
        role: "co_manager" as const,
        propertiesLabel: previewFor(entry.kind === "remote" ? entry.invite.assignedPropertyIds : entry.row.assignedPropertyIds),
        joinedAt: entry.kind === "remote" ? entry.invite.respondedAt : null,
        onEdit: () => setPermissionsMember(entry),
        onDisconnect: () => openTeamRemovePreview([entry]),
      })),
    ];
    const pending = useRemote
      ? [...incomingPending, ...outgoingPending].filter((inv) => belongs(inv.assignedPropertyIds, inv.workspaceId))
      : [];
    const loading = useRemote && !remoteLoaded && !loadError;
    return (
      <div data-attr="workspace-team" data-workspace-id={workspace.id}>
        <div className="flex items-center justify-between gap-2 border-t border-border px-4 py-2">
          <span className="inline-flex min-h-10 items-center gap-1.5 text-sm font-semibold text-primary">
            <Users className="size-4" aria-hidden />
            Managers &amp; permissions
          </span>
          <PortalIconAction
            icon={UserPlus}
            label="Invite"
            className="min-h-9"
            disabled={inviteLinkBlocked}
            onClick={() => openLinkModal(workspace.id)}
            data-attr="workspace-team-invite"
          />
        </div>
        {loading ? (
          <div className="space-y-2 border-t border-border/60 px-4 py-3" role="status" aria-label="Loading team">
            <div className="h-3 w-1/3 rounded-lg bg-[var(--secondary)]" />
            <div className="h-3 w-1/2 rounded-lg bg-[var(--secondary)]" />
          </div>
        ) : (
          <>
            <TeamMembersBlock embedded members={rows} />
            <TeamPendingInvitesBlock
              embedded
              invites={pending}
              propertiesLabel={(inv) => previewFor(inv.assignedPropertyIds)}
              expiryLabel={teamInvitePendingExpiryLabel}
              onCopyLink={(inv) => void copyInviteAcceptLink(inv.id, { openInvite: inv.openInvite })}
              onRevoke={(inv) => void cancelInvite(inv.id)}
              onAccept={(inv) => void respondInvite(inv.id, "accept")}
              onDecline={(inv) => void respondInvite(inv.id, "reject")}
              onOpen={(inv) => openTeamDetail(inv.id)}
            />
            {memberEntries.length === 0 && pending.length === 0 ? (
              <p className="border-t border-border/60 px-4 py-2.5 text-sm text-muted" data-attr="workspace-team-empty">
                Only you. Invite a manager to share these houses.
              </p>
            ) : null}
          </>
        )}
      </div>
    );
  };

  if (byWorkspace && !routeLinkId) {
    return (
      <div className="min-w-0 space-y-4" data-attr="settings-team-managers">
        {teamListAlerts}
        {renderWorkspaces({ section: workspaceTeamSection })}
        {teamModals}
      </div>
    );
  }

  if (routeLinkId) {
    if (!routeEntry) {
      return (
        <>
          {teamModals}
          <ManagerPortalPageShell title="Teams" hideTitleOnMobileNav compactFilterRow>
            <PortalDataTableEmpty icon="team" message="Team member not found." />
          </ManagerPortalPageShell>
        </>
      );
    }
    return (
      <>
        {teamModals}
        <PortalRecordDetailPage
          pageTitle="Teams"
          title={routeEntry.name}
          subtitle={routeEntry.axisId}
          avatarName={routeEntry.name}
          backHref={teamLinkHref(portalBase)}
          backLabel="Back to managers"
          hideBackText
          bareHeader
          dataAttrBack="team-detail-back"
          inlineActions
          pinScrollBody
          footerOmitSpacer
          actions={renderDetailHeaderActions(routeEntry)}
          footer={renderDetailFooter(routeEntry)}
        >
          <PortalRecordListSurface className="mt-0" onBulkClear={detailPropertiesEditable ? clearDetailPropertySelection : undefined} bulkCount={selectedDetailPropertyIds.size} bulkActions={detailPropertiesEditable && selectedDetailPropertyIds.size > 0 ? (
          <>
            {selectedDetailPropertyIds.size === 1 ? (
              <>
                <Button
                  type="button"
                  variant="outline"
                  className={PORTAL_BULK_BAR_BTN}
                  data-attr="team-detail-bulk-make-owner"
                  onClick={() => openMakeOwnerForSelectedDetailProperty()}
                >
                  Make owner
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  className={PORTAL_BULK_BAR_BTN}
                  data-attr="team-detail-bulk-edit-permissions"
                  onClick={() => openPermissionsForSelectedDetailProperty()}
                >
                  Edit permissions
                </Button>
              </>
            ) : null}
            <Button
              type="button"
              variant="outline"
              className={`${PORTAL_BULK_BAR_BTN} text-rose-800`}
              data-attr="team-detail-bulk-remove-access"
              onClick={() => void bulkRemoveDetailProperties()}
            >
              Remove access
            </Button>
          </>
        ) : null}>{renderDetailBody(routeEntry)}</PortalRecordListSurface>
        </PortalRecordDetailPage>

      </>
    );
  }

  const teamBody = (
    <>
      {publishedToTitle ? (
        teamActiveFilterChips ? (
          <div className="mb-2 min-w-0" data-attr="portal-list-active-filter-chips">
            {teamActiveFilterChips}
          </div>
        ) : null
      ) : (
        <PortalListControlStack
          className="mb-2 max-lg:mb-1.5"
          variant="command"
          stickyDestinations={!bare}
          actions={teamFilterSheet}
          primary={inviteAction}
          activeFilterChips={teamActiveFilterChips}
        />
      )}
      <div className="space-y-4">
        {teamListAlerts}
        {teamListBody}
      </div>
    </>
  );

  if (bare) {
    return (
      <div className="min-w-0" data-attr="settings-team-managers">
        <PortalRecordListSurface className="mt-0" onBulkClear={clearSelection} bulkCount={selectedIds.size} bulkActions={selectedIds.size > 0 ? (
          <>
            <Button
              type="button"
              variant="outline"
              className={`${PORTAL_BULK_BAR_BTN} text-rose-800`}
              data-attr="team-bulk-remove"
              disabled={teamRemoveBusy}
              onClick={() => bulkRemoveSelected()}
            >
              Disconnect
            </Button>
          </>
        ) : null}>{teamBody}</PortalRecordListSurface>

        {teamModals}
      </div>
    );
  }

  return (
    <ManagerPortalPageShell
      title="Teams"

      hideTitleOnMobileNav
      compactFilterRow
    >
      <PortalRecordListSurface className="mt-0" onBulkClear={clearSelection} bulkCount={selectedIds.size} bulkActions={selectedIds.size > 0 ? (
        <>
          <Button
            type="button"
            variant="outline"
            className={`${PORTAL_BULK_BAR_BTN} text-rose-800`}
            data-attr="team-bulk-remove"
            disabled={teamRemoveBusy}
            onClick={() => bulkRemoveSelected()}
          >
            Disconnect
          </Button>
        </>
      ) : null}>{teamBody}</PortalRecordListSurface>

      {teamModals}
    </ManagerPortalPageShell>
  );
}
