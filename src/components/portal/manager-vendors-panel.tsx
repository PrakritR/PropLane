"use client";

import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useState } from "react";
import {
  ManagerPortalPageShell,
  PORTAL_HEADER_PRIMARY_ACTION_BTN_RESPONSIVE,
} from "@/components/portal/portal-metrics";
import { Button } from "@/components/ui/button";
import { useAppUi } from "@/components/providers/app-ui-provider";
import { useManagerUserId } from "@/hooks/use-manager-user-id";
import { usePortalRowSelection } from "@/hooks/use-portal-row-selection";
import { BulkActionBar } from "@/components/ui/bulk-action-bar";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { PortalAdaptiveActionRow } from "@/components/portal/portal-adaptive-action-row";
import { PortalEmptyState } from "@/components/portal/portal-empty-state";
import { PORTAL_BULK_BAR_BTN } from "@/lib/portal-bulk-bar";
import type { PortalAdaptiveAction } from "@/lib/portal-adaptive-actions";
import { collectLinkedOwnerIdsForModule } from "@/lib/manager-portfolio-access";
import {
  MANAGER_VENDORS_EVENT,
  readOwnManagerVendorRows,
  syncManagerVendorsFromServer,
  deleteManagerVendorRow,
  setManagerVendorActive,
  setManagerVendorPriority,
  type ManagerVendorRow,
} from "@/lib/manager-vendors-storage";
import {
  deliverManagerVendorInvite,
  fetchManagerVendorInviteDraft,
  type ManagerVendorInvitePreview,
} from "@/lib/manager-vendor-invite-client";
import { ManagerVendorCatalogModal } from "@/components/portal/manager-vendor-catalog-modal";
import { ManagerVendorDefaultsModal } from "@/components/portal/manager-vendor-defaults-modal";
import { ManagerVendorFormModal } from "@/components/portal/manager-vendor-form-modal";
import {
  PortalNotificationPreviewModal,
  type NotificationConfirmDraft,
  type NotificationDeliveryChannels,
} from "@/components/portal/portal-notification-preview-modal";
import { ManagerVendorDetail, type VendorDetailEditDraft } from "@/components/portal/manager-vendor-detail";
import { usePaidPortalBasePath } from "@/lib/portal-base-path-client";
import { vendorDetailHref, vendorListHref } from "@/lib/portal-detail-routes";
import { usePortalNavigate } from "@/lib/portal-nav-client";
import { PortalListControlStack } from "@/components/portal/portal-list-control-stack";
import { PortalDataTableEmpty, PORTAL_DETAIL_BTN, PortalTableDetailActions } from "@/components/portal/portal-data-table";
import { PortalRecordDetailPage } from "@/components/portal/portal-record-detail-page";
import { PORTAL_LIST_PAGE_BODY } from "@/components/portal/portal-inbox-ui";
import { PortalPersonRecordRow } from "@/components/portal/portal-record-row";

export type ManagerVendorsPanelHandle = {
  openCatalog: () => void;
  openDefaults: (trade?: string) => void;
  openAddVendor: (trade?: string) => void;
};

export function ManagerVendorsToolbar({
  onCatalog,
  onDefaults,
  onAdd,
}: {
  onCatalog: () => void;
  onDefaults: () => void;
  onAdd: () => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button
        type="button"
        variant="outline"
        className={PORTAL_HEADER_PRIMARY_ACTION_BTN_RESPONSIVE}
        onClick={onCatalog}
        data-attr="manager-vendor-catalog-open"
      >
        Vendor catalog
      </Button>
      <Button
        type="button"
        variant="outline"
        className={PORTAL_HEADER_PRIMARY_ACTION_BTN_RESPONSIVE}
        onClick={onDefaults}
        data-attr="manager-vendor-defaults-open"
      >
        Defaults
      </Button>
      <Button
        type="button"
        variant="outline"
        className={PORTAL_HEADER_PRIMARY_ACTION_BTN_RESPONSIVE}
        onClick={onAdd}
        data-attr="manager-vendor-add"
      >
        Add
      </Button>
    </div>
  );
}

