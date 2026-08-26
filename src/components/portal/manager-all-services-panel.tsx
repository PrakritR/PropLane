"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { usePortalNavigate } from "@/lib/portal-nav-client";
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
import { Badge } from "@/components/ui/badge";
import { clusterRowsByResident } from "@/lib/resident-row-clustering";
import { cn } from "@/lib/utils";
import {
  serviceRequestDetailHref,
  serviceRequestListHref,
} from "@/lib/portal-detail-routes";
import { PortalFilterSortSheet, portalFilterActiveCount } from "@/components/portal/portal-filter-sort-sheet";
import { PORTAL_PROPERTY_FILTER_SHEET_CLASS } from "@/components/portal/portal-filter-shell";
import { ApplicationFilterSortFields } from "@/components/portal/application-filter-sort-fields";
import { PortalListControlStack } from "@/components/portal/portal-list-control-stack";
import {
  ManagerPortalPageShell,
  PORTAL_HEADER_ACTION_BTN,
  PORTAL_HEADER_PRIMARY_ACTION_BTN_RESPONSIVE,
} from "@/components/portal/portal-metrics";
import { PortalActiveFilterChips, type PortalActiveFilterChip } from "@/components/portal/portal-filter-chips";
import { PortalRecordDetailPage } from "@/components/portal/portal-record-detail-page";
import { PortalServiceRecordRow } from "@/components/portal/portal-record-row";
import { INBOX_LIST_SCROLL } from "@/components/portal/portal-inbox-ui";
import { useManagerUserId } from "@/hooks/use-manager-user-id";
import {
  buildManagerPropertyFilterOptions,
  moduleRowVisibleToPortalUser,
  samePropertyId,
} from "@/lib/manager-portfolio-access";
import { syncPropertyPipelineFromServer } from "@/lib/demo-property-pipeline";
import {
  readManagerWorkOrderRows,
  syncManagerWorkOrdersFromServer,
  MANAGER_WORK_ORDERS_EVENT,
} from "@/lib/manager-work-orders-storage";
import {
  readAllServiceRequests,
  syncServiceRequestsFromServer,
  SERVICE_REQUESTS_EVENT,
  type ServiceRequest,
} from "@/lib/service-requests-storage";
import type { DemoManagerWorkOrderRow, ManagerWorkOrderBucket } from "@/data/demo-portal";
import { ManagerWorkOrdersPanel } from "@/components/portal/manager-work-orders-panel";
import {
  ManagerServiceRequestDetail,
  managerServiceRequestBucket,
  type ManagerServiceRequestBucket,
} from "@/components/portal/manager-service-request-detail";
import { ManagerCreateServiceRequestModal } from "@/components/portal/manager-create-service-request-modal";
import { ManagerEditServiceRequestsModal } from "@/components/portal/manager-edit-service-requests-modal";
import { ManagerCreateWorkOrderModal } from "@/components/portal/manager-create-work-order-modal";
import { useAppUi } from "@/components/providers/app-ui-provider";
import { Button } from "@/components/ui/button";
import { useShallowTabId } from "@/components/ui/tabs";
import {
  PORTAL_LIST_ADD_ICONS,
  PORTAL_LIST_ADD_ROW_WRAP_CLASS,
  PortalListAddRow,
} from "@/components/portal/portal-list-add-row";

type FilterType = "requests" | "work-orders";

type RequestBucket = ManagerServiceRequestBucket;

