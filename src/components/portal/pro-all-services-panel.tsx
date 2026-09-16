"use client";

import { useEffect, useMemo, useState, type ComponentProps, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { usePortalNavigate } from "@/lib/portal-nav-client";
import { PortalServiceRecordRow } from "@/components/portal/portal-record-row";
import { LocalDestinationNav } from "@/components/ui/destination-nav";
import {
  buildUnifiedServiceRows,
  countServiceRowsByState,
  type ServiceRowState,
} from "@/lib/unified-service-rows";

/** The four states the merged list filters by, in the order a manager works through them. */
const SERVICE_STATE_TABS: { id: ServiceRowState; label: string }[] = [
  { id: "open", label: "Open" },
  { id: "scheduled", label: "Scheduled" },
  { id: "done", label: "Done" },
  { id: "declined", label: "Declined" },
];
import { ApplicationHouseholdCluster } from "@/components/portal/application-household-list";
import { PortalRecordListSurface } from "@/components/portal/portal-record-list-surface";
import { PortalListGroupFilterFields } from "@/components/portal/portal-list-group-filter-fields";
import {
  PortalAdaptiveActionRow,
  type PortalAdaptiveAction,
} from "@/components/portal/portal-adaptive-action-row";
import {
  clusterPortalListRows,
  isPropertyClusterList,
  DEFAULT_PORTAL_LIST_GROUP_MODE,
  type PortalListGroupMode,
} from "@/lib/portal-list-grouping";
import { PORTAL_BULK_BAR_BTN } from "@/lib/portal-bulk-bar";
import {
  serviceRequestDetailHref,
  serviceRequestListHref,
} from "@/lib/portal-detail-routes";
import { PortalFilterSortSheet, portalFilterActiveCount } from "@/components/portal/portal-filter-sort-sheet";
import { PORTAL_PROPERTY_FILTER_SHEET_CLASS } from "@/components/portal/portal-filter-shell";
import { PortalListControlStack } from "@/components/portal/portal-list-control-stack";
import { ManagerPortalPageShell } from "@/components/portal/portal-metrics";
import { PortalIconAction, PortalPrimaryIconAction } from "@/components/portal/portal-icon-action";
import { portalEmptyCopy, portalEmptyNoMatchTitle, portalEmptySibling, type PortalEmptyCopyKey } from "@/lib/portal-empty-copy";
import { Settings2 } from "lucide-react";
import { PortalActiveFilterChips, type PortalActiveFilterChip } from "@/components/portal/portal-filter-chips";
import { PortalRecordDetailPage } from "@/components/portal/portal-record-detail-page";
import { useManagerUserId } from "@/hooks/use-manager-user-id";
import {
  buildManagerPropertyFilterOptions,
  moduleRowVisibleToPortalUser,
  samePropertyId,
} from "@/lib/manager-portfolio-access";
import { syncPropertyPipelineFromServer } from "@/lib/demo-property-pipeline";
import {
  deleteManagerWorkOrderRow,
  readManagerWorkOrderRows,
  syncManagerWorkOrdersFromServer,
  MANAGER_WORK_ORDERS_EVENT,
} from "@/lib/manager-work-orders-storage";
import {
  deleteServiceRequest,
  readAllServiceRequests,
  syncServiceRequestsFromServer,
  SERVICE_REQUESTS_EVENT,
  type ServiceRequest,
} from "@/lib/service-requests-storage";
import { ConfirmDeleteModal } from "@/components/portal/confirm-delete-modal";
import type { DemoManagerWorkOrderRow, ManagerWorkOrderBucket } from "@/data/demo-portal";
import { ManagerWorkOrdersPanel } from "@/components/portal/pro-work-orders-panel";
import {
  ManagerServiceRequestDetail,
  managerServiceRequestBucket,
  type ManagerServiceRequestBucket,
} from "@/components/portal/pro-service-request-detail";
import { ManagerAddServiceModal } from "@/components/portal/pro-add-service-modal";
import { ManagerEditServiceRequestsModal } from "@/components/portal/pro-edit-service-requests-modal";
import { ManagerPortalSettingsModal } from "@/components/portal/pro-portal-settings-modal";
import {
  getSettingsEntryPoint,
  settingsDialogTitlePrefix,
} from "@/components/portal/settings-entry-points";
import { ScheduleServiceVisitModal } from "@/components/portal/schedule-service-visit-modal";
import { formatServiceVisitLabel } from "@/lib/schedule-service-visit";
import { EditServiceWorkOrderModal } from "@/components/portal/edit-service-work-order-modal";
import { useAppUi } from "@/components/providers/app-ui-provider";
import { Button } from "@/components/ui/button";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { usePortalRowSelection } from "@/hooks/use-portal-row-selection";
import { useShallowTabId } from "@/components/ui/tabs";

type FilterType = "requests" | "work-orders";

type RequestBucket = ManagerServiceRequestBucket;

const SERVICES_TAB_IDS = ["requests", "work-orders"] as const;

const servicesSettingsEntry = getSettingsEntryPoint("services");

function unifiedServiceRowKey(row: { kind: string; id: string }): string {
  return `${row.kind}::${row.id}`;
}

export function ManagerAllServicesPanel({
  tabId: serverTabId,
  basePath,
  requestBucket: requestBucketProp = "pending",
  workOrderBucket: workOrderBucketProp = "open",
  serviceRequestId: serviceRequestIdProp,
  workOrderId: workOrderIdProp,
}: {
  tabId: FilterType;
  basePath: string;
  requestBucket?: RequestBucket;
  workOrderBucket?: ManagerWorkOrderBucket;
  serviceRequestId?: string;
  workOrderId?: string;
}) {
  const tabId = useShallowTabId<FilterType>(serverTabId, SERVICES_TAB_IDS);
  const router = useRouter();
  const navigate = usePortalNavigate();
  const { showToast } = useAppUi();
  const { userId, ready: authReady } = useManagerUserId();
  const [propertyTick, setPropertyTick] = useState(0);
  const [dataTick, setDataTick] = useState(0);
  /** Approve / Deny / Edit / Delete, published by the detail and docked below it. */
  const [detailFooterActions, setDetailFooterActions] = useState<ReactNode | null>(null);
  const [propertyFilters, setPropertyFilters] = useState<string[]>([]);
  /** Resident emails (lower-cased); one at a time, like the property scope. */
  const [residentFilters, setResidentFilters] = useState<string[]>([]);
  const [groupMode, setGroupMode] = useState<PortalListGroupMode>(DEFAULT_PORTAL_LIST_GROUP_MODE);
  const [woBucket, setWoBucket] = useState<ManagerWorkOrderBucket>(workOrderBucketProp);
  const [prevWoBucketProp, setPrevWoBucketProp] = useState(workOrderBucketProp);
  if (workOrderBucketProp !== prevWoBucketProp) {
    setPrevWoBucketProp(workOrderBucketProp);
    if (woBucket !== workOrderBucketProp) setWoBucket(workOrderBucketProp);
  }
  const [reqBucket, setReqBucket] = useState<RequestBucket>(requestBucketProp);
  const [prevReqBucketProp, setPrevReqBucketProp] = useState(requestBucketProp);
  if (requestBucketProp !== prevReqBucketProp) {
    setPrevReqBucketProp(requestBucketProp);
    if (reqBucket !== requestBucketProp) setReqBucket(requestBucketProp);
  }
  const [addServiceOpen, setAddServiceOpen] = useState(false);
  const [serviceState, setServiceState] = useState<ServiceRowState>("open");
  const [editServiceRequestsOpen, setEditServiceRequestsOpen] = useState(false);
  const [servicesSettingsOpen, setServicesSettingsOpen] = useState(false);
  const [bulkDeleteWorkOrder, setBulkDeleteWorkOrder] = useState<DemoManagerWorkOrderRow | null>(null);
  const [bulkDeleteRequest, setBulkDeleteRequest] = useState<ServiceRequest | null>(null);
  const [scheduleVisitRow, setScheduleVisitRow] = useState<DemoManagerWorkOrderRow | null>(null);
  const [editWorkOrderRow, setEditWorkOrderRow] = useState<DemoManagerWorkOrderRow | null>(null);
  const typeFilter: FilterType = tabId;

  const propertyOptions = useMemo(() => {
    void propertyTick;
    return buildManagerPropertyFilterOptions(userId ?? null);
  }, [userId, propertyTick]);

  useEffect(() => {
    if (!authReady || !userId) return;
    void syncPropertyPipelineFromServer().then(() => setPropertyTick((t) => t + 1));
    void syncManagerWorkOrdersFromServer({ force: true });
    void syncServiceRequestsFromServer({ force: true });
    const onWo = () => setDataTick((t) => t + 1);
    const onSr = () => setDataTick((t) => t + 1);
    window.addEventListener(MANAGER_WORK_ORDERS_EVENT, onWo);
    window.addEventListener(SERVICE_REQUESTS_EVENT, onSr);
    return () => {
      window.removeEventListener(MANAGER_WORK_ORDERS_EVENT, onWo);
      window.removeEventListener(SERVICE_REQUESTS_EVENT, onSr);
    };
  }, [authReady, userId]);

  const workOrders = useMemo<DemoManagerWorkOrderRow[]>(() => {
    void dataTick;
    if (!userId) return [];
    // Owner rows + linked-property rows for co-managers with services access.
    return readManagerWorkOrderRows().filter((r) => moduleRowVisibleToPortalUser(r, userId, "services"));
  }, [userId, dataTick]);

  const serviceRequests = useMemo<ServiceRequest[]>(() => {
    void dataTick;
    if (!userId) return [];
    // Match work orders: owned manager id OR owned/linked property — not exact
    // managerUserId alone (stale/mis-stamped rows still show for property owners).
    return readAllServiceRequests().filter((r) => moduleRowVisibleToPortalUser(r, userId, "services"));
  }, [userId, dataTick]);

  const filterPropertyOptions = useMemo(() => {
    const opts = [...propertyOptions];
    const seen = new Set(opts.map((p) => p.id));
    const woProps = workOrders
      .filter((w) => w.propertyId?.trim())
      .map((w) => ({ id: w.propertyId!, label: w.propertyName || w.propertyId! }));
    for (const p of woProps) {
      if (!seen.has(p.id)) {
        seen.add(p.id);
        opts.push(p);
      }
    }
    const srProps = serviceRequests
      .filter((r) => r.propertyId?.trim())
      .map((r) => {
        const match = propertyOptions.find((p) => samePropertyId(p.id, r.propertyId));
        return { id: r.propertyId, label: match?.label ?? r.propertyId };
      });
    for (const p of srProps) {
      if (!seen.has(p.id)) {
        seen.add(p.id);
        opts.push(p);
      }
    }
    return opts.sort((a, b) => a.label.localeCompare(b.label, undefined, { sensitivity: "base" }));
  }, [propertyOptions, workOrders, serviceRequests]);

  const filteredWorkOrders = useMemo(() => {
    let rows = workOrders;
    if (propertyFilters.length > 0) rows = rows.filter((r) => propertyFilters.some((id) => r.propertyId === id || r.assignedPropertyId === id));
    if (residentFilters.length > 0) {
      rows = rows.filter((r) => residentFilters.includes((r.residentEmail ?? "").trim().toLowerCase()));
    }
    return rows;
  }, [workOrders, propertyFilters, residentFilters]);

  const filteredRequests = useMemo(() => {
    let rows = serviceRequests;
    if (propertyFilters.length > 0) {
      rows = rows.filter(
        (r) => propertyFilters.some((id) => samePropertyId(r.propertyId, id)) || !r.propertyId?.trim(),
      );
    }
    if (residentFilters.length > 0) {
      rows = rows.filter((r) => residentFilters.includes((r.residentEmail ?? "").trim().toLowerCase()));
    }
    return rows;
  }, [serviceRequests, propertyFilters, residentFilters]);

  /**
   * Residents the list can be scoped to — everyone who has a service, narrowed
   * to the selected property when one is picked so the two scopes agree.
   */
  const filterResidentOptions = useMemo(() => {
    const seen = new Map<string, string>();
    const inScope = (propertyId: string | undefined | null, assignedPropertyId?: string | undefined | null) =>
      propertyFilters.length === 0 ||
      propertyFilters.some((id) => samePropertyId(propertyId, id) || (assignedPropertyId ? samePropertyId(assignedPropertyId, id) : false));
    for (const row of workOrders) {
      const email = (row.residentEmail ?? "").trim().toLowerCase();
      if (!email.includes("@") || !inScope(row.propertyId, row.assignedPropertyId)) continue;
      if (!seen.has(email)) seen.set(email, row.residentName?.trim() || email);
    }
    for (const row of serviceRequests) {
      const email = (row.residentEmail ?? "").trim().toLowerCase();
      if (!email.includes("@") || !inScope(row.propertyId)) continue;
      if (!seen.has(email)) seen.set(email, row.residentName?.trim() || email);
    }
    return [...seen.entries()]
      .map(([id, label]) => ({ id, label }))
      .sort((a, b) => a.label.localeCompare(b.label, undefined, { sensitivity: "base" }));
  }, [workOrders, serviceRequests, propertyFilters]);

  const resolveRequestPropertyLabel = (req: ServiceRequest) =>
    req.propertyId && propertyOptions.find((p) => p.id === req.propertyId)
      ? propertyOptions.find((p) => p.id === req.propertyId)!.label
      : "—";

  const bucketedRequests = useMemo(
    () =>
      filteredRequests
        .filter((r) => managerServiceRequestBucket(r.status) === reqBucket)
        .slice()
        .sort((a, b) => new Date(b.requestedAt).getTime() - new Date(a.requestedAt).getTime()),
    [filteredRequests, reqBucket],
  );

  const detailRequest = useMemo(() => {
    if (!serviceRequestIdProp) return null;
    const decoded = decodeURIComponent(serviceRequestIdProp);
    return bucketedRequests.find((r) => r.id === decoded) ?? null;
  }, [serviceRequestIdProp, bucketedRequests]);

  const propertyFilterLabel = useMemo(() => {
    if (propertyFilters.length === 0) return "";
    if (propertyFilters.length === 1) {
      return filterPropertyOptions.find((option) => samePropertyId(option.id, propertyFilters[0]))?.label ?? propertyFilters[0];
    }
    return `${propertyFilters.length} properties`;
  }, [propertyFilters, filterPropertyOptions]);

  const resetServicesFilters = () => {
    setPropertyFilters([]);
    setResidentFilters([]);
    setGroupMode(DEFAULT_PORTAL_LIST_GROUP_MODE);
  };

  const servicesFilterActiveCount = portalFilterActiveCount([propertyFilters, residentFilters]);
  const residentFilterLabel =
    residentFilters.length === 0
      ? ""
      : filterResidentOptions.find((option) => option.id === residentFilters[0])?.label ?? residentFilters[0]!;

  const servicesFilterSheet = (
    <PortalFilterSortSheet
        activeCount={servicesFilterActiveCount}
        compactPanel
        commandStripTrigger
        filterFieldCount={3}
        constrainDropdownToTitleBand={false}
        mobileFlushBody
        className={PORTAL_PROPERTY_FILTER_SHEET_CLASS}
        onReset={resetServicesFilters}
        dataAttr="services-filter-sheet-open"
      >
        <PortalListGroupFilterFields
          groupMode={groupMode}
          onGroupModeChange={setGroupMode}
          propertyOptions={filterPropertyOptions}
          propertyFilters={propertyFilters}
          onPropertyFiltersChange={setPropertyFilters}
          propertyDataAttr="services-filter-property"
          groupModeDataAttr="services-filter-group-mode"
          minPropertyOptions={1}
          residentOptions={filterResidentOptions}
          residentFilters={residentFilters}
          onResidentFiltersChange={setResidentFilters}
          residentDataAttr="services-filter-resident"
        />
      </PortalFilterSortSheet>
  );

  const activeFilterChips = useMemo((): PortalActiveFilterChip[] => {
    const chips: PortalActiveFilterChip[] = [];
    if (propertyFilters.length > 0) {
      chips.push({
        id: "property",
        label: `Property: ${propertyFilterLabel}`,
        onRemove: () => setPropertyFilters([]),
      });
    }
    if (residentFilters.length > 0) {
      chips.push({
        id: "resident",
        label: `Resident: ${residentFilterLabel}`,
        onRemove: () => setResidentFilters([]),
      });
    }
    return chips;
  }, [propertyFilters, propertyFilterLabel, residentFilters, residentFilterLabel]);

  const renderRequestDetail = (req: ServiceRequest) => {
    return (
      <ManagerServiceRequestDetail
        req={req}
        onFooterActionsChange={setDetailFooterActions}
        propertyLabel={resolveRequestPropertyLabel(req)}
        onUpdated={() => setDataTick((t) => t + 1)}
        onApproved={() => router.push(`${basePath}/services/requests/approved`)}
        onDenied={() => router.push(`${basePath}/services/requests/denied`)}
        onCollapsed={() => navigate(serviceRequestListHref(basePath, reqBucket))}
      />
    );
  };

  // Hoisted above the early returns below. It sat after them, so on a render that took an
  // early return this hook did not run and the hook COUNT changed between renders, which
  // is the rules-of-hooks violation. Its deps are all resolved by this point.
  /**
   * One Services list over both stores. Add-on services and maintenance work orders stay separate
   * RECORDS — AGENTS.md forbids merging their tables — but a manager thinks of them as one pile of
   * work. Each row keeps its own id and kind, so opening it routes into that record's own detail.
   */
  const unifiedRows = useMemo(
    () =>
      buildUnifiedServiceRows({
        addOns: filteredRequests,
        maintenance: filteredWorkOrders,
        propertyLabelForRequest: (propertyId) =>
          propertyOptions.find((option) => option.id === propertyId)?.label,
      }),
    [filteredRequests, filteredWorkOrders, propertyOptions],
  );
  const unifiedCounts = useMemo(() => countServiceRowsByState(unifiedRows), [unifiedRows]);
  const visibleUnifiedRows = useMemo(
    () => unifiedRows.filter((row) => row.state === serviceState),
    [unifiedRows, serviceState],
  );
  const { selectedIds, toggleSelected, clearSelection } = usePortalRowSelection(
    `${serviceState}:${groupMode}`,
  );
  const selectedSingleRow = useMemo(() => {
    if (selectedIds.size !== 1) return null;
    const rowKey = [...selectedIds][0];
    return visibleUnifiedRows.find((candidate) => unifiedServiceRowKey(candidate) === rowKey) ?? null;
  }, [selectedIds, visibleUnifiedRows]);
  const selectedWorkOrder = useMemo(() => {
    if (!selectedSingleRow || selectedSingleRow.kind !== "maintenance") return null;
    return filteredWorkOrders.find((workOrder) => workOrder.id === selectedSingleRow.id) ?? null;
  }, [selectedSingleRow, filteredWorkOrders]);
  const selectedServiceRequest = useMemo(() => {
    if (!selectedSingleRow || selectedSingleRow.kind !== "add-on") return null;
    return filteredRequests.find((request) => request.id === selectedSingleRow.id) ?? null;
  }, [selectedSingleRow, filteredRequests]);
  const serviceClusters = useMemo(
    () => clusterPortalListRows(visibleUnifiedRows, groupMode, (row) => row.propertyLabel),
    [visibleUnifiedRows, groupMode],
  );

  const workOrderDetailHref = (workOrderId: string, bucket = woBucket) =>
    `${basePath}/services/work-orders/${bucket}/${encodeURIComponent(workOrderId)}`;

  const openSelectedService = () => {
    const row = selectedSingleRow;
    if (!row) return;
    if (row.kind === "maintenance") {
      const workOrder =
        filteredWorkOrders.find((candidate) => candidate.id === row.id) ?? selectedWorkOrder;
      if (workOrder) {
        setEditWorkOrderRow(workOrder);
        return;
      }
    }
    clearSelection();
    navigate(
      row.kind === "add-on"
        ? serviceRequestDetailHref(basePath, reqBucket, row.id)
        : workOrderDetailHref(row.id, selectedWorkOrder?.bucket ?? woBucket),
    );
  };

  const openSelectedForSchedule = () => {
    if (!selectedWorkOrder || selectedWorkOrder.bucket !== "open") return;
    setScheduleVisitRow(selectedWorkOrder);
  };

  const confirmBulkDeleteWorkOrder = () => {
    const row = bulkDeleteWorkOrder;
    if (!row) return;
    if (deleteManagerWorkOrderRow(row.id)) {
      showToast("Service removed.");
      clearSelection();
      setDataTick((tick) => tick + 1);
    } else {
      showToast("Could not delete service.");
    }
    setBulkDeleteWorkOrder(null);
  };

  const confirmBulkDeleteRequest = () => {
    const row = bulkDeleteRequest;
    if (!row) return;
    deleteServiceRequest(row.id);
    showToast("Request deleted.");
    clearSelection();
    setDataTick((tick) => tick + 1);
    setBulkDeleteRequest(null);
  };

  const bulkDeleteButtonClass = `${PORTAL_BULK_BAR_BTN} border-rose-200 text-rose-800 hover:bg-[var(--status-overdue-bg)]`;

  const bulkSelectionActions: PortalAdaptiveAction[] =
    selectedIds.size !== 1 || !selectedSingleRow
      ? []
      : (() => {
          const actions: PortalAdaptiveAction[] = [
            {
              id: "edit",
              node: (
                <Button
                  type="button"
                  variant="outline"
                  className={PORTAL_BULK_BAR_BTN}
                  data-attr="services-bulk-edit"
                  onClick={openSelectedService}
                >
                  Edit
                </Button>
              ),
              menuItem: (
                <DropdownMenuItem data-attr="services-bulk-edit" onSelect={openSelectedService}>
                  Edit
                </DropdownMenuItem>
              ),
            },
          ];

          if (selectedSingleRow.kind === "maintenance" && selectedWorkOrder?.bucket === "open") {
            actions.push({
              id: "schedule-visit",
              node: (
                <Button
                  type="button"
                  variant="primary"
                  className={`${PORTAL_BULK_BAR_BTN} rounded-full`}
                  data-attr="services-bulk-schedule-visit"
                  onClick={openSelectedForSchedule}
                >
                  Schedule visit
                </Button>
              ),
              menuItem: (
                <DropdownMenuItem data-attr="services-bulk-schedule-visit" onSelect={openSelectedForSchedule}>
                  Schedule visit
                </DropdownMenuItem>
              ),
            });
            // A suggested time is waiting to be confirmed — same commit path as
            // "Schedule visit" (the modal prefills from `proposedVisit`), just a
            // clearer label when there is already something to confirm.
            if (selectedWorkOrder.proposedVisit) {
              actions.push({
                id: "confirm-time",
                node: (
                  <Button
                    type="button"
                    variant="outline"
                    className={PORTAL_BULK_BAR_BTN}
                    data-attr="services-bulk-confirm-time"
                    onClick={openSelectedForSchedule}
                  >
                    Confirm time
                  </Button>
                ),
                menuItem: (
                  <DropdownMenuItem data-attr="services-bulk-confirm-time" onSelect={openSelectedForSchedule}>
                    Confirm time
                  </DropdownMenuItem>
                ),
              });
            }
          }

          actions.push({
            id: "delete",
            node: (
              <Button
                type="button"
                variant="outline"
                className={bulkDeleteButtonClass}
                data-attr="services-bulk-delete"
                onClick={() => {
                  if (selectedWorkOrder) setBulkDeleteWorkOrder(selectedWorkOrder);
                  else if (selectedServiceRequest) setBulkDeleteRequest(selectedServiceRequest);
                }}
              >
                Delete
              </Button>
            ),
            menuItem: (
              <DropdownMenuItem
                data-attr="services-bulk-delete"
                onSelect={() => {
                  if (selectedWorkOrder) setBulkDeleteWorkOrder(selectedWorkOrder);
                  else if (selectedServiceRequest) setBulkDeleteRequest(selectedServiceRequest);
                }}
              >
                Delete
              </DropdownMenuItem>
            ),
          });

          return actions;
        })();

  const renderServiceRow = (row: (typeof visibleUnifiedRows)[number], omitPropertyInSubtitle: boolean) => {
    const rowKey = unifiedServiceRowKey(row);
    const subtitleParts = [
      row.kind === "add-on" ? "Add-on service" : "Maintenance",
      omitPropertyInSubtitle ? null : row.propertyLabel,
      groupMode === "house" ? row.residentName || row.residentEmail : null,
      row.unitLabel,
      // The visit time rides on the row so a manager sees at a glance what is booked
      // and what PropLane has only proposed (see `visitSourcePill` in the detail).
      row.scheduledIso
        ? formatServiceVisitLabel(row.scheduledIso)
        : row.proposedVisit
          ? `Proposed ${formatServiceVisitLabel(row.proposedVisit.iso)}`
          : null,
    ].filter(Boolean);
    return (
      <PortalServiceRecordRow
        key={rowKey}
        title={row.title}
        subtitle={subtitleParts.join(" · ") || undefined}
        checked={selectedIds.has(rowKey)}
        onSelectedChange={() => toggleSelected(rowKey)}
        onOpen={() =>
          navigate(
            row.kind === "add-on"
              ? serviceRequestDetailHref(basePath, reqBucket, row.id)
              : `${basePath}/services/work-orders/${woBucket}/${encodeURIComponent(row.id)}`,
          )
        }
        dataAttr={row.kind === "add-on" ? "service-request-list-row" : "work-order-list-row"}
      />
    );
  };

  // One row of state pills over the merged list. The Requests / Work orders type nav is gone —
  // that split is now just the `kind` carried on each row.
  if (serviceRequestIdProp && detailRequest) {
    return (
      <>
        <PortalRecordDetailPage
          pageTitle="Services"
          title={detailRequest.offerName}
          subtitle={detailRequest.residentName}
          avatarName={detailRequest.residentName}
          backHref={serviceRequestListHref(basePath, reqBucket)}
          hideBackText
          dataAttrBack="service-request-detail-back"
          footer={detailFooterActions ?? undefined}
        >
          {renderRequestDetail(detailRequest)}
        </PortalRecordDetailPage>
        <ManagerAddServiceModal
          open={addServiceOpen}
          onClose={() => setAddServiceOpen(false)}
          managerUserId={userId}
          defaultPropertyId={propertyFilters[0] || undefined}
          onSubmitted={() => {
            setDataTick((t) => t + 1);
            setServiceState("open");
          }}
        />
      </>
    );
  }

  if (workOrderIdProp && typeFilter === "work-orders") {
    return (
      <>
        <ManagerWorkOrdersPanel
          allRows={filteredWorkOrders}
          bucket={woBucket}
          workOrderId={workOrderIdProp}
          listBasePath={basePath}
          onAfterSchedule={() => router.push(`${basePath}/services/work-orders/scheduled`)}
          listAddAction={{
            onClick: () => setAddServiceOpen(true),
            dataAttr: "services-list-add",
          }}
        />
        <ManagerAddServiceModal
          open={addServiceOpen}
          onClose={() => setAddServiceOpen(false)}
          managerUserId={userId}
          defaultPropertyId={propertyFilters[0] || undefined}
          onSubmitted={() => {
            setDataTick((t) => t + 1);
            setWoBucket("open");
          }}
        />
      </>
    );
  }

  const servicesEmptyCard: ComponentProps<typeof PortalRecordListSurface>["emptyCard"] =
    propertyFilters.length > 0
      ? {
          title: portalEmptyNoMatchTitle("services"),
          section: "services",
          tone: "muted",
          clear: { label: "Clear filters", onClick: () => setPropertyFilters([]), dataAttr: "services-empty-clear-filters" },
        }
      : {
          title: portalEmptyCopy(`services.${serviceState}` as PortalEmptyCopyKey).title,
          section: "services",
          sibling: portalEmptySibling(
            SERVICE_STATE_TABS.map((tab) => ({ id: tab.id, label: tab.label, count: unifiedCounts[tab.id], onSelect: () => setServiceState(tab.id) })),
            serviceState,
          ),
          // Done and Declined are outcomes; a new service starts open.
          actions:
            serviceState === "done" || serviceState === "declined"
              ? []
              : [{ label: "Add service", onClick: () => setAddServiceOpen(true), dataAttr: "services-list-add" }],
        };

  const servicesListDestinations = (
    <LocalDestinationNav
      items={SERVICE_STATE_TABS.map((tab) => ({
        id: tab.id,
        label: tab.label,
        count: unifiedCounts[tab.id],
        dataAttr: `manager-services-state-${tab.id}`,
      }))}
      activeId={serviceState}
      onChange={(id) => setServiceState(id as ServiceRowState)}
      ariaLabel="Service status"
      appearance="command"
    />
  );

  return (
    <ManagerPortalPageShell
      title="Services"
      hideTitleOnMobileNav
      titleInlineFilter={null}
      compactFilterRow
    >
      <PortalListControlStack
        className="mb-2 max-lg:mb-1.5"
        variant="command"
        destinationRow={servicesListDestinations}
        actions={
          <>
            {servicesFilterSheet}
            <PortalIconAction
              icon={Settings2}
              label={servicesSettingsEntry.label}
              data-attr={servicesSettingsEntry.dataAttr}
              onClick={() => setServicesSettingsOpen(true)}
            />
          </>
        }
        primary={
          <PortalPrimaryIconAction
            label="Add service"
            data-attr="services-add-top"
            onClick={() => setAddServiceOpen(true)}
          />
        }
        activeFilterChips={<PortalActiveFilterChips chips={activeFilterChips} />}
      />
      <PortalRecordListSurface isEmpty={visibleUnifiedRows.length === 0} emptyCard={servicesEmptyCard} onBulkClear={clearSelection} bulkCount={selectedIds.size} bulkActions={selectedIds.size > 0 ? (
        <>
          <PortalAdaptiveActionRow actions={bulkSelectionActions} />
        </>
      ) : null}>
          {/*
            One list over both stores, grouped by resident the way Payments and Tours are. Each row
            opens its OWN record — an add-on goes to the request detail, maintenance to the work
            order detail — so the merge stays presentational and the stores never mix.
          */}
          <div className="space-y-3" data-attr="services-resident-groups">
            {isPropertyClusterList(groupMode, serviceClusters)
              ? serviceClusters.map((cluster) => (
                  <ApplicationHouseholdCluster
                    key={cluster.key}
                    header={
                      <>
                        <span className="truncate text-xs font-semibold text-foreground">
                          {cluster.propertyLabel}
                        </span>
                        <span className="sr-only">{cluster.rows.length === 1 ? "1 item" : `${cluster.rows.length} items`}</span>
                      </>
                    }
                  >
                    {cluster.rows.map((row) => renderServiceRow(row, true))}
                  </ApplicationHouseholdCluster>
                ))
              : serviceClusters.map((cluster) => (
                  <ApplicationHouseholdCluster
                    key={cluster.key}
                    header={
                      <>
                        <span className="truncate text-xs font-semibold text-foreground">
                          {cluster.residentLabel}
                        </span>
                        {cluster.residentEmail &&
                        cluster.residentEmail.toLowerCase() !== cluster.residentLabel.trim().toLowerCase() ? (
                          <span className="truncate text-xs text-muted">{cluster.residentEmail}</span>
                        ) : null}
                        {cluster.propertyLabel ? (
                          <span className="truncate text-xs text-muted">{cluster.propertyLabel}</span>
                        ) : null}
                        <span className="sr-only">{cluster.rows.length === 1 ? "1 item" : `${cluster.rows.length} items`}</span>
                      </>
                    }
                  >
                    {cluster.rows.map((row) => renderServiceRow(row, true))}
                  </ApplicationHouseholdCluster>
                ))}
          </div>
      </PortalRecordListSurface>

      <ManagerAddServiceModal
        open={addServiceOpen}
        onClose={() => setAddServiceOpen(false)}
        managerUserId={userId}
        defaultPropertyId={propertyFilters[0] || undefined}
        onSubmitted={() => {
          setDataTick((t) => t + 1);
          setServiceState("open");
        }}
      />

      <ManagerEditServiceRequestsModal
        open={editServiceRequestsOpen}
        onClose={() => setEditServiceRequestsOpen(false)}
        propertyOptions={propertyOptions}
        managerUserId={userId}
        onSaved={() => setPropertyTick((t) => t + 1)}
        showToast={showToast}
      />

      <ManagerPortalSettingsModal
        open={servicesSettingsOpen}
        onClose={() => setServicesSettingsOpen(false)}
        initialTab="services"
        scopedTitle={settingsDialogTitlePrefix(servicesSettingsEntry)}
        editAction={
          propertyOptions.length > 0
            ? {
                label: "Edit service catalog",
                description: "Service types and pricing per property.",
                dataAttr: "edit-service-requests-open",
                onSelect: () => setEditServiceRequestsOpen(true),
              }
            : undefined
        }
      />

      <ScheduleServiceVisitModal
        open={scheduleVisitRow !== null}
        row={scheduleVisitRow}
        onClose={() => setScheduleVisitRow(null)}
        onScheduled={() => {
          clearSelection();
          setDataTick((tick) => tick + 1);
          setServiceState("scheduled");
          setWoBucket("scheduled");
        }}
      />

      <EditServiceWorkOrderModal
        open={editWorkOrderRow !== null}
        row={editWorkOrderRow}
        onClose={() => setEditWorkOrderRow(null)}
        onSaved={() => {
          clearSelection();
          setDataTick((tick) => tick + 1);
        }}
      />



      <ConfirmDeleteModal
        open={bulkDeleteWorkOrder !== null}
        title="Delete service"
        description={
          bulkDeleteWorkOrder
            ? `Delete “${bulkDeleteWorkOrder.title}”? This cannot be undone.`
            : null
        }
        confirmLabel="Delete"
        onClose={() => setBulkDeleteWorkOrder(null)}
        onConfirm={confirmBulkDeleteWorkOrder}
        dataAttr="services-bulk-delete-confirm"
      />

      <ConfirmDeleteModal
        open={bulkDeleteRequest !== null}
        title="Delete request"
        description={
          bulkDeleteRequest ? `Delete “${bulkDeleteRequest.offerName}”?` : null
        }
        confirmLabel="Delete request"
        onClose={() => setBulkDeleteRequest(null)}
        onConfirm={confirmBulkDeleteRequest}
        dataAttr="services-bulk-delete-request-confirm"
      />
    </ManagerPortalPageShell>
  );
}