function vendorRowMeta(row: ManagerVendorRow): string | undefined {
  if (row.active === false) return "Inactive";
  if (row.vendorPriority === "primary") return "Primary";
  if (row.vendorPriority === "secondary") return "Secondary";
  return undefined;
}

function vendorRowPreview(row: ManagerVendorRow): string {
  return [row.email, row.phone].filter(Boolean).join(" · ") || row.trade || "—";
}

export const ManagerVendorsPanel = forwardRef(function ManagerVendorsPanel(
  {
    embedded = false,
    vendorId: vendorIdProp,
    listBasePath,
  }: {
    /** When true, render inside Services tab shell (no duplicate page header). */
    embedded?: boolean;
    vendorId?: string;
    listBasePath?: string;
  },
  ref: React.Ref<ManagerVendorsPanelHandle>,
) {
  const { showToast } = useAppUi();
  const navigate = usePortalNavigate();
  const portalBase = usePaidPortalBasePath();
  const basePath = listBasePath ?? portalBase;
  const { userId, ready: authReady } = useManagerUserId();
  const [tick, setTick] = useState(0);
  const { selectedIds, toggleSelected, clearSelection } = usePortalRowSelection();
  const [showCatalog, setShowCatalog] = useState(false);
  const [showDefaults, setShowDefaults] = useState(false);
  const [defaultsTrade, setDefaultsTrade] = useState<string | undefined>(undefined);
  const [invitePreview, setInvitePreview] = useState<ManagerVendorInvitePreview | null>(null);
  const [invitePreviewBusy, setInvitePreviewBusy] = useState(false);
  const [vendorFormOpen, setVendorFormOpen] = useState(false);
  const [vendorFormMode, setVendorFormMode] = useState<"add" | "edit">("add");
  const [editingVendor, setEditingVendor] = useState<ManagerVendorRow | null>(null);
  const [addTrade, setAddTrade] = useState<string | undefined>(undefined);
  const [vendorDetailEditing, setVendorDetailEditing] = useState(false);
  const [vendorEditDraft, setVendorEditDraft] = useState<VendorDetailEditDraft | null>(null);

  useEffect(() => {
    if (!authReady) return;
    void syncManagerVendorsFromServer({ force: true });
  }, [authReady, userId]);

  useEffect(() => {
    const onChange = () => setTick((n) => n + 1);
    window.addEventListener(MANAGER_VENDORS_EVENT, onChange);
    return () => window.removeEventListener(MANAGER_VENDORS_EVENT, onChange);
  }, []);

  const vendors = useMemo(() => {
    void tick;
    return readOwnManagerVendorRows(userId, undefined, {
      includeOwnerIds: collectLinkedOwnerIdsForModule(userId ?? "", "services"),
    }).sort((a, b) => a.name.localeCompare(b.name));
  }, [tick, userId]);

  const routeVendorId = vendorIdProp?.trim() || null;
  const routeVendor = useMemo(() => {
    if (!routeVendorId) return null;
    return vendors.find((row) => row.id === routeVendorId) ?? null;
  }, [routeVendorId, vendors]);

  useEffect(() => {
    setVendorDetailEditing(false);
    setVendorEditDraft(null);
  }, [routeVendorId]);

  const openCatalogForm = useCallback(() => {
    setShowCatalog(true);
  }, []);

  const openDefaultsForm = useCallback((trade?: string) => {
    setDefaultsTrade(trade);
    setShowDefaults(true);
  }, []);

  const openAddVendorForm = useCallback((trade?: string) => {
    setVendorFormMode("add");
    setEditingVendor(null);
    setAddTrade(trade);
    setVendorFormOpen(true);
  }, []);

  const openEditVendorForm = useCallback((row: ManagerVendorRow) => {
    setVendorFormMode("edit");
    setEditingVendor(row);
    setAddTrade(undefined);
    setVendorFormOpen(true);
  }, []);

  const navigateToList = useCallback(() => {
    navigate(vendorListHref(basePath));
  }, [basePath, navigate]);

  const openVendorDetail = useCallback(
    (row: ManagerVendorRow) => {
      navigate(vendorDetailHref(basePath, row.id));
    },
    [basePath, navigate],
  );

  useImperativeHandle(
    ref,
    () => ({
      openCatalog: openCatalogForm,
      openDefaults: openDefaultsForm,
      openAddVendor: openAddVendorForm,
    }),
    [openCatalogForm, openDefaultsForm, openAddVendorForm],
  );

  function removeVendor(id: string) {
    if (!deleteManagerVendorRow(id, userId)) return;
    if (routeVendorId === id) navigateToList();
    showToast("Vendor removed.");
  }

  const openVendorInvitePreview = useCallback(
    async (row: ManagerVendorRow) => {
      setInvitePreviewBusy(true);
      const result = await fetchManagerVendorInviteDraft({
        vendorId: row.id,
        vendorName: row.name,
        vendorEmail: row.email,
      });
      setInvitePreviewBusy(false);
      if (!result.ok) {
        showToast(result.error);
        return;
      }
      setInvitePreview({
        ...result.preview,
        phone: row.phone?.trim() ?? "",
      });
    },
    [showToast],
  );

  const confirmVendorInvite = useCallback(
    async (
      skipMessage: boolean,
      channels?: NotificationDeliveryChannels,
      messageDraft?: NotificationConfirmDraft,
    ) => {
      if (!invitePreview || invitePreviewBusy) return;
      setInvitePreviewBusy(true);
      try {
        const result = await deliverManagerVendorInvite(invitePreview, skipMessage, channels, messageDraft);
        if (result.message) {
          showToast(result.message);
        }
        if (result.ok) {
          setInvitePreview(null);
        }
      } finally {
        setInvitePreviewBusy(false);
      }
    },
    [invitePreview, invitePreviewBusy, showToast],
  );

  function updateVendorStatus(row: ManagerVendorRow, active: boolean) {
    setManagerVendorActive(row.id, active, userId);
    showToast(active ? "Vendor marked active." : "Vendor marked inactive.");
  }

  function updateVendorPriority(row: ManagerVendorRow, priority: ManagerVendorRow["vendorPriority"]) {
    setManagerVendorPriority(row.id, priority, userId);
    if (priority === "primary") {
      showToast(`${row.name} is now the primary ${row.trade || "vendor"}.`);
    } else if (priority === "secondary") {
      showToast(`${row.name} marked as secondary.`);
    } else {
      showToast("Priority cleared.");
    }
  }

  function startVendorDetailEdit(row: ManagerVendorRow) {
    setVendorEditDraft({
      active: row.active !== false,
      priority: row.vendorPriority,
    });
    setVendorDetailEditing(true);
  }

  function cancelVendorDetailEdit() {
    setVendorDetailEditing(false);
    setVendorEditDraft(null);
  }

  function saveVendorDetailEdit(row: ManagerVendorRow) {
    if (!vendorEditDraft) {
      cancelVendorDetailEdit();
      return;
    }
    const wasActive = row.active !== false;
    if (vendorEditDraft.active !== wasActive) {
      updateVendorStatus(row, vendorEditDraft.active);
    }
    const prevPriority = row.vendorPriority ?? undefined;
    const nextPriority = vendorEditDraft.priority ?? undefined;
    if (prevPriority !== nextPriority) {
      updateVendorPriority(row, vendorEditDraft.priority);
    }
    cancelVendorDetailEdit();
  }

  const vendorDangerBtnClass = `${PORTAL_DETAIL_BTN} border-rose-200 text-rose-800 hover:bg-[var(--status-overdue-bg)] portal-danger-outline`;

  const renderVendorHeaderActions = (row: ManagerVendorRow) => (
    <PortalTableDetailActions>
      {vendorDetailEditing ? (
        <>
          <Button
            type="button"
            variant="primary"
            className={PORTAL_DETAIL_BTN}
            data-attr="vendor-edit-save"
            onClick={() => saveVendorDetailEdit(row)}
          >
            Save
          </Button>
          <Button
            type="button"
            variant="outline"
            className={PORTAL_DETAIL_BTN}
            data-attr="vendor-edit-cancel"
            onClick={cancelVendorDetailEdit}
          >
            Cancel
          </Button>
        </>
      ) : (
        <Button
          type="button"
          variant="outline"
          className={PORTAL_DETAIL_BTN}
          data-attr="vendor-edit"
          onClick={() => startVendorDetailEdit(row)}
        >
          Edit
        </Button>
      )}
      <Button
        type="button"
        variant="outline"
        className={PORTAL_DETAIL_BTN}
        disabled={invitePreviewBusy}
        onClick={() => void openVendorInvitePreview(row)}
        data-attr="vendor-send-invite"
      >
        {invitePreviewBusy ? "Loading…" : "Send invite"}
      </Button>
      <Button
        type="button"
        variant="outline"
        className={vendorDangerBtnClass}
        onClick={() => removeVendor(row.id)}
        data-attr="vendor-remove"
      >
        Remove
      </Button>
    </PortalTableDetailActions>
  );

  const modals = (
    <>
      <ManagerVendorFormModal
        open={vendorFormOpen}
        mode={vendorFormMode}
        vendor={editingVendor}
        initialTrade={addTrade}
        onClose={() => {
          setVendorFormOpen(false);
          setEditingVendor(null);
          setAddTrade(undefined);
        }}
        showToast={showToast}
        onBrowseCatalog={() => openCatalogForm()}
        onDeleted={() => {
          if (editingVendor && routeVendorId === editingVendor.id) navigateToList();
          setEditingVendor(null);
        }}
      />
      <ManagerVendorCatalogModal open={showCatalog} onClose={() => setShowCatalog(false)} />
      <ManagerVendorDefaultsModal
        open={showDefaults}
        onClose={() => {
          setShowDefaults(false);
          setDefaultsTrade(undefined);
        }}
        initialTrade={defaultsTrade}
        onAddForCategory={(trade) => openAddVendorForm(trade)}
      />
      <PortalNotificationPreviewModal
        open={invitePreview !== null}
        title="Send vendor invite — notification preview"
        onClose={() => setInvitePreview(null)}
        recipient={invitePreview?.email ?? ""}
        recipientPhone={invitePreview?.phone ?? ""}
        subject={invitePreview?.subject ?? ""}
        body={invitePreview?.body ?? ""}
        intro="Review the vendor portal setup message. It explains how to sign up for PropLane, view work orders, and message you."
        showChannelPicker
        showSchedule
        emailAvailable={Boolean(invitePreview?.email?.includes("@"))}
        smsAvailable={Boolean(invitePreview?.phone?.trim())}
        defaultViaSms={false}
        confirmLabel="Send invite"
        skipMessageLabel="Don't message vendor"
        confirmBusy={invitePreviewBusy}
        confirmBusyLabel="Sending…"
        cancelLabel="Cancel"
        onConfirm={(skipMessage, channels, messageDraft) => void confirmVendorInvite(skipMessage, channels, messageDraft)}
      />
    </>
  );

  if (routeVendorId) {
    if (!routeVendor) {
      return (
        <>
          {modals}
          <PortalDataTableEmpty icon="vendor" message="Vendor not found." />
        </>
      );
    }
    return (
      <>
        {modals}
        <PortalRecordDetailPage
          pageTitle="Vendors"
          title={routeVendor.name}
          subtitle={routeVendor.trade || undefined}
          avatarName={routeVendor.name}
          backHref={vendorListHref(basePath)}
          backLabel="Back to vendors"
          hideBackText
          bareHeader
          dataAttrBack="vendor-detail-back"
          inlineActions
          actions={renderVendorHeaderActions(routeVendor)}
        >
          <ManagerVendorDetail
            row={routeVendor}
            editing={vendorDetailEditing}
            draft={vendorEditDraft}
            onDraftChange={setVendorEditDraft}
            onEditDetails={() => openEditVendorForm(routeVendor)}
          />
        </PortalRecordDetailPage>
      </>
    );
  }

  const listBody =
    vendors.length === 0 ? (
      <PortalEmptyState icon="vendor" title="No vendors yet. Add one to get started." />
    ) : (
      <div className={PORTAL_LIST_PAGE_BODY}>
        {vendors.map((row) => (
          <PortalPersonRecordRow
            key={row.id}
            name={row.name}
            subtitle={row.trade || undefined}
            preview={vendorRowPreview(row)}
            meta={vendorRowMeta(row)}
            checked={selectedIds.has(row.id)}
            onSelectedChange={() => toggleSelected(row.id)}
            onOpen={() => openVendorDetail(row)}
            dataAttr="vendor-list-row"
          />
        ))}
      </div>
    );

  const selectedVendors = vendors.filter((row) => selectedIds.has(row.id));

  // Same shape as every other manager list: checkbox selection raises a bar at
  // the bottom-left. Edit is single-selection only because the form edits one
  // record; delete is the bulk action.
  const bulkSelectionActions: PortalAdaptiveAction[] = [];
  if (selectedVendors.length === 1) {
    const only = selectedVendors[0]!;
    const editOne = () => {
      openEditVendorForm(only);
      clearSelection();
    };
    bulkSelectionActions.push({
      id: "edit",
      keepPriority: 4,
      node: (
        <Button
          type="button"
          variant="outline"
          className={PORTAL_BULK_BAR_BTN}
          data-attr="vendor-bulk-edit"
          onClick={editOne}
        >
          Edit
        </Button>
      ),
      menuItem: (
        <DropdownMenuItem data-attr="vendor-bulk-edit" onSelect={editOne}>
          Edit
        </DropdownMenuItem>
      ),
    });
  }
  if (selectedVendors.length > 0) {
    const removeSelected = () => {
      const count = selectedVendors.length;
      if (
        !window.confirm(`Remove ${count} vendor${count === 1 ? "" : "s"}?`)
      ) {
        return;
      }
      for (const row of selectedVendors) removeVendor(row.id);
      clearSelection();
    };
    bulkSelectionActions.push({
      id: "delete",
      node: (
        <Button
          type="button"
          variant="outline"
          className={`${PORTAL_BULK_BAR_BTN} text-rose-800`}
          data-attr="vendor-bulk-delete"
          onClick={removeSelected}
        >
          Remove
        </Button>
      ),
      menuItem: (
        <DropdownMenuItem data-attr="vendor-bulk-delete" onSelect={removeSelected}>
          Remove
        </DropdownMenuItem>
      ),
    });
  }

  const body = (
    <>
      {modals}
      {listBody}
      {selectedVendors.length > 0 ? (
        <BulkActionBar count={selectedVendors.length} hideCount variant="payments">
          <PortalAdaptiveActionRow actions={bulkSelectionActions} />
        </BulkActionBar>
      ) : null}
    </>
  );

  if (embedded) {
    return (
      <ManagerPortalPageShell
        title="Vendors"
        hideTitleOnMobileNav
        titleAside={
          <ManagerVendorsToolbar
            onCatalog={openCatalogForm}
            onDefaults={() => openDefaultsForm()}
            onAdd={() => openAddVendorForm()}
          />
        }
      >
        <PortalListControlStack
          className="mb-2"
        />
        {body}
      </ManagerPortalPageShell>
    );
  }

  return (
    <ManagerPortalPageShell
      title="Vendors"
      titleAside={
        <ManagerVendorsToolbar
          onCatalog={openCatalogForm}
          onDefaults={() => openDefaultsForm()}
          onAdd={() => openAddVendorForm()}
        />
      }
    >
      {body}
    </ManagerPortalPageShell>
  );
});