const SERVICES_TAB_IDS = ["requests", "work-orders"] as const;

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
  const [propertyFilters, setPropertyFilters] = useState<string[]>([]);
  const [searchQuery, setSearchQuery] = useState("");
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
  const [addRequestOpen, setAddRequestOpen] = useState(false);
  const [serviceState, setServiceState] = useState<ServiceRowState>("open");
  const [editServiceRequestsOpen, setEditServiceRequestsOpen] = useState(false);
  const [addWorkOrderOpen, setAddWorkOrderOpen] = useState(false);
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
    const q = searchQuery.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((r) =>
      [r.title, r.propertyName, r.unit, r.residentName, r.priority, r.description]
        .filter(Boolean)
        .join(" ")
        .toLowerCase()
        .includes(q),
    );
  }, [workOrders, propertyFilters, searchQuery]);

  const filteredRequests = useMemo(() => {
    let rows = serviceRequests;
    if (propertyFilters.length > 0) {
      rows = rows.filter(
        (r) => propertyFilters.some((id) => samePropertyId(r.propertyId, id)) || !r.propertyId?.trim(),
      );
    }
    const q = searchQuery.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((r) =>
      [r.offerName, r.residentName, r.notes, r.residentEmail]
        .filter(Boolean)
        .join(" ")
        .toLowerCase()
        .includes(q),
    );
  }, [serviceRequests, propertyFilters, searchQuery]);

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

  const resetServicesFilters = () => setPropertyFilters([]);

  const servicesFilterSheet = (
    <PortalFilterSortSheet
        activeCount={portalFilterActiveCount([propertyFilters])}
        compactPanel
        filterFieldCount={1}
        constrainDropdownToTitleBand
        mobileFlushBody
        className={PORTAL_PROPERTY_FILTER_SHEET_CLASS}
        onReset={resetServicesFilters}
        dataAttr="services-filter-sheet-open"
      >
        <ApplicationFilterSortFields
          propertyOptions={filterPropertyOptions}
          propertyFilters={propertyFilters}
          onPropertyFiltersChange={setPropertyFilters}
          dataAttr="services-filter-property"
        />
      </PortalFilterSortSheet>
  );

  const activeFilterChips = useMemo((): PortalActiveFilterChip[] => {
    const chips: PortalActiveFilterChip[] = [];
    if (propertyFilters.length > 0) {
      chips.push({
        id: "property",
        label: `Property: ${propertyFilterLabel}`,
        onRemove: () => {
          setPropertyFilters([]);
        },
      });
    }
    return chips;
  }, [propertyFilters, propertyFilterLabel]);

  const renderRequestDetail = (req: ServiceRequest) => {
    return (
      <ManagerServiceRequestDetail
        req={req}
        propertyLabel={resolveRequestPropertyLabel(req)}
        onUpdated={() => setDataTick((t) => t + 1)}
        onApproved={() => router.push(`${basePath}/services/requests/approved`)}
        onDenied={() => router.push(`${basePath}/services/requests/denied`)}
        onCollapsed={() => navigate(serviceRequestListHref(basePath, reqBucket))}
      />
    );
  };

  const servicesAddButton =
    typeFilter === "requests" ? (
      <div className="flex w-full shrink-0 flex-col gap-2 md:w-auto md:flex-row md:items-center">
        <Button
          type="button"
          variant="outline"
          className={PORTAL_HEADER_ACTION_BTN}
          data-attr="edit-service-requests-open"
          onClick={() => setEditServiceRequestsOpen(true)}
          disabled={propertyOptions.length === 0}
          title={propertyOptions.length === 0 ? "Add a property before editing its request types" : undefined}
        >
          Edit
        </Button>
        <Button
          type="button"
          variant="outline"
          className={PORTAL_HEADER_PRIMARY_ACTION_BTN_RESPONSIVE}
          data-attr="manager-service-request-add"
          onClick={() => setAddRequestOpen(true)}
        >
          Add
        </Button>
      </div>
    ) : (
      <Button
        type="button"
        variant="outline"
        className={PORTAL_HEADER_PRIMARY_ACTION_BTN_RESPONSIVE}
        data-attr="manager-work-order-add"
        onClick={() => setAddWorkOrderOpen(true)}
      >
        Add
      </Button>
    );

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
          backLabel="Back to services"
          dataAttrBack="service-request-detail-back"
        >
          {renderRequestDetail(detailRequest)}
        </PortalRecordDetailPage>
        <ManagerCreateServiceRequestModal
          open={addRequestOpen}
          onClose={() => setAddRequestOpen(false)}
          managerUserId={userId}
          defaultPropertyId={propertyFilters[0] || undefined}
          onSubmitted={() => {
            setDataTick((t) => t + 1);
            setReqBucket("pending");
          }}
        />
        <ManagerCreateWorkOrderModal
          open={addWorkOrderOpen}
          onClose={() => setAddWorkOrderOpen(false)}
          managerUserId={userId}
          defaultPropertyId={propertyFilters[0] || undefined}
          onSubmitted={(bucket) => {
            setDataTick((t) => t + 1);
            setWoBucket(bucket);
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
        />
        <ManagerCreateWorkOrderModal
          open={addWorkOrderOpen}
          onClose={() => setAddWorkOrderOpen(false)}
          managerUserId={userId}
          defaultPropertyId={propertyFilters[0] || undefined}
          onSubmitted={(bucket) => {
            setDataTick((t) => t + 1);
            setWoBucket(bucket);
          }}
        />
      </>
    );
  }

  const servicesListDestinations = (
    <div className="flex w-full min-w-0 flex-col gap-2">
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
      />
    </div>
  );

  return (
    <ManagerPortalPageShell
      title="Services"
      titleInlineFilter={servicesFilterSheet}
      titleAside={servicesAddButton}
      hideTitleOnMobileNav
      compactFilterRow
    >
      <PortalListControlStack
        className="mb-2"
        destinationRow={servicesListDestinations}
        search={{
          value: searchQuery,
          onChange: setSearchQuery,
          placeholder:
            typeFilter === "work-orders" ? "Search maintenance requests" : "Search requests",
          dataAttr:
            typeFilter === "work-orders" ? "services-work-orders-search" : "services-requests-search",
        }}
        activeFilterChips={<PortalActiveFilterChips chips={activeFilterChips} />}
      />
      {visibleUnifiedRows.length === 0 ? (
        <div className={PORTAL_LIST_ADD_ROW_WRAP_CLASS}>
          <PortalListAddRow
            label="Add"
            icon={PORTAL_LIST_ADD_ICONS.request}
            onClick={() => setAddRequestOpen(true)}
            dataAttr="services-requests-list-add"
          />
        </div>
      ) : (
        <div>
          {/*
            One list over both stores, grouped by resident the way Payments and Tours are. Each row
            opens its OWN record — an add-on goes to the request detail, maintenance to the work
            order detail — so the merge stays presentational and the stores never mix.
          */}
          <div className={cn(INBOX_LIST_SCROLL, "space-y-3")} data-attr="services-resident-groups">
            {clusterRowsByResident(visibleUnifiedRows).map((cluster) => (
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
                    <Badge tone="info">
                      {cluster.rows.length === 1 ? "1 item" : `${cluster.rows.length} items`}
                    </Badge>
                  </>
                }
              >
                {cluster.rows.map((row) => (
                  <PortalServiceRecordRow
                    key={`${row.kind}-${row.id}`}
                    title={row.title}
                    subtitle={
                      [
                        row.kind === "add-on" ? "Add-on service" : "Maintenance",
                        row.propertyLabel,
                        row.unitLabel,
                      ]
                        .filter(Boolean)
                        .join(" \u00b7 ") || undefined
                    }
                    statusLabel={row.statusLabel}
                    statusTone={
                      row.state === "done"
                        ? "success"
                        : row.state === "declined"
                          ? "danger"
                          : row.state === "scheduled"
                            ? "neutral"
                            : "warning"
                    }
                    onOpen={() =>
                      navigate(
                        row.kind === "add-on"
                          ? serviceRequestDetailHref(basePath, reqBucket, row.id)
                          : `${basePath}/services/work-orders/${woBucket}/${encodeURIComponent(row.id)}`,
                      )
                    }
                    dataAttr={row.kind === "add-on" ? "service-request-list-row" : "work-order-list-row"}
                  />
                ))}
              </ApplicationHouseholdCluster>
            ))}
          </div>
          <div className={PORTAL_LIST_ADD_ROW_WRAP_CLASS}>
            <PortalListAddRow
              label="Add"
              icon={PORTAL_LIST_ADD_ICONS.request}
              onClick={() => setAddRequestOpen(true)}
              dataAttr="services-requests-list-add"
            />
          </div>
        </div>
      )}

      <ManagerCreateServiceRequestModal
        open={addRequestOpen}
        onClose={() => setAddRequestOpen(false)}
        managerUserId={userId}
        defaultPropertyId={propertyFilters[0] || undefined}
        onSubmitted={() => {
          setDataTick((t) => t + 1);
          setReqBucket("pending");
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

      <ManagerCreateWorkOrderModal
        open={addWorkOrderOpen}
        onClose={() => setAddWorkOrderOpen(false)}
        managerUserId={userId}
        defaultPropertyId={propertyFilters[0] || undefined}
        onSubmitted={(bucket) => {
          setDataTick((t) => t + 1);
          setWoBucket(bucket);
        }}
      />
    </ManagerPortalPageShell>
  );
}

