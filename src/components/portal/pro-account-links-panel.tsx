"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { BulkActionBar } from "@/components/ui/bulk-action-bar";
import { Button } from "@/components/ui/button";
import { ManagerInviteLinkModal } from "@/components/portal/manager-invite-link-modal";
import { CheckboxMultiSelect } from "@/components/ui/checkbox-multi-select";
import { DataList } from "@/components/ui/data-list";
import { Modal } from "@/components/ui/modal";
import { PortalActiveFilterChips } from "@/components/portal/portal-filter-chips";
import { PortalFilterSortSheet, portalFilterActiveCount } from "@/components/portal/portal-filter-sort-sheet";
import { PORTAL_PROPERTY_FILTER_SHEET_CLASS } from "@/components/portal/portal-filter-shell";
import { ApplicationFilterSortFields } from "@/components/portal/application-filter-sort-fields";
import { PortalListControlStack } from "@/components/portal/portal-list-control-stack";
import {
  ManagerPortalPageShell,
  PORTAL_HEADER_ACTION_BTN,
} from "@/components/portal/portal-metrics";
import {
  PortalDataTableEmpty,
  PORTAL_DETAIL_BTN,
  PortalTableDetailActions,
} from "@/components/portal/portal-data-table";
import {
  PortalListAddRow,
  PORTAL_LIST_ADD_ICONS,
  PORTAL_LIST_ADD_ROW_WRAP_CLASS,
} from "@/components/portal/portal-list-add-row";
import { PORTAL_LIST_PAGE_BODY, INBOX_LIST_SCROLL } from "@/components/portal/portal-inbox-ui";
import { PortalPersonRecordRow } from "@/components/portal/portal-record-row";
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
  readLinkedListingsForUser,
  resolvePropertyLabelForId,
  disambiguatePropertyOptionLabels,
  safePropertyOptionLabel,
  samePropertyId,
  syncManagerPortfolioFromServer,
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
  coManagerInviteSubject,
  coManagerInviteWithdrawnSubject,
  coManagerLinkLeftSubject,
  coManagerLinkRemovedSubject,
} from "@/lib/co-manager-link-email";
import { fetchAndCacheLandlordLegalName } from "@/lib/manager-landlord-profile";
import { formatProplaneIdForDisplay } from "@/lib/manager-id";

type TeamRemovePreviewItem = BulkMessageCarouselItem & {
  entry: TeamListEntry;
};

type LinkInvitePreview = {
  subject: string;
  body: string;
  recipientName: string;
  recipientUserId: string;
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
};

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
    const base = inv.direction === "incoming" ? "Needs approval" : "Invite sent";
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
  { label: "All read-only", preset: "read" },
  { label: "All write", preset: "edit" },
  { label: "All delete", preset: "delete" },
  { label: "All full access", preset: "full" },
];

