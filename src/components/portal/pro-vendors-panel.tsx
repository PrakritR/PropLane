"use client";
import { PortalRecordListSurface } from "@/components/portal/portal-record-list-surface";

import { PortalPrimaryIconAction } from "@/components/portal/portal-icon-action";
import { portalEmptyCopy, portalEmptyNoMatchTitle } from "@/lib/portal-empty-copy";
import { matchesPortalListSearch } from "@/lib/portal-list-search";
import { formatSmsPhoneLabel } from "@/lib/phone-e164";

import { ArrowUpRight, FileCheck2, Mail, MapPin, MessageSquare, Phone, ShieldCheck, Star, UserRound, Wrench } from "lucide-react";
import { Modal, ModalFooter } from "@/components/ui/modal";
import { PortalFilterSortSheet, portalFilterActiveCount } from "@/components/portal/portal-filter-sort-sheet";
import { VendorListFilterFields } from "@/components/portal/vendor-list-filter-fields";
import { VendorServicesPanel } from "@/components/portal/vendor-services-panel";
import { PortalGroupedRecordList } from "@/components/portal/portal-grouped-record-list";
import {
  VENDOR_OTHER_CATEGORY,
  vendorCategories,
  vendorCategoryOptions,
  vendorGroupCategory,
  vendorMatchesCategories,
} from "@/lib/vendor-category";
import { getSettingsEntryPoint } from "@/components/portal/settings-entry-points";

import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useState } from "react";
import {
  ManagerPortalPageShell,
} from "@/components/portal/portal-metrics";
import { Button } from "@/components/ui/button";
import { useAppUi } from "@/components/providers/app-ui-provider";
import { useManagerUserId } from "@/hooks/use-manager-user-id";
import { usePortalRowSelection } from "@/hooks/use-portal-row-selection";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { PortalAdaptiveActionRow } from "@/components/portal/portal-adaptive-action-row";
import { PORTAL_BULK_BAR_BTN } from "@/lib/portal-bulk-bar";
import type { PortalAdaptiveAction } from "@/lib/portal-adaptive-actions";
import { collectLinkedOwnerIdsForModule } from "@/lib/manager-portfolio-access";
import { useWorkspaces } from "@/components/portal/workspace-provider";
import { assignedIdsInWorkspace } from "@/lib/workspaces/team-scope";
import {
  MANAGER_VENDORS_EVENT,
  readOwnManagerVendorRows,
  syncManagerVendorsFromServer,
  syncManagerVendorsFromServerDetailed,
  deleteManagerVendorRow,
  type ManagerVendorRow,
} from "@/lib/manager-vendors-storage";
import {
  deliverManagerDirectoryMessage,
  deliverManagerVendorInvite,
  fetchManagerVendorInviteDraft,
  fetchManagerVendorRemovalDraft,
  type ManagerVendorInvitePreview,
  type ManagerVendorRemovalPreview,
} from "@/lib/manager-vendor-invite-client";
import { ManagerSettingsGear } from "@/components/portal/manager-settings-gear";
import { ManagerVendorFormModal } from "@/components/portal/pro-vendor-form-modal";
import {
  PortalNotificationPreviewModal,
  type NotificationConfirmDraft,
  type NotificationDeliveryChannels,
} from "@/components/portal/portal-notification-preview-modal";
import { PortalBulkMessageCarouselModal, type BulkMessageCarouselItem } from "@/components/portal/portal-bulk-message-carousel-modal";
import { ManagerVendorDetail, type VendorDetailTab } from "@/components/portal/pro-vendor-detail";
import type { ManagerVendorSummary } from "@/lib/manager-vendor-summary.server";
import { loadManagerVendorSummary } from "@/lib/manager-vendor-summary-client";
import { usePaidPortalBasePath } from "@/lib/portal-base-path-client";
import { PortalRecordSectionChrome, PortalRecordHeaderIconActions } from "@/components/portal/portal-record-section-chrome";
import { PortalRecordDetailPage, PortalRecordActions } from "@/components/portal/portal-record-detail-page";
import { ManagerVendorCatalogDetail } from "@/components/portal/pro-vendor-catalog-detail";
import { RecordCommunicationSection } from "@/components/portal/record-communication-section";
import { recordSections } from "@/lib/portals/record-sections";
import { renderRecordSection } from "@/components/portal/record-section-renderers";
import { ensureCatalogVendorOnRoster } from "@/lib/catalog-vendor-roster";
import {
  personRecordNeedsYouItems,
} from "@/lib/person-record-actions";
import { type AxisCatalogVendor } from "@/lib/axis-vendor-catalog";
import { catalogVendorMatchesTradeArea, listManagerCatalogVendors } from "@/lib/vendor-catalog-list";
import { RecordActionContext } from "@/components/ui/record-action-context";
import { PortalPropertyRecordRow } from "@/components/portal/portal-record-row";
import { findRosterCatalogMatch } from "@/lib/manager-vendor-typical-rates";
import {
  parseVendorDetailTab,
  parseVendorDirectoryTab,
  vendorCatalogDetailHref,
  vendorDetailHref,
  vendorListHref,
} from "@/lib/portal-detail-routes";
import { usePortalNavigate } from "@/lib/portal-nav-client";
import { useSearchParams } from "next/navigation";
import { PortalListControlStack } from "@/components/portal/portal-list-control-stack";
import { PortalListEmptyCard } from "@/components/portal/portal-list-empty-card";
import { PortalDataTableEmpty, PORTAL_DETAIL_BTN, PortalTableDetailActions } from "@/components/portal/portal-data-table";
import { PORTAL_LIST_PAGE_BODY } from "@/components/portal/portal-inbox-ui";
import { PortalApplicantRecordRow, PortalRowFact } from "@/components/portal/portal-record-row";

/** Stable empty list so a missing workspace never changes a memo dependency each render. */
const NO_WORKSPACE_PROPERTY_IDS: string[] = [];

const vendorsSettingsEntry = getSettingsEntryPoint("vendors");

export type ManagerVendorsPanelHandle = {
  openCatalog: () => void;
  openAddVendor: (trade?: string) => void;
};

/** Defaults gear links to Settings → Automations → Vendors; "Add vendor" is the bar's filled primary.
 *  Catalog lives in the Add vendor workspace (Who can handle), not a second modal. */