const CO_MANAGER_READ_WRITE_PRESETS: { label: string; preset: CoManagerBulkPreset }[] = [
  { label: "All read-only", preset: "read" },
  { label: "All write", preset: "edit" },
  { label: "All full access", preset: "full" },
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

function CoManagerPermissionsEditor({
  value,
  onChange,
  disabled,
  variant = "readWrite",
}: {
  value: CoManagerPermissions;
  onChange: (next: CoManagerPermissions) => void;
  disabled?: boolean;
  /** Property permissions expose read + write only; transfer flows may use full. */
  variant?: "readWrite" | "full";
}) {
  const presets = variant === "full" ? CO_MANAGER_PERMISSION_PRESETS : CO_MANAGER_READ_WRITE_PRESETS;

  const setLevels = (id: CoManagerPermissionId, levels: GrantLevels) => {
    const next = { ...value };
    // The readWrite editor shows no Delete control. Dropping the level outright
    // revoked an existing delete grant the moment ANY level was toggled, but
    // carrying it through unconditionally made it UNREVOCABLE — every toggle
    // rewrote a grant that still contained delete, and read is derived from it.
    // Carry it only while the module is still granted; clearing read and write
    // removes the module outright, delete included.
    const normalized: GrantLevels =
      variant === "readWrite"
        ? levels.read || levels.edit || levels.notification
          ? {
              read: levels.read,
              edit: levels.edit,
              delete:
                levels.read || levels.edit ? grantToLevels(value[id]).delete : undefined,
              notification: levels.notification,
            }
          : {}
        : levels;
    const grant = levelsToGrant(normalized);
    if (grant === undefined) delete next[id];
    else next[id] = grant;
    onChange(next);
  };

  const isEmpty = Object.keys(value).length === 0;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-1.5">
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
      </div>
      {isEmpty ? (
        <p className="rounded-lg border border-dashed border-border bg-accent/20 px-3 py-2 text-xs text-muted">
          No access. Turn on Read, Write, and Notify for each module below, or use a preset above.
        </p>
      ) : null}
      <div className="space-y-2">
        {CO_MANAGER_PERMISSION_OPTIONS.map(({ id, label }) => {
          const levels = grantToLevels(value[id]);
          return (
            <div
              key={id}
              className={`flex flex-col gap-2 rounded-xl border border-border bg-card px-3 py-2.5 sm:flex-row sm:items-center sm:justify-between ${
                disabled ? "opacity-60" : ""
              }`}
            >
              <span className="text-sm font-medium text-foreground">{label}</span>
              <div className="flex flex-wrap items-center gap-1.5">
                {/*
                  Write implies read (`grantToLevels` derives read as
                  read||edit||delete), so with Write on there is no Read choice
                  left to make. This used to render the Read toggle anyway, lit
                  and disabled — two controls where one was inert, which reads
                  as a broken switch rather than an implication. Now the choice
                  disappears and says what is true instead.
                */}
                {levels.edit ? (
                  <span
                    className="rounded-full border border-border bg-accent/30 px-2.5 py-1 text-xs font-medium text-muted"
                    data-attr={`co-manager-${id}-read-implied`}
                  >
                    Read included
                  </span>
                ) : (
                <PermissionLevelToggle
                  label="Read"
                  active={Boolean(levels.read)}
                  disabled={disabled}
                  dataAttr={`co-manager-${id}-read`}
                  onToggle={() =>
                    setLevels(
                      id,
                      levels.read
                        ? {
                            edit: levels.edit,
                            delete: variant === "full" ? levels.delete : undefined,
                            notification: levels.notification,
                          }
                        : {
                            read: true,
                            edit: levels.edit,
                            delete: variant === "full" ? levels.delete : undefined,
                            notification: levels.notification ?? true,
                          },
                    )
                  }
                />
                )}
                <PermissionLevelToggle
                  label="Write"
                  active={Boolean(levels.edit)}
                  disabled={disabled}
                  dataAttr={`co-manager-${id}-write`}
                  onToggle={() =>
                    setLevels(
                      id,
                      levels.edit
                        ? { read: levels.read || (variant === "full" ? levels.delete : false), notification: levels.notification }
                        : { read: true, edit: true, notification: levels.notification ?? true },
                    )
                  }
                />
                <PermissionLevelToggle
                  label="Notify"
                  active={Boolean(levels.notification)}
                  disabled={disabled}
                  dataAttr={`co-manager-${id}-notify`}
                  onToggle={() =>
                    setLevels(
                      id,
                      levels.notification
                        ? {
                            read: levels.read,
                            edit: levels.edit,
                            delete: variant === "full" ? levels.delete : undefined,
                            notification: false,
                          }
                        : {
                            read: levels.read,
                            edit: levels.edit,
                            delete: variant === "full" ? levels.delete : undefined,
                            notification: true,
                          },
                    )
                  }
                />
                {variant === "full" ? (
                  <>
                    <PermissionLevelToggle
                      label="Remove"
                      active={!levels.read && !levels.edit && !levels.delete}
                      disabled={disabled}
                      dataAttr={`co-manager-${id}-remove`}
                      onToggle={() => setLevels(id, {})}
                    />
                    <PermissionLevelToggle
                      label="Delete"
                      active={Boolean(levels.delete)}
                      disabled={disabled}
                      dataAttr={`co-manager-${id}-delete`}
                      onToggle={() =>
                        setLevels(
                          id,
                          levels.delete
                            ? { read: levels.read || levels.edit, edit: levels.edit }
                            : { read: true, delete: true, edit: levels.edit },
                        )
                      }
                    />
                  </>
                ) : null}
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
  return {
    assignedPropertyIds: [...inv.assignedPropertyIds],
    propertyCoManagerPermissions: normalizePropertyCoManagerPermissions(
      inv.propertyCoManagerPermissions ?? inv.coManagerPermissions,
      inv.assignedPropertyIds,
    ),
  };
}

function inviteDraftFromRelationship(row: ProRelationshipRecord): InviteDraft {
  return {
    assignedPropertyIds: [...row.assignedPropertyIds],
    propertyCoManagerPermissions: normalizePropertyCoManagerPermissions(
      row.propertyCoManagerPermissions ?? row.coManagerPermissions,
      row.assignedPropertyIds,
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

export function ProAccountLinksPanel({ userId, linkId: linkIdProp }: { userId: string; linkId?: string }) {
  const { email: managerEmail, ready: managerSessionReady } = useManagerUserId();
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
        for (const inv of invites.filter((i) => i.status === "accepted")) {
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
    return buildManagerPropertyFilterOptions(userId);
  }, [userId, localTick]);

  const passesTeamPropertyFilter = useCallback((assignedPropertyIds: string[]) => {
    if (teamPropertyFilters.length === 0) return true;
    return assignedPropertyIds.some((id) => teamPropertyFilters.some((filterId) => samePropertyId(id, filterId)));
  }, [teamPropertyFilters]);

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
    return propertyChoices(userId);
  }, [userId, localTick]);

  const ownedProperties = useMemo(() => {
    void localTick;
    const live = readExtraListingsForUser(userId).map((p) => ({
      id: p.id,
      label: safePropertyOptionLabel([`${p.buildingName} · ${p.unitLabel || "Unit"}`, p.buildingName, p.address], p.id),
      address: p.address,
    }));
    const pending = readPendingManagerPropertiesForUser(userId).map((r) => {
      const joined = `${r.buildingName} · ${r.unitLabel} (pending)`;
      return {
        id: r.id,
        label: safePropertyOptionLabel([joined, r.buildingName, r.address], r.id),
        address: r.address,
      };
    });
    return disambiguatePropertyOptionLabels([...live, ...pending]);
  }, [userId, localTick]);

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
    for (const option of propertyOptions) map.set(option.id, option.label);
    for (const property of coManagedProperties) map.set(property.id, property.label);
    for (const inv of remoteInvites) {
      for (const [id, label] of Object.entries(inv.assignedPropertyLabels ?? {})) {
        if (id.trim() && label.trim()) map.set(id, label.trim());
      }
    }
    return map;
  }, [propertyOptions, coManagedProperties, remoteInvites]);

  const teamPropertyLabel = useCallback(
    (propertyId: string) =>
      teamPropertyLabelById.get(propertyId) ?? resolvePropertyLabel(propertyId, propertyId),
    [teamPropertyLabelById],
  );

  const managedPropertyCount = ownedProperties.length + coManagedProperties.length;

  const [axisInput, setAxisInput] = useState("");
  const [linkModalOpen, setLinkModalOpen] = useState(false);
  const [inviteLinkModalOpen, setInviteLinkModalOpen] = useState(false);
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
  const [skuTier, setSkuTier] = useState<string | null>(null);

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

  const linkCap = maxAccountLinksForTier(skuTier);
  const participantUsedCount = remoteInvites.filter((i) => i.status === "pending" || i.status === "accepted").length;
  const atLinkCap = linkCap != null && (useRemote ? participantUsedCount >= linkCap : localRows.length >= linkCap);
  const planAllowsInvites = skuTier != null && managerPlanAllowsCoManagerInvites(skuTier);
  const linkAccountBlocked = atLinkCap || (skuTier != null && !planAllowsInvites);

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
        preview: teamPropertyPreview(inv.assignedPropertyIds, teamPropertyLabel),
        kind: "remote" as const,
        invite: inv,
      }));
    }
    return visibleLocalRows.map((row) => ({
      id: row.id,
      name: row.linkedDisplayName ?? row.linkedAxisId,
      axisId: row.linkedAxisId,
      statusLabel: TEAM_MEMBER_ROLE_LABEL,
      preview: teamPropertyPreview(row.assignedPropertyIds, teamPropertyLabel),
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
    async (inviteId: string) => {
      const url = teamMemberDetailHref(portalBase, inviteId);
      try {
        await navigator.clipboard.writeText(url);
        showToast("Invite link copied.");
      } catch {
        showToast("Could not copy the invite link.");
      }
    },
    [portalBase, showToast],
  );

  const renderInviteAcceptLinkCard = (inviteId: string) => {
    const url = teamMemberDetailHref(portalBase, inviteId);
    return (
      <div
        className="rounded-2xl border border-primary/20 bg-primary/[0.04] px-4 py-3"
        data-attr="co-manager-invite-link-card"
      >
        <p className="text-xs font-semibold uppercase tracking-wide text-muted">Invite link</p>
        <p className="mt-1 break-all font-mono text-xs text-foreground">{url}</p>
        <p className="mt-2 text-xs leading-relaxed text-muted">
          Share this link with the co-manager. When they sign in and open it, they can accept the invite.
        </p>
        <Button
          type="button"
          variant="outline"
          className="mt-3 h-9 min-h-0 rounded-full px-4 text-[13px]"
          data-attr="co-manager-copy-invite-link"
          onClick={() => void copyInviteAcceptLink(inviteId)}
        >
          Copy invite link
        </Button>
      </div>
    );
  };

  const lookup = async (): Promise<boolean> => {
    const raw = axisInput.trim();
    if (!raw) {
      showToast(`Enter a ${AXIS_ID_LABEL}.`);
      return false;
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
        return false;
      }
      setDraftAxisId(raw);
      setDraftName(body.displayName ?? raw);
      setDraftUserId(body.userId ?? null);
      showToast("Account verified. Assign properties, then send invite.");
      return true;
    } catch {
      showToast("Network error.");
      return false;
    } finally {
      setLookupBusy(false);
    }
  };

  // On a successful lookup, draftAxisId is set — the Link-account modal then
  // advances from the Axis-ID step to the assign-properties step in place,
  // instead of closing and dropping the user onto an inline page section.
  const submitLinkAccount = async () => {
    await lookup();
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
  };

  /** Return to the Axis-ID step, keeping the typed id so it can be re-verified. */
  const backToLookup = () => {
    setDraftAxisId(null);
    setDraftName(null);
    setDraftUserId(null);
    setSelectedProps({});
    setPropertyPermissionsDraft({});
    setInviteeAtCap(false);
  };

  const openLinkModal = () => {
    if (skuTier != null && !managerPlanAllowsCoManagerInvites(skuTier)) {
      showToast("Upgrade to Pro or Business before linking co-managers.");
      return;
    }
    resetLinkDraft();
    setLinkModalOpen(true);
  };

  const closeLinkModal = () => {
    setLinkModalOpen(false);
    resetLinkDraft();
  };

  const linkInvitePropertySelectOptions = useMemo(
    () =>
      propertyOptions.map((p) => ({
        value: p.id,
        label: p.label,
        // A listing that exists only in this browser's cache would be rejected by
        // the server, so it stays visible but unselectable — and says why, rather
        // than reading as an arbitrarily dead row (PRP-210).
        disabled: Boolean(p.notYetSynced),
        hint: p.notYetSynced ? "Still saving — you can assign this once it finishes." : undefined,
      })),
    [propertyOptions],
  );

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
        if (!updated[id]) updated[id] = buildAllModulesGrant("read");
      }
      for (const id of Object.keys(updated)) {
        if (!nextSet.has(id)) delete updated[id];
      }
      return updated;
    });
  };

  const saveNewLink = () => {
    if (skuTier != null && !managerPlanAllowsCoManagerInvites(skuTier)) {
      showToast("Upgrade to Pro or Business before linking co-managers.");
      return;
    }
    if (linkCap != null && atLinkCap) {
      showToast(`${tierShort ?? "Your plan"}: ${linkCap} link${linkCap === 1 ? "" : "s"} max.`);
      return;
    }
    if (!draftAxisId || !draftUserId) {
      showToast(`Verify a ${AXIS_ID_LABEL} first.`);
      return;
    }
    const ids = Object.entries(selectedProps)
      .filter(([, v]) => v)
      .map(([k]) => k);
    if (ids.length === 0) {
      showToast("Select at least one property for this invite.");
      return;
    }
    const propertyLabels = ids.map((id) => teamPropertyLabel(id));
    setLinkInvitePreview({
      subject: coManagerInviteSubject(managerDisplayName),
      body: buildCoManagerInviteBody({ inviterName: managerDisplayName, propertyLabels }),
      recipientName: draftName ?? draftAxisId,
      recipientUserId: draftUserId,
    });
    setLinkModalOpen(false);
  };

  const confirmLinkInvite = async (
    skipMessage: boolean,
    channels?: NotificationDeliveryChannels,
    messageDraft?: NotificationConfirmDraft,
  ) => {
    if (!linkInvitePreview || linkInviteBusy) return;
    if (!draftAxisId || !draftUserId) {
      showToast(`Verify a ${AXIS_ID_LABEL} first.`);
      return;
    }
    const ids = Object.entries(selectedProps)
      .filter(([, v]) => v)
      .map(([k]) => k);
    if (ids.length === 0) {
      showToast("Select at least one property for this invite.");
      return;
    }

    const payout = 15;
    const propertyCoManagerPermissions = normalizePropertyCoManagerPermissions(propertyPermissionsDraft, ids);

    setLinkInviteBusy(true);
    let pendingInviteId: string | null = null;
    try {
      if (useRemote && remoteLoaded) {
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
      } else {
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
        const propertyLabels = ids.map((id) => teamPropertyLabel(id));
        const inviteBody = pendingInviteId
          ? buildCoManagerInviteBody({
              inviterName: managerDisplayName,
              propertyLabels,
              inviteId: pendingInviteId,
            })
          : linkInvitePreview.body;
        const result = await deliverManagerDirectoryMessage(
          {
            name: linkInvitePreview.recipientName,
            email: "",
            subject: linkInvitePreview.subject,
            body: inviteBody,
          },
          false,
          channels,
          messageDraft,
          { toUserIds: [linkInvitePreview.recipientUserId], eventCategory: "account" },
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
    if (nextAssigned.length === 0) {
      showToast("Keep at least one property in this link.");
      return;
    }
    const nextPerms = normalizePropertyCoManagerPermissions(
      {
        ...draft.propertyCoManagerPermissions,
        ...Object.fromEntries(
          nextAssigned
            .filter((id) => !draft.assignedPropertyIds.includes(id))
            .map((id) => [id, buildAllModulesGrant("read")]),
        ),
      },
      nextAssigned,
    );
    if (remote) {
      const inv = activeRemote.find((row) => row.id === linkId);
      if (inv) scheduleInviteSave(inv.id, { assignedPropertyIds: nextAssigned, propertyCoManagerPermissions: nextPerms });
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
        [inv.id]: { assignedPropertyIds: nextAssigned, propertyCoManagerPermissions: nextPerms },
      }));
      const nextInvites = remoteInvites.map((row) =>
        row.id === inv.id
          ? { ...row, assignedPropertyIds: nextAssigned, propertyCoManagerPermissions: nextPerms }
          : row,
      );
      seedAccountLinksCache(nextInvites);
      writeProRelationships(userId, proRelationshipRowsFromInvites(nextInvites.filter((i) => i.status === "accepted")));
      scheduleInviteSave(inv.id, { assignedPropertyIds: nextAssigned, propertyCoManagerPermissions: nextPerms });
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
      const ok = await patchInvite(id, { action: "revoke" }, "Link removed.");
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
    showToast("Link removed.");
    if (routeLinkId === id) navigateToList();
  };

  const respondInvite = async (id: string, action: "accept" | "reject") => {
    const ok = await patchInvite(
      id,
      { action },
      action === "accept" ? "Invite accepted. Link is active." : "Invite declined.",
    );
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
          [inv.id]: { assignedPropertyIds: nextAssigned, propertyCoManagerPermissions: nextPerms },
        }));
        const nextInvites = remoteInvites.map((row) =>
          row.id === inv.id
            ? { ...row, assignedPropertyIds: nextAssigned, propertyCoManagerPermissions: nextPerms }
            : row,
        );
        seedAccountLinksCache(nextInvites);
        writeProRelationships(userId, proRelationshipRowsFromInvites(nextInvites.filter((i) => i.status === "accepted")));
        scheduleInviteSave(inv.id, { assignedPropertyIds: nextAssigned, propertyCoManagerPermissions: nextPerms });
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
              <input
                type="checkbox"
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
            ? "Team link removed."
            : `${count} team links removed.`
          : notifiedCount === 0
            ? count === 1
              ? "Team link removed."
              : `${count} team links removed.`
            : notifiedCount === count
              ? count === 1
                ? "Team link removed and team member notified."
                : `${count} team links removed and team members notified.`
              : `${count} team links removed; ${notifiedCount} team member${notifiedCount === 1 ? "" : "s"} notified.`,
      );
    } finally {
      setTeamRemoveBusy(false);
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
          {readOnly ? "Leave team link" : "Remove team link"}
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
        Remove team link
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

  const teamListAddRow = (
    <PortalListAddRow
      label="Add"
      ariaLabel="Link account"
      icon={PORTAL_LIST_ADD_ICONS.team}
      onClick={openLinkModal}
      disabled={linkAccountBlocked}
      dataAttr="co-manager-list-add"
    />
  );

  /*
    The dashed ADD row already covers "link an account by PropLane ID", so the
    toolbar deliberately carries the OTHER door rather than the same one twice:
    minting a shareable link, for when you do not have their ID.
  */
  const teamLinkButton = (
    <Button
      type="button"
      variant="outline"
      className={PORTAL_HEADER_ACTION_BTN}
      disabled={linkAccountBlocked}
      data-attr="co-manager-invite-link-open"
      onClick={() => setInviteLinkModalOpen(true)}
    >
      Invite link
    </Button>
  );

  const renderInviteDetail = (inv: AccountLinkInviteDto, entry: TeamListEntry) => {
    const draft = getInviteDraft(inv);
    const readOnly = inv.direction === "incoming";
    return (
      <div className="space-y-4" data-attr="team-member-property-access">
        <TeamMemberContactCard entry={entry} />
        {inv.status === "pending" && inv.direction === "outgoing"
          ? renderInviteAcceptLinkCard(inv.id)
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

        {draft.assignedPropertyIds.length === 0 ? (
          <p className="text-sm text-muted">No properties in this link yet.</p>
        ) : (
          <div className="space-y-3">
            {draft.assignedPropertyIds.map((pid) =>
              renderPropertyPermissionsSection(pid, draft, inv, readOnly),
            )}
          </div>
        )}
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
        <ManagerInviteLinkModal
          open={inviteLinkModalOpen}
          onClose={() => setInviteLinkModalOpen(false)}
          propertyOptions={linkInvitePropertySelectOptions}
          renderPermissionsEditor={(value, onChange) => (
            <CoManagerPermissionsEditor value={value} onChange={onChange} variant="readWrite" />
          )}
        />

        <Modal
          open={linkModalOpen}
          title={draftAxisId ? "Assign properties & permissions" : "Link account"}
          onClose={closeLinkModal}
          panelClassName={draftAxisId ? "max-w-2xl" : undefined}
          footer={
            draftAxisId ? (
              <div className="flex w-full items-center justify-between gap-2">
                <Button type="button" variant="outline" className="rounded-full" onClick={backToLookup}>
                  Back
                </Button>
                <Button
                  type="button"
                  variant="primary"
                  className="rounded-full"
                  disabled={linkAccountBlocked}
                  onClick={() => saveNewLink()}
                >
                  {useRemote ? "Send invite" : "Save link (local)"}
                </Button>
              </div>
            ) : (
              <div className="flex w-full justify-end">
                <Button
                  type="button"
                  variant="primary"
                  className="rounded-full"
                  loading={lookupBusy}
                  disabled={lookupBusy || linkAccountBlocked}
                  onClick={() => void submitLinkAccount()}
                >
                  {lookupBusy ? "Checking…" : "Continue"}
                </Button>
              </div>
            )
          }
        >
          <div className="mb-4 flex flex-wrap items-center gap-2 border-b border-border pb-4 text-xs text-muted">
            <span className={draftAxisId ? "" : "font-semibold text-foreground"}>1. Find account</span>
            <span aria-hidden className="text-muted/60">
              →
            </span>
            <span className={draftAxisId ? "font-semibold text-foreground" : ""}>2. Properties &amp; access</span>
          </div>
          {!draftAxisId ? (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void submitLinkAccount();
              }}
              className="space-y-4"
            >
              <div className="rounded-2xl border border-border bg-accent/20 p-4">
              <label className="block text-xs font-semibold text-muted">
                {AXIS_ID_LABEL}
                <Input
                  type="text"
                  value={axisInput}
                  onChange={(e) => setAxisInput(e.target.value)}
                  placeholder="e.g. PROPLANE-1A2B3C4D"
                  autoFocus
                  className="mt-1 font-mono"
                />
              </label>
              <p className="mt-3 text-xs leading-relaxed text-muted">
                {/*
                  One interpolated string rather than text around a `{...}` in
                  JSX: the previous form put the label next to a line break and
                  rendered as "PropLane IDof the manager".
                */}
                {`Ask them for their ${AXIS_ID_LABEL} — it is on their PropLane Settings page. Next you'll pick which properties they co-manage and what they can do on each, then send the invite.`}
              </p>
              <p className="mt-2 text-xs leading-relaxed text-muted">
                {`Don't have their ${AXIS_ID_LABEL}? Create a shareable invite link instead — you set the properties and permissions first, then anyone who opens the link joins with exactly that access.`}
              </p>
              </div>
            </form>
          ) : (
            <div className="space-y-5">
              <div className="rounded-2xl border border-primary/25 bg-primary/[0.05] px-4 py-3">
                <p className="text-sm text-foreground">
                  Linking with{" "}
                  <span className="font-semibold">{draftName}</span>
                </p>
                <p className="mt-0.5 font-mono text-xs text-muted">
                  <span className="font-sans font-semibold uppercase tracking-wide text-[10px] text-muted">
                    PropLane ID{" "}
                  </span>
                  {formatProplaneIdForDisplay(draftAxisId)}
                </p>
              </div>

              {inviteeAtCap ? (
                <p className="rounded-xl portal-banner-danger px-4 py-3 text-xs font-medium text-[var(--status-overdue-fg)]">
                  That account is already at its link limit and cannot accept new links.
                </p>
              ) : null}

              <div>
                {propertyOptions.length === 0 ? (
                  <p className="text-sm text-muted">No properties yet. Add listings under Properties first.</p>
                ) : (
                  <CheckboxMultiSelect
                    label="Assigned properties"
                    labelClassName="text-xs font-semibold uppercase tracking-wide text-muted"
                    options={linkInvitePropertySelectOptions}
                    selected={selectedPropIds}
                    onChange={handleLinkPropertySelectionChange}
                    emptyLabel="Select properties…"
                    searchPlaceholder="Search properties…"
                    dataAttr="co-manager-invite-properties"
                  />
                )}
              </div>

              {selectedPropIds.length > 0 ? (
                <div className="space-y-4">
                  <p className="text-xs font-semibold uppercase tracking-wide text-muted">Per-property permissions</p>
                  {selectedPropIds.map((pid) => (
                    <div key={pid} className="rounded-xl border border-border bg-accent/25 p-4">
                      <p className="text-sm font-semibold text-foreground">{teamPropertyLabel(pid)}</p>
                      <div className="mt-3">
                        <CoManagerPermissionsEditor
                          value={normalizeCoManagerPermissions(propertyPermissionsDraft[pid])}
                          onChange={(next) =>
                            setPropertyPermissionsDraft((prev) => ({ ...prev, [pid]: next }))
                          }
                        />
                      </div>
                    </div>
                  ))}
                </div>
              ) : null}
            </div>
          )}
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
                  variant="outline"
                  className="rounded-full"
                  onClick={() => setPropertyPermissionsModal(null)}
                >
                  Cancel
                </Button>
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
        title="Link account — notification preview"
        onClose={() => setLinkInvitePreview(null)}
        recipient={linkInvitePreview?.recipientName ?? ""}
        subject={linkInvitePreview?.subject ?? ""}
        body={linkInvitePreview?.body ?? ""}
        intro="Review the co-manager invite message before sending it."
        showChannelPicker
        showSchedule
        deliverViaKind="account"
        emailAvailable={Boolean(linkInvitePreview?.recipientUserId)}
        smsAvailable
        defaultViaSms={false}
        confirmLabel={useRemote ? "Send invite" : "Save link & send message"}
        confirmLabelWithoutMessage={useRemote ? "Send invite only" : "Save link only"}
        skipMessageLabel="Don't message team member"
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
          title="Remove team link — notification preview"
          onClose={() => setTeamRemovePreview(null)}
          recipient={teamRemovePreview[0]!.recipient}
          subject={teamRemovePreview[0]!.subject}
          body={teamRemovePreview[0]!.body}
          intro="Review the message before removing this team link."
          showChannelPicker
          showSchedule={false}
          emailAvailable={teamRemovePreview[0]!.emailAvailable}
          smsAvailable={false}
          defaultViaSms={false}
          confirmLabel="Remove & send message"
          confirmLabelWithoutMessage="Remove only"
          skipMessageLabel="Don't message team member"
          confirmBusy={teamRemoveBusy}
          confirmBusyLabel="Removing…"
          cancelLabel="Cancel"
          onConfirm={(skipMessage, channels, messageDraft) =>
            void confirmTeamRemove(skipMessage, channels, messageDraft)
          }
        />
      ) : null}
      {teamRemovePreview && teamRemovePreview.length > 1 ? (
        <PortalBulkMessageCarouselModal
          open
          title={`Remove team links — notification preview (${teamRemovePreview.length})`}
          intro="Review the message for each team member before removing these links."
          items={teamRemovePreview}
          confirmLabel="Remove all & send"
          confirmLabelSingle="Remove & send"
          confirmLabelWithoutMessage="Remove without messaging"
          skipMessageLabel="Don't message team members"
          confirmBusy={teamRemoveBusy}
          confirmBusyLabel="Removing…"
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

  const teamListBody = !hasVisibleTeamRows ? (
    hasCoManagerLinks ? (
      <PortalDataTableEmpty
        icon="team"
        message="No team members match this property filter. Try All properties or pick another listing."
      />
    ) : (
      // An empty list still belongs in the house body, or this tab's gutters
      // differ from every other one the moment it has nothing in it.
      <div className={cn(PORTAL_LIST_PAGE_BODY, PORTAL_LIST_ADD_ROW_WRAP_CLASS)}>{teamListAddRow}</div>
    )
  ) : (
    <div className={PORTAL_LIST_PAGE_BODY} data-attr="co-manager-unified-view">
      <div className={INBOX_LIST_SCROLL}>
        {teamEntries.map((entry) => (
          <PortalPersonRecordRow
            key={entry.id}
            name={entry.name}
            subtitle={`${entry.axisId} · ${entry.preview}`}
            checked={selectedIds.has(entry.id)}
            onSelectedChange={() => toggleSelected(entry.id)}
            onOpen={() => openTeamDetail(entry.id)}
            dataAttr="team-list-row"
          />
        ))}
      </div>
      <div className={PORTAL_LIST_ADD_ROW_WRAP_CLASS}>{teamListAddRow}</div>
    </div>
  );

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
          {renderDetailBody(routeEntry)}
        </PortalRecordDetailPage>
        {detailPropertiesEditable && selectedDetailPropertyIds.size > 0 ? (
          <BulkActionBar count={selectedDetailPropertyIds.size} hideCount variant="payments">
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
          </BulkActionBar>
        ) : null}
      </>
    );
  }

  return (
    <ManagerPortalPageShell
      title="Teams"
      hideTitleOnMobileNav
      compactFilterRow
    >
      <PortalListControlStack
        className="mb-2 max-lg:mb-1.5"
        variant="command"
        actions={
          <>
            {teamFilterSheet}
            {teamLinkButton}
          </>
        }
        activeFilterChips={teamActiveFilterChips}
      />
      <div className="space-y-4">
        {teamListAlerts}
        {teamListBody}
      </div>
      {selectedIds.size > 0 ? (
        <BulkActionBar count={selectedIds.size} hideCount variant="payments">
          <Button
            type="button"
            variant="outline"
            className={`${PORTAL_BULK_BAR_BTN} text-rose-800`}
            data-attr="team-bulk-remove"
            disabled={teamRemoveBusy}
            onClick={() => bulkRemoveSelected()}
          >
            Remove
          </Button>
        </BulkActionBar>
      ) : null}
      {teamModals}
    </ManagerPortalPageShell>
  );
}