export function ManagerVendorsToolbar() {
  return <ManagerSettingsGear target="vendors" label={vendorsSettingsEntry.label} dataAttr={vendorsSettingsEntry.dataAttr} />;
}

/**
 * The number the manager texted a service link to, while the roster row still
 * has no phone of its own. It is the manager's own typing shown back to them -
 * never identity: a forwarded link means the redeemer may be someone else, so
 * `rosterPhoneIdentifiesVendor` keeps it out of every routing and sending path.
 */
function vendorLinkPhoneFact(row: ManagerVendorRow): string | undefined {
  if (row.phone?.trim()) return undefined;
  const label = formatSmsPhoneLabel(row.linkPhone);
  return label ? `Texted to ${label}` : undefined;
}

function vendorRowMeta(row: ManagerVendorRow): string | undefined {
  if (row.active === false) return "Inactive";
  if (row.vendorPriority === "primary") return "Primary";
  if (row.vendorPriority === "secondary") return "Secondary";
  return undefined;
}

export const ManagerVendorsPanel = forwardRef(function ManagerVendorsPanel(
  {
    embedded = false,
    bare = false,
    vendorId: vendorIdProp,
    vendorTab: vendorTabProp,
    listBasePath,
  }: {
    /** When true, render inside Services tab shell (no duplicate page header). */
    embedded?: boolean;
    /** Inside Settings → Vendors: no page shell at all. */
    bare?: boolean;
    vendorId?: string;
    vendorTab?: string;
    listBasePath?: string;
  },
  ref: React.Ref<ManagerVendorsPanelHandle>,
) {
  const { showToast } = useAppUi();
  const navigate = usePortalNavigate();
  const searchParams = useSearchParams();
  const portalBase = usePaidPortalBasePath();
  const basePath = listBasePath ?? portalBase;
  const { userId, ready: authReady } = useManagerUserId();
  const workspaces = useWorkspaces();
  const workspacePropertyIds = workspaces?.active?.propertyIds ?? NO_WORKSPACE_PROPERTY_IDS;
  const [tick, setTick] = useState(0);
  const { selectedIds, toggleSelected, clearSelection } = usePortalRowSelection();
  const [invitePreview, setInvitePreview] = useState<ManagerVendorInvitePreview | null>(null);
  const [invitePreviewBusy, setInvitePreviewBusy] = useState(false);
  const [removePreview, setRemovePreview] = useState<ManagerVendorRemovalPreview[] | null>(null);
  const [removePreviewBusy, setRemovePreviewBusy] = useState(false);
  const [vendorFormOpen, setVendorFormOpen] = useState(false);
  const [vendorFormMode, setVendorFormMode] = useState<"add" | "edit">("add");
  const [editingVendor, setEditingVendor] = useState<ManagerVendorRow | null>(null);
  const [addTrade, setAddTrade] = useState<string | undefined>(undefined);
  const [catalogSeed, setCatalogSeed] = useState<AxisCatalogVendor | null>(null);
  const [catalogComposeOpen, setCatalogComposeOpen] = useState(false);
  const [listLoading, setListLoading] = useState(true);
  const [listError, setListError] = useState(false);
  const [vendorSearch, setVendorSearch] = useState("");
  const [directoryVendors, setDirectoryVendors] = useState<AxisCatalogVendor[]>([]);
  // Category (the vendor's trade) narrows both tabs; Area and Rating narrow the PropLane directory.
  const [vendorCategoryFilter, setVendorCategoryFilter] = useState<string[]>([]);
  const [directoryAreaFilter, setDirectoryAreaFilter] = useState("");
  const [directoryMinRatingFilter, setDirectoryMinRatingFilter] = useState("");
  const [addingDirectoryId, setAddingDirectoryId] = useState<string | null>(null);
  // C272: "Add to your vendors" grants the directory vendor visibility into
  // this workspace's service requests — a confirm step names that before the
  // grant, rather than a silent one-click add.
  const [pendingDirectoryAdd, setPendingDirectoryAdd] = useState<AxisCatalogVendor | null>(null);

  const directoryTab = parseVendorDirectoryTab(searchParams?.get("tab"));
  const catalogDetailId = searchParams?.get("catalog")?.trim() || null;
  const catalogDetailTab = parseVendorDetailTab(searchParams?.get("detailTab"));

  useEffect(() => {
    if (!authReady) return;
    let cancelled = false;
    setListLoading(true);
    setListError(false);
    void (async () => {
      try {
        // One network round trip, not two: this used to fire a throwaway
        // fetch just to check res.ok, then a second independent fetch (via
        // syncManagerVendorsFromServer) to actually load the data — the same
        // GET /api/portal-vendors, back to back (Night QA finding #6: 5-9s
        // stuck on "Loading records…"). syncManagerVendorsFromServerDetailed
        // does the one fetch this page needs and reports whether it succeeded.
        const { ok } = await syncManagerVendorsFromServerDetailed({ force: true });
        if (!cancelled) setListError(!ok);
      } catch {
        if (!cancelled) setListError(true);
      } finally {
        if (!cancelled) setListLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [authReady, userId]);

  useEffect(() => {
    const onChange = () => setTick((n) => n + 1);
    window.addEventListener(MANAGER_VENDORS_EVENT, onChange);
    return () => window.removeEventListener(MANAGER_VENDORS_EVENT, onChange);
  }, []);

  // Directory-listed self-serve vendors, merged into the "PropLane vendors" tab
  // alongside the curated catalog — every directory vendor, filterable by category/area/rating (Filter popover).
  useEffect(() => {
    if (!authReady) return;
    let cancelled = false;
    const params = new URLSearchParams();
    if (directoryAreaFilter.trim()) params.set("area", directoryAreaFilter.trim());
    if (directoryMinRatingFilter) params.set("minRating", directoryMinRatingFilter);
    void fetch(`/api/manager/vendor-directory?${params.toString()}`, { credentials: "include" })
      .then((r) => r.json())
      .then((data: { rows?: AxisCatalogVendor[] }) => {
        if (!cancelled) setDirectoryVendors(data.rows ?? []);
      })
      .catch(() => {
        if (!cancelled) setDirectoryVendors([]);
      });
    return () => {
      cancelled = true;
    };
  }, [authReady, directoryAreaFilter, directoryMinRatingFilter, tick]);

  const addDirectoryVendorToRoster = useCallback(
    async (row: AxisCatalogVendor) => {
      const vendorUserId = row.directoryVendorUserId;
      if (!vendorUserId) return;
      setAddingDirectoryId(vendorUserId);
      try {
        const res = await fetch("/api/manager/vendor-directory/add", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({ vendorUserId }),
        });
        const data = (await res.json()) as { error?: string };
        if (!res.ok) throw new Error(data.error ?? "Could not add vendor.");
        await syncManagerVendorsFromServer({ force: true });
        setTick((n) => n + 1);
        showToast(`${row.name} added to your vendors.`);
      } catch (e) {
        showToast(e instanceof Error ? e.message : "Could not add vendor.");
      } finally {
        setAddingDirectoryId(null);
      }
    },
    [showToast],
  );

  const confirmAddDirectoryVendor = useCallback(() => {
    if (!pendingDirectoryAdd) return;
    const row = pendingDirectoryAdd;
    setPendingDirectoryAdd(null);
    void addDirectoryVendorToRoster(row);
  }, [addDirectoryVendorToRoster, pendingDirectoryAdd]);

  const vendors = useMemo(() => {
    void tick;
    const rows = readOwnManagerVendorRows(userId, undefined, {
      includeOwnerIds: collectLinkedOwnerIdsForModule(userId ?? "", "services"),
    }).sort((a, b) => a.name.localeCompare(b.name));
    if (!bare) return rows;
    return rows.filter(
      (row) => assignedIdsInWorkspace(row.propertyIds ?? [], workspacePropertyIds).length > 0,
    );
  }, [tick, userId, bare, workspacePropertyIds]);

  // Review aggregates (★ average · count) for the vendors on screen, one batched
  // request rather than one per row (see /api/portal/vendor-reviews/aggregates).
  const [reviewAggregatesByVendorUserId, setReviewAggregatesByVendorUserId] = useState<
    Record<string, { average: number | null; count: number }>
  >({});
  useEffect(() => {
    const vendorUserIds = [...new Set(vendors.map((v) => v.vendorUserId).filter((id): id is string => Boolean(id)))];
    if (vendorUserIds.length === 0) {
      // Keep the same object when already empty — a fresh {} each run re-renders forever.
      setReviewAggregatesByVendorUserId((prev) => (Object.keys(prev).length === 0 ? prev : {}));
      return;
    }
    let cancelled = false;
    fetch(`/api/portal/vendor-reviews/aggregates?vendorUserIds=${encodeURIComponent(vendorUserIds.join(","))}`)
      .then((res) => res.json())
      .then((data: { aggregates?: Record<string, { average: number | null; count: number }> }) => {
        if (!cancelled) setReviewAggregatesByVendorUserId(data.aggregates ?? {});
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [vendors]);

  // The figure on the right of a roster row ("8 services"): this workspace's services assigned to
  // that vendor. One request for the whole list, from the same choices feed the Outgoing bill picker uses.
  const [serviceCountByVendorUserId, setServiceCountByVendorUserId] = useState<Record<string, number>>({});
  useEffect(() => {
    if (bare || !userId) return;
    let cancelled = false;
    fetch("/api/manager/vendor-invoices?choices=1")
      .then((res) => res.json())
      .then((data: { services?: Array<{ vendorUserId?: string | null }> }) => {
        if (cancelled) return;
        const counts: Record<string, number> = {};
        for (const service of data.services ?? []) {
          const id = service.vendorUserId?.trim();
          if (id) counts[id] = (counts[id] ?? 0) + 1;
        }
        setServiceCountByVendorUserId(counts);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [bare, userId]);

  // The search box narrows the current tab only; the tab counts stay the totals.
  const visibleVendors = useMemo(
    () =>
      vendors.filter(
        (row) =>
          vendorMatchesCategories(row, vendorCategoryFilter) &&
          matchesPortalListSearch(
            vendorSearch,
            row.name,
            row.trade,
            ...(row.trades ?? []),
            row.email,
            row.phone,
            row.notes,
            vendorRowMeta(row),
          ),
      ),
    [vendors, vendorSearch, vendorCategoryFilter],
  );

  const routeVendorId = vendorIdProp?.trim() || null;
  const routeVendor = useMemo(() => {
    if (!routeVendorId) return null;
    return vendors.find((row) => row.id === routeVendorId) ?? null;
  }, [routeVendorId, vendors]);

  // C080/PLAN item 3a: live counts for the open vendor's Services/Invoices/Reviews
  // tabs, so an empty tab can be hidden from the record chrome below. The
  // summary fetch is coalesced+cached (manager-vendor-summary-client.ts), so
  // this doesn't duplicate the network call ManagerVendorDetail makes for the
  // same vendor — both resolve the same in-flight/cached request.
  const [routeVendorSummary, setRouteVendorSummary] = useState<ManagerVendorSummary | null>(null);
  const [routeVendorSummaryState, setRouteVendorSummaryState] = useState<"idle" | "loading" | "ready" | "error">("idle");
  useEffect(() => {
    if (!routeVendor || !userId) {
      setRouteVendorSummary(null);
      setRouteVendorSummaryState("idle");
      return;
    }
    let cancelled = false;
    setRouteVendorSummaryState("loading");
    loadManagerVendorSummary(userId, routeVendor.id)
      .then((next) => {
        if (cancelled) return;
        setRouteVendorSummary(next);
        setRouteVendorSummaryState("ready");
      })
      .catch(() => {
        if (!cancelled) setRouteVendorSummaryState("error");
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [routeVendor?.id, userId]);


  const openAddVendorForm = useCallback((trade?: string, fromCatalog?: AxisCatalogVendor | null) => {
    setVendorFormMode("add");
    setEditingVendor(null);
    setAddTrade(trade);
    setCatalogSeed(fromCatalog ?? null);
    setVendorFormOpen(true);
  }, []);

  const openEditVendorForm = useCallback((row: ManagerVendorRow) => {
    setVendorFormMode("edit");
    setEditingVendor(row);
    setAddTrade(undefined);
    setCatalogSeed(null);
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
      openCatalog: openAddVendorForm,
      openAddVendor: openAddVendorForm,
    }),
    [openAddVendorForm],
  );

  function deleteVendorQuiet(id: string): boolean {
    if (!deleteManagerVendorRow(id, userId)) return false;
    if (routeVendorId === id) navigateToList();
    return true;
  }

  const openVendorRemovePreview = useCallback(
    async (rows: ManagerVendorRow[]) => {
      if (rows.length === 0) return;
      setRemovePreviewBusy(true);
      try {
        const results = await Promise.all(
          rows.map(async (row) => {
            const result = await fetchManagerVendorRemovalDraft({
              vendorId: row.id,
              vendorName: row.name,
              vendorEmail: row.email,
              vendorPhone: row.phone,
            });
            return { row, result };
          }),
        );
        const failed = results.find((entry) => !entry.result.ok);
        if (failed && !failed.result.ok) {
          showToast(failed.result.error);
          return;
        }
        const previews = results
          .map((entry) => (entry.result.ok ? entry.result.preview : null))
          .filter(Boolean) as ManagerVendorRemovalPreview[];
        if (previews.length === 0) return;
        setRemovePreview(previews);
      } finally {
        setRemovePreviewBusy(false);
      }
    },
    [showToast],
  );

  const confirmVendorRemove = useCallback(
    async (
      skipMessage: boolean,
      channels?: NotificationDeliveryChannels,
      messageDraft?: NotificationConfirmDraft,
      opts?: {
        scope?: "all" | "single";
        singleId?: string;
        drafts?: Record<string, { subject: string; body: string }>;
      },
    ) => {
      if (!removePreview || removePreviewBusy) return;
      const scope = opts?.scope ?? "all";
      const targetPreviews =
        scope === "single" && opts?.singleId
          ? removePreview.filter((preview) => preview.vendorId === opts.singleId)
          : removePreview;
      if (targetPreviews.length === 0) return;

      setRemovePreviewBusy(true);
      try {
        const processedIds = new Set<string>();
        for (const preview of targetPreviews) {
          const fromCarousel = opts?.drafts?.[preview.vendorId];
          const rowDraft = fromCarousel
            ? { subject: fromCarousel.subject, body: fromCarousel.body }
            : messageDraft;
          if (!skipMessage && preview.email?.includes("@")) {
            const result = await deliverManagerDirectoryMessage(preview, false, channels, rowDraft);
            if (!result.ok) {
              showToast(result.message);
              const remaining = removePreview.filter((item) => !processedIds.has(item.vendorId));
              if (remaining.length > 0) setRemovePreview(remaining);
              return;
            }
          }
          if (!deleteVendorQuiet(preview.vendorId)) {
            showToast("Could not remove vendor.");
            const remaining = removePreview.filter((item) => !processedIds.has(item.vendorId));
            if (remaining.length > 0) setRemovePreview(remaining);
            return;
          }
          processedIds.add(preview.vendorId);
        }
        setRemovePreview(null);
        if (scope === "all") {
          clearSelection();
        } else if (opts?.singleId) {
          toggleSelected(opts.singleId);
        }
        const count = targetPreviews.length;
        showToast(
          skipMessage
            ? count === 1
              ? "Vendor removed."
              : `${count} vendors removed.`
            : count === 1
              ? "Vendor removed and notified."
              : `${count} vendors removed and notified.`,
        );
      } finally {
        setRemovePreviewBusy(false);
      }
    },
    [clearSelection, removePreview, removePreviewBusy, showToast, toggleSelected, userId],
  );

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

  const retryVendors = useCallback(() => {
    if (!authReady) return;
    setListLoading(true);
    setListError(false);
    void (async () => {
      try {
        const res = await fetch("/api/portal-vendors", { credentials: "include" });
        if (!res.ok) throw new Error("load");
        await syncManagerVendorsFromServer({ force: true });
        setListError(false);
      } catch {
        setListError(true);
      } finally {
        setListLoading(false);
      }
    })();
  }, [authReady]);

  const vendorDangerBtnClass = `${PORTAL_DETAIL_BTN} border-rose-200 text-rose-800 hover:bg-[var(--status-overdue-bg)] portal-danger-outline`;

  const renderVendorHeaderActions = (row: ManagerVendorRow) => (
    <PortalTableDetailActions>
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
        onClick={() => void openVendorRemovePreview([row])}
        data-attr="vendor-remove"
      >
        Remove
      </Button>
    </PortalTableDetailActions>
  );

  const modals = (
    <>
      <Modal
        open={pendingDirectoryAdd !== null}
        onClose={() => setPendingDirectoryAdd(null)}
        title="Add to your vendors"
        footer={
          <ModalFooter>
            <Button
              type="button"
              data-attr="vendor-directory-add-confirm"
              disabled={addingDirectoryId === pendingDirectoryAdd?.directoryVendorUserId}
              onClick={confirmAddDirectoryVendor}
            >
              Add to your vendors
            </Button>
          </ModalFooter>
        }
      >
        <div className="space-y-4 p-1">
          <p className="text-sm leading-relaxed text-foreground">
            {pendingDirectoryAdd?.name ?? "This vendor"} will be added to your roster and will be able to see
            this workspace&apos;s service requests so they can bid and get assigned jobs.
          </p>
        </div>
      </Modal>
      <ManagerVendorFormModal
        open={vendorFormOpen}
        mode={vendorFormMode}
        vendor={editingVendor}
        initialTrade={addTrade}
        catalogVendor={catalogSeed}
        onBrowseCatalog={() => {
          setVendorFormOpen(false);
          setEditingVendor(null);
          setCatalogSeed(null);
          navigate(vendorListHref(basePath, "catalog"));
        }}
        onOpenExisting={(vendorId) => {
          setVendorFormOpen(false);
          setCatalogSeed(null);
          navigate(vendorDetailHref(basePath, vendorId));
        }}
        onClose={() => {
          setVendorFormOpen(false);
          setEditingVendor(null);
          setAddTrade(undefined);
          setCatalogSeed(null);
        }}
        showToast={showToast}
        onDeleted={() => {
          if (editingVendor && routeVendorId === editingVendor.id) navigateToList();
          setEditingVendor(null);
        }}
      />
      <PortalNotificationPreviewModal
        open={invitePreview !== null}
        title="Send vendor invite — notification preview"
        onClose={() => setInvitePreview(null)}
        recipient={invitePreview?.email ?? ""}
        recipientPhone={invitePreview?.phone ?? ""}
        subject={invitePreview?.subject ?? ""}
        body={invitePreview?.body ?? ""}
        showChannelPicker
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
      {removePreview && removePreview.length === 1 ? (
        <PortalNotificationPreviewModal
          open
          title="Remove vendor — notification preview"
          onClose={() => setRemovePreview(null)}
          recipient={removePreview[0]!.email}
          recipientPhone={removePreview[0]!.phone}
          subject={removePreview[0]!.subject}
          body={removePreview[0]!.body}
          showChannelPicker
          emailAvailable={Boolean(removePreview[0]!.email?.includes("@"))}
          smsAvailable={Boolean(removePreview[0]!.email?.includes("@") && removePreview[0]!.phone?.trim())}
          defaultViaSms={false}
          confirmLabel="Remove & send message"
          confirmLabelWithoutMessage="Remove only"
          skipMessageLabel="Don't message vendor"
          confirmBusy={removePreviewBusy}
          confirmBusyLabel="Removing…"
          cancelLabel="Cancel"
          onConfirm={(skipMessage, channels, messageDraft) =>
            void confirmVendorRemove(skipMessage, channels, messageDraft, {
              scope: "single",
              singleId: removePreview[0]!.vendorId,
            })
          }
        />
      ) : null}
      {removePreview && removePreview.length > 1 ? (
        <PortalBulkMessageCarouselModal
          open
          title={`Remove vendors — notification preview (${removePreview.length})`}
          items={removePreview.map(
            (preview): BulkMessageCarouselItem => ({
              id: preview.vendorId,
              label: preview.name,
              recipient: preview.email || preview.name,
              recipientPhone: preview.phone,
              subject: preview.subject,
              body: preview.body,
              emailAvailable: Boolean(preview.email?.includes("@")),
              smsAvailable: Boolean(preview.email?.includes("@") && preview.phone?.trim()),
            }),
          )}
          confirmLabel="Remove all & send"
          confirmLabelSingle="Remove & send"
          confirmLabelWithoutMessage="Remove without messaging"
          skipMessageLabel="Don't message vendors"
          confirmBusy={removePreviewBusy}
          confirmBusyLabel="Removing…"
          onClose={() => setRemovePreview(null)}
          onConfirm={(scope, { skipMessage, channels, drafts, singleId }) =>
            void confirmVendorRemove(skipMessage, channels, undefined, {
              scope,
              singleId,
              drafts,
            })
          }
        />
      ) : null}
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
    const vendorTab = parseVendorDetailTab(vendorTabProp);
    const ownVendorTab: VendorDetailTab =
      vendorTab === "services" ||
      vendorTab === "invoices" ||
      vendorTab === "pricing" ||
      vendorTab === "reviews" ||
      vendorTab === "overview" ||
      vendorTab === "profile" ||
      vendorTab === "jobs" ||
      vendorTab === "check-ins" ||
      vendorTab === "communication"
        ? vendorTab
        : "overview";
    const baseSections = recordSections("manager", "vendor", { basePath });
    // A vendor who was already invited is re-invited, not invited: the same icon, the honest word.
    const sections = {
      ...baseSections,
      headerActions: baseSections.headerActions
        .map((action) =>
          action.id === "invite" && routeVendor.invitedAt && !routeVendor.vendorUserId
            ? { ...action, label: "Resend invite" }
            : action,
        ),
    };
    const onVendorHeaderAction = (actionId: string) => {
      if (actionId === "message") {
        navigate(vendorDetailHref(basePath, routeVendor.id, "communication"));
        return;
      }
      if (actionId === "edit") {
        setVendorFormMode("edit"); setEditingVendor(routeVendor); setVendorFormOpen(true); return;
      }
      if (actionId === "invite") {
        void openVendorInvitePreview(routeVendor);
        return;
      }
      if (actionId === "remove") {
        void openVendorRemovePreview([routeVendor]);
        return;
      }
      showToast("Coming soon");
    };
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
          iconTitleActions
          pinScrollBody
        >
          <PortalRecordActions>
            <PortalRecordHeaderIconActions actions={sections.headerActions} onAction={onVendorHeaderAction} primaryId="message" />
          </PortalRecordActions>
          <PortalRecordSectionChrome
            sections={sections}
            recordId={routeVendor.id}
            activeId={vendorTab}
            title={routeVendor.name}
            subtitle={routeVendor.trade || undefined}
            backHref={vendorListHref(basePath)}
            backLabel="All vendors"
            ariaLabel="Vendor sections"
            onHeaderAction={onVendorHeaderAction}
          >
            {vendorTab === "documents" || vendorTab === "activity" ? (
              renderRecordSection(vendorTab, {
                role: "manager",
                kind: "vendor",
                kindLabel: "vendor",
                recordId: routeVendor.id,
                recordLabel: routeVendor.name,
              })
            ) : (
              <ManagerVendorDetail
                row={routeVendor}
                managerUserId={userId}
                basePath={basePath}
                onNavigate={navigate}
                tab={ownVendorTab}
                extraNeedsYou={personRecordNeedsYouItems({
                  kind: "vendor",
                  hasPortalUser: Boolean(routeVendor.vendorUserId),
                })}
                onEdit={() => {
                  setVendorFormMode("edit");
                  setEditingVendor(routeVendor);
                  setVendorFormOpen(true);
                }}
              />
            )}
          </PortalRecordSectionChrome>
        </PortalRecordDetailPage>
      </>
    );
  }

  // The trade/area Filter must narrow BOTH sources — the curated catalog and
  // the self-serve directory rows — not just the directory rows the server
  // already pre-filtered by `trade`/`area` query params (proof-bug #2). A
  // rating-floor filter narrows the same way: the server already applied it
  // to the directory rows, but a curated catalog / shared-roster row has no
  // rating at all, so it fails a minimum-rating filter too rather than
  // silently staying visible.
  const minRatingFloor = directoryMinRatingFilter ? Number(directoryMinRatingFilter) : 0;
  const allCatalogRows = [...listManagerCatalogVendors(vendors), ...directoryVendors];
  const catalogRows = allCatalogRows.filter(
    (row) =>
      vendorMatchesCategories(row, vendorCategoryFilter) &&
      catalogVendorMatchesTradeArea(row, "", directoryAreaFilter) &&
      (minRatingFloor <= 0 || (row.rating ?? 0) >= minRatingFloor),
  );
  const visibleCatalogRows = catalogRows.filter((row) =>
    matchesPortalListSearch(vendorSearch, row.name, row.trade, ...(row.trades ?? []), row.city, row.description),
  );
  const noMatchCard = (dataAttr: string, clearDataAttr: string) => (
    <PortalListEmptyCard
      section="vendors"
      title={portalEmptyNoMatchTitle("vendors", vendorSearch)}
      tone="muted"
      clear={{
        label: vendorSearch.trim() ? "Clear search" : "Clear filters",
        onClick: () => {
          setVendorSearch("");
          setVendorCategoryFilter([]);
        },
        dataAttr: clearDataAttr,
      }}
      dataAttr={dataAttr}
    />
  );
  const catalogDetail = catalogDetailId
    ? catalogRows.find((row) => row.catalogId === catalogDetailId) ?? null
    : null;
  const catalogRosterMatch = catalogDetail
    ? findRosterCatalogMatch(vendors, catalogDetail)
    : null;
  const catalogSections = recordSections("manager", "vendorCatalog", { basePath });
  const catalogHeaderActions = catalogRosterMatch
    ? catalogSections.headerActions.map((action) =>
        action.id === "add" ? { id: "open", label: "Open", icon: ArrowUpRight } : action,
      )
    : catalogSections.headerActions;
  const catalogChromeSections = catalogRosterMatch
    ? { ...catalogSections, headerActions: catalogHeaderActions }
    : catalogSections;
  const onCatalogHeaderAction = (actionId: string) => {
    if (actionId === "open") {
      if (catalogRosterMatch) navigate(vendorDetailHref(basePath, catalogRosterMatch.id, "overview"));
      return;
    }
    if (actionId === "add") {
      if (catalogDetail) openAddVendorForm(catalogDetail.trade, catalogDetail);
      return;
    }
    if (actionId === "compose") {
      if (catalogDetailId) {
        setCatalogComposeOpen(true);
        navigate(vendorCatalogDetailHref(basePath, catalogDetailId, "communication"));
      }
      return;
    }
  };

  const catalogDetailPage = catalogDetailId ? (
    <PortalRecordDetailPage
      pageTitle="Vendors"
      title={catalogDetail?.name ?? "PropLane vendor"}
      subtitle={catalogDetail ? [catalogDetail.trade, catalogDetail.city].filter(Boolean).join(" · ") : undefined}
      avatarName={catalogDetail?.name}
      backHref={vendorListHref(basePath, "catalog")}
      backLabel="Back to PropLane vendors"
      hideBackText
      bareHeader
      dataAttrBack="vendor-catalog-back"
      iconTitleActions
      pinScrollBody
    >
      <PortalRecordActions>
        <PortalRecordHeaderIconActions actions={catalogHeaderActions} onAction={onCatalogHeaderAction} />
      </PortalRecordActions>
      <PortalRecordSectionChrome
        sections={catalogChromeSections}
        recordId={catalogDetailId}
        activeId={catalogDetailTab}
        title={catalogDetail?.name ?? "PropLane vendor"}
        subtitle={catalogDetail?.trade}
        backHref={vendorListHref(basePath, "catalog")}
        backLabel="PropLane vendors"
        ariaLabel="Vendor sections"
        onHeaderAction={onCatalogHeaderAction}
      >
        {catalogDetailTab === "communication" && catalogDetail ? (
          <div className="flex min-h-[520px] flex-col px-1 sm:px-2" data-attr="vendor-catalog-communication">
            <RecordCommunicationSection
              fill
              role="manager"
              recordRef={{
                kind: "vendor",
                id: catalogRosterMatch?.id ?? catalogDetail.catalogId,
                label: catalogDetail.name,
              }}
              contactIds={catalogDetail.email ? [catalogDetail.email] : []}
              contactPhone={catalogDetail.phone}
              autoOpenCompose={catalogComposeOpen}
              onEnsureRecord={
                catalogRosterMatch || !userId
                  ? undefined
                  : async () => {
                      if (catalogDetail.directoryVendorUserId) {
                        await addDirectoryVendorToRoster(catalogDetail);
                        const matched = findRosterCatalogMatch(vendors, catalogDetail);
                        if (!matched) return null;
                        return { kind: "vendor", id: matched.id, label: matched.name };
                      }
                      const row = await ensureCatalogVendorOnRoster({
                        userId,
                        catalog: catalogDetail,
                        existing: vendors,
                      });
                      if (!row) return null;
                      return { kind: "vendor", id: row.id, label: row.name };
                    }
              }
            />
          </div>
        ) : catalogDetailTab === "documents" || catalogDetailTab === "activity" ? (
          renderRecordSection(catalogDetailTab, {
            role: "manager",
            kind: "vendor",
            kindLabel: "vendor",
            recordId: catalogRosterMatch?.id ?? catalogDetailId,
            recordLabel: catalogDetail?.name ?? "Vendor",
            contactIds: catalogDetail?.email ? [catalogDetail.email] : [],
          })
        ) : catalogRosterMatch && catalogDetailTab !== "overview" ? (
          <div data-attr="vendor-catalog-matched-profile">
            <ManagerVendorDetail
              row={catalogRosterMatch}
              managerUserId={userId}
              basePath={basePath}
              onNavigate={navigate}
              tab={catalogDetailTab}
              detailHref={(tab) => vendorCatalogDetailHref(basePath, catalogDetailId, tab)}
            />
          </div>
        ) : (
          <ManagerVendorCatalogDetail
            catalogId={catalogDetailId}
            vendor={catalogDetail}
            tab={catalogDetailTab}
            inRoster={Boolean(catalogRosterMatch)}
          />
        )}
      </PortalRecordSectionChrome>
    </PortalRecordDetailPage>
  ) : null;

  if (directoryTab === "catalog" && catalogDetailId) {
    return (
      <>
        {modals}
        {catalogDetailPage}
      </>
    );
  }

  const catalogGroupLabel = (row: AxisCatalogVendor) => vendorGroupCategory(row, vendorCategoryFilter);
  const renderCatalogRow = (row: AxisCatalogVendor) => {
          const existing = findRosterCatalogMatch(vendors, row);
          const isDirectory = Boolean(row.directoryVendorUserId);
          const busy = isDirectory && addingDirectoryId === row.directoryVendorUserId;
          const openProfile = () => navigate(vendorCatalogDetailHref(basePath, row.catalogId));
          const add = () => (isDirectory ? setPendingDirectoryAdd(row) : openAddVendorForm(row.trade, row));
          const tradesLabel = row.trades?.length ? row.trades.join(", ") : row.trade;
          return (
            <RecordActionContext.Provider
              key={row.catalogId}
              value={{
                scope: row.catalogId,
                clear: () => {},
                actions: (
                  <Button
                    type="button"
                    data-attr="vendor-catalog-row-add"
                    disabled={Boolean(existing) || busy}
                    onClick={add}
                  >
                    {existing ? "Added" : busy ? "Adding…" : "Add to your vendors"}
                  </Button>
                ),
              }}
            >
              <PortalPropertyRecordRow
                title={row.name}
                address={row.description}
                facts={
                  isDirectory ? (
                    <>
                      <PortalRowFact icon={Wrench} srLabel="Trades">{tradesLabel || "Not set"}</PortalRowFact>
                      {row.city ? <PortalRowFact icon={MapPin} srLabel="Area">{row.city}</PortalRowFact> : null}
                      {row.insured ? <PortalRowFact icon={ShieldCheck} srLabel="Insured">Insured</PortalRowFact> : null}
                      {row.licensed ? <PortalRowFact icon={FileCheck2} srLabel="Licensed">Licensed</PortalRowFact> : null}
                      {row.reviewCount ? (
                        <PortalRowFact icon={Star} srLabel="Review rating">
                          {`${row.rating?.toFixed(1)} (${row.reviewCount})`}
                        </PortalRowFact>
                      ) : null}
                    </>
                  ) : (
                    <span>{[row.trade, row.city].filter(Boolean).join(" · ")}</span>
                  )
                }
                leading={
                  <div className="flex h-[4.125rem] w-[5.5rem] items-center justify-center rounded-[10px] bg-secondary text-muted max-md:h-[3.125rem] max-md:w-16">
                    <UserRound className="size-6" strokeWidth={1.6} aria-hidden />
                  </div>
                }
                onOpen={openProfile}
                onSelectedChange={() => {}}
                dataAttr="vendor-catalog-row"
              />
            </RecordActionContext.Provider>
          );
  };

  const yoursGroupLabel = (row: ManagerVendorRow) => vendorGroupCategory(row, vendorCategoryFilter);
  const renderYoursRow = (row: ManagerVendorRow, group: { label: string }) => {
          const phone = row.phone.trim();
          const email = row.email.trim();
          const tradeLabel = row.trade.trim() || "Not set";
          const hasTrade = Boolean(row.trade.trim() || row.trades?.length);
          const otherCategories = vendorCategories(row)
            .filter((category) => category !== group.label)
            .join(", ");
          const linkPhoneFact = vendorLinkPhoneFact(row);
          const meta = vendorRowMeta(row);
          const reviewAggregate = row.vendorUserId ? reviewAggregatesByVendorUserId[row.vendorUserId] : undefined;
          const serviceCount = row.vendorUserId ? serviceCountByVendorUserId[row.vendorUserId] ?? 0 : 0;
          const reviewFact =
            reviewAggregate && reviewAggregate.count > 0
              ? `${reviewAggregate.average?.toFixed(1)} (${reviewAggregate.count})`
              : undefined;
          return (
            <PortalApplicantRecordRow
              key={row.id}
              name={row.name}
              // C267: "Not set" is the app's one empty-value word (C254);
              // "—" stays only for the unused count/rating/money state.
              // Under its category header the trade is already said; a vendor who works
              // in more than one category lists the others, and one with no trade says so.
              address={hasTrade ? otherCategories || undefined : tradeLabel}
              facts={
                phone || linkPhoneFact || email || meta || reviewFact ? (
                  <>
                    {phone ? (
                      <PortalRowFact icon={Phone} srLabel="Phone">
                        {phone}
                      </PortalRowFact>
                    ) : null}
                    {linkPhoneFact ? (
                      <PortalRowFact icon={MessageSquare} srLabel="Texted to">
                        {linkPhoneFact}
                      </PortalRowFact>
                    ) : null}
                    {email ? (
                      <PortalRowFact icon={Mail} srLabel="Email">
                        {email}
                      </PortalRowFact>
                    ) : null}
                    {reviewFact ? (
                      <PortalRowFact icon={Star} srLabel="Review rating">
                        {reviewFact}
                      </PortalRowFact>
                    ) : null}
                    {meta ? <span data-attr="vendor-row-meta">{meta}</span> : null}
                  </>
                ) : undefined
              }
              trailing={
                serviceCount > 0 ? (
                  <span data-attr="vendor-row-services">{`${serviceCount} service${serviceCount === 1 ? "" : "s"}`}</span>
                ) : undefined
              }
              checked={selectedIds.has(row.id)}
              onSelectedChange={() => toggleSelected(row.id)}
              onOpen={() => openVendorDetail(row)}
              dataAttr="vendor-list-row"
            />
          );
  };

  const listBody =
    directoryTab === "services" ? (
      <VendorServicesPanel />
    ) : directoryTab === "catalog" && catalogRows.length === 0 ? (
      <PortalListEmptyCard
        section="vendors"
        title={portalEmptyCopy("vendors.catalog").title}
        workspaceAware
        dataAttr="vendors-catalog-empty"
      />
    ) : directoryTab === "catalog" && visibleCatalogRows.length === 0 ? (
      noMatchCard("vendors-catalog-empty", "vendors-catalog-empty-clear-search")
    ) : directoryTab === "catalog" ? (
      <div className={PORTAL_LIST_PAGE_BODY}>
        <PortalGroupedRecordList
          // A different question (category, area, rating) starts the open / closed state over.
          key={`catalog:${vendorCategoryFilter.join(",")}:${directoryAreaFilter}:${directoryMinRatingFilter}`}
          items={visibleCatalogRows}
          groupLabel={catalogGroupLabel}
          otherLabel={VENDOR_OTHER_CATEGORY}
          itemKey={(row) => row.catalogId}
          renderItem={renderCatalogRow}
          listKey="vendors-catalog"
          searchActive={vendorSearch.trim().length > 0}
          dataAttr="vendors-catalog-groups"
        />
      </div>
    ) : vendors.length === 0 ? (
      <PortalListEmptyCard
        section="vendors"
        title={portalEmptyCopy("vendors").title}
        workspaceAware
        actions={
          bare
            ? [{ label: "Open Vendors", href: vendorListHref(basePath), dataAttr: "settings-vendors-empty-open", icon: null }]
            : []
        }
        dataAttr="vendors-empty"
      />
    ) : visibleVendors.length === 0 ? (
      noMatchCard("vendors-empty", "vendors-empty-clear-search")
    ) : (
      <div className={PORTAL_LIST_PAGE_BODY}>
        <PortalGroupedRecordList
          // A different question (category) starts the open / closed state over.
          key={`yours:${vendorCategoryFilter.join(",")}`}
          items={visibleVendors}
          groupLabel={yoursGroupLabel}
          otherLabel={VENDOR_OTHER_CATEGORY}
          itemKey={(row) => row.id}
          renderItem={renderYoursRow}
          listKey="vendors-yours"
          searchActive={vendorSearch.trim().length > 0}
          dataAttr="vendors-yours-groups"
        />
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
      void openVendorRemovePreview(selectedVendors);
    };
    bulkSelectionActions.push({
      id: "delete",
      node: (
        <Button
          type="button"
          variant="outline"
          className={`${PORTAL_BULK_BAR_BTN} text-rose-800`}
          data-attr="vendor-bulk-delete"
          disabled={removePreviewBusy}
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

  const vendorCategoryChoices = vendorCategoryOptions(
    directoryTab === "catalog" ? allCatalogRows : vendors,
    vendorCategoryFilter,
  );
  const vendorFilterSheet = (
    <PortalFilterSortSheet
      activeCount={portalFilterActiveCount([
        vendorCategoryFilter,
        directoryTab === "catalog" ? directoryAreaFilter.trim() : "",
        directoryTab === "catalog" ? directoryMinRatingFilter : "",
      ])}
      compactPanel
      commandStripTrigger
      filterFieldCount={directoryTab === "catalog" ? 3 : 1}
      constrainDropdownToTitleBand={false}
      mobileFlushBody
      onReset={() => {
        setVendorCategoryFilter([]);
        setDirectoryAreaFilter("");
        setDirectoryMinRatingFilter("");
      }}
      dataAttr="vendor-directory-filter-toggle"
    >
      <VendorListFilterFields
        categoryOptions={vendorCategoryChoices}
        categories={vendorCategoryFilter}
        onCategoriesChange={setVendorCategoryFilter}
        directory={directoryTab === "catalog"}
        area={directoryAreaFilter}
        onAreaChange={setDirectoryAreaFilter}
        rating={directoryMinRatingFilter}
        onRatingChange={setDirectoryMinRatingFilter}
      />
    </PortalFilterSortSheet>
  );

  const body = (
    <>
      {modals}
      <PortalRecordListSurface
        className="mt-0"
        onBulkClear={directoryTab === "yours" ? clearSelection : undefined}
        bulkCount={directoryTab === "yours" ? selectedVendors.length : 0}
        bulkActions={directoryTab === "yours" && selectedVendors.length > 0 ? (
        <>
          <PortalAdaptiveActionRow actions={bulkSelectionActions} />
        </>
      ) : null}
        loading={directoryTab === "services" ? false : listLoading}
        loadError={listError && directoryTab !== "services" ? "Couldn’t load vendors" : undefined}
        onRetry={retryVendors}
        isEmpty={false}
        add={undefined}
        dataAttr={directoryTab === "catalog" ? "vendor-catalog-list" : directoryTab === "services" ? "vendor-services-tab-list" : "vendor-your-list"}
      >{listBody}</PortalRecordListSurface>
    </>
  );

  const vendorToolbar = directoryTab === "services" ? undefined : (
    <>
      {vendorFilterSheet}
      <ManagerVendorsToolbar />
    </>
  );
  const vendorSearchControl =
    directoryTab === "services"
      ? undefined
      : { value: vendorSearch, onChange: setVendorSearch, placeholder: "Search vendors", dataAttr: "vendors-search" };

  const vendorDestinations = bare
    ? undefined
    : [
        {
          id: "yours",
          label: "Your vendors",
          href: vendorListHref(basePath, "yours"),
          count: vendors.length,
          dataAttr: "vendors-tab-yours",
        },
        {
          id: "catalog",
          label: "PropLane vendors",
          href: vendorListHref(basePath, "catalog"),
          count: catalogRows.length,
          dataAttr: "vendors-tab-catalog",
        },
        {
          id: "services",
          label: "Vendor services",
          href: vendorListHref(basePath, "services"),
          dataAttr: "vendors-tab-services",
        },
      ];

  const addVendorAction = (
    <PortalPrimaryIconAction label="Add vendor" data-attr="manager-vendor-add-top" onClick={() => openAddVendorForm()} />
  );

  if (bare) {
    return (
      <div className="min-w-0" data-attr="settings-team-vendors">
      <PortalListControlStack
        className="mb-2 max-lg:mb-1.5"
        variant="command"
        destinations={vendorDestinations}
        activeDestinationId={directoryTab}
        destinationAriaLabel="Vendor lists"
        stickyDestinations={false}
        search={vendorSearchControl}
        actions={vendorToolbar}
        primary={bare ? undefined : addVendorAction}
      />
        {body}
      </div>
    );
  }

  return (
    <ManagerPortalPageShell
      title="Vendors"
      hideTitleOnMobileNav
      compactFilterRow
    >
      <PortalListControlStack
        className="mb-2 max-lg:mb-1.5"
        variant="command"
        destinations={vendorDestinations}
        activeDestinationId={directoryTab}
        destinationAriaLabel="Vendor lists"
        search={vendorSearchControl}
        actions={vendorToolbar}
        primary={directoryTab === "services" ? undefined : addVendorAction}
      />
      {body}
    </ManagerPortalPageShell>
  );
});
