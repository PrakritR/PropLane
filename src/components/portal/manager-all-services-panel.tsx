"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { usePortalNavigate } from "@/lib/portal-nav-client";
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
import { applicationVisibleToPortalUser } from "@/lib/manager-portfolio-access";
import { readManagerApplicationRows } from "@/lib/manager-applications-storage";
import { getRoomChoiceLabel } from "@/lib/rental-application/data";
import { ManagerCreateServiceRequestModal } from "@/components/portal/manager-create-service-request-modal";
import { ManagerEditServiceRequestsModal } from "@/components/portal/manager-edit-service-requests-modal";
import { ManagerCreateWorkOrderModal } from "@/components/portal/manager-create-work-order-modal";
import { useAppUi } from "@/components/providers/app-ui-provider";
import { Button } from "@/components/ui/button";
import { DestinationNav } from "@/components/ui/destination-nav";
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

  const residentUnitByKey = useMemo(() => {
    const map = new Map<string, string>();
    for (const row of readManagerApplicationRows()) {
      if (!applicationVisibleToPortalUser(row, userId)) continue;
      const email = row.email?.trim().toLowerCase();
      const propertyId = row.assignedPropertyId?.trim() || row.propertyId?.trim() || "";
      if (!email || !propertyId) continue;
      const roomLabel =
        row.manualResidentDetails?.roomNumber?.trim() ||
        getRoomChoiceLabel(row.assignedRoomChoice?.trim() || row.application?.roomChoice1?.trim() || "")
          .split(" · ")[0]
          ?.trim() ||
        "";
      if (roomLabel) map.set(`${email}|${propertyId}`, roomLabel);
    }
    return map;
  }, [userId, dataTick]);

  const resolveRequestPropertyLabel = (req: ServiceRequest) =>
    req.propertyId && propertyOptions.find((p) => p.id === req.propertyId)
      ? propertyOptions.find((p) => p.id === req.propertyId)!.label
      : "—";

  const resolveRequestUnit = (req: ServiceRequest) =>
    residentUnitByKey.get(`${req.residentEmail.trim().toLowerCase()}|${req.propertyId.trim()}`) ?? "";

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

  const woCounts = useMemo(() => {
    const c: Record<ManagerWorkOrderBucket, number> = { open: 0, scheduled: 0, completed: 0 };
    for (const r of filteredWorkOrders) c[r.bucket] += 1;
    return c;
  }, [filteredWorkOrders]);
  const woTabs = useMemo(
    () =>
      (["open", "scheduled", "completed"] as const).map((id) => ({
        id,
        label: id === "open" ? "Pending" : id === "scheduled" ? "Scheduled" : "Completed",
        count: woCounts[id],
      })),
    [woCounts],
  );
  const reqCounts = useMemo(() => {
    const c: Record<RequestBucket, number> = { pending: 0, approved: 0, denied: 0 };
    for (const r of filteredRequests) c[managerServiceRequestBucket(r.status)] += 1;
    return c;
  }, [filteredRequests]);
  const reqTabs = useMemo(
    () =>
      (["pending", "approved", "denied"] as const).map((id) => ({
        id,
        label: id === "pending" ? "Pending" : id === "approved" ? "Approved" : "Denied",
        count: reqCounts[id],
      })),
    [reqCounts],
  );

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

  const servicesTypeNav = (
    <DestinationNav
      items={[
        {
          id: "requests",
          label: "Requests",
          href: `${basePath}/services/requests/pending`,
          dataAttr: "manager-services-tab-requests",
        },
        {
          id: "work-orders",
          label: "Work orders",
          shortLabel: "Orders",
          href: `${basePath}/services/work-orders/open`,
          dataAttr: "manager-services-tab-work-orders",
        },
      ]}
      activeId={typeFilter}
      ariaLabel="Services section"
      itemLayout="equal"
      denseEqualRow
      className="max-w-none"
    />
  );

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
  const bucketDestinations = useMemo(() => {
    if (typeFilter === "work-orders") {
      return woTabs.map((t) => ({
        id: t.id,
        label: t.label,
        shortLabel: t.id === "scheduled" ? "Sched." : t.id === "completed" ? "Done" : t.label,
        href: `${basePath}/services/work-orders/${t.id}`,
        count: t.count,
      }));
    }
    if (typeFilter === "requests") {
      return reqTabs.map((t) => ({
        id: t.id,
        label: t.label,
        href: `${basePath}/services/requests/${t.id}`,
        count: t.count,
      }));
    }
    return undefined;
  }, [typeFilter, woTabs, reqTabs, basePath]);

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

  const activeBucketId =
    typeFilter === "work-orders" ? woBucket : reqBucket;

  const servicesListDestinations = (
    <div className="flex w-full min-w-0 flex-col gap-2">
      {servicesTypeNav}
      {bucketDestinations ? (
        <DestinationNav
          items={bucketDestinations}
          activeId={activeBucketId}
          ariaLabel={typeFilter === "work-orders" ? "Work order status" : "Request status"}
          itemLayout="equal"
          denseEqualRow
          className="max-w-none"
        />
      ) : null}
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
      {typeFilter === "work-orders" ? (
        <ManagerWorkOrdersPanel
          allRows={filteredWorkOrders}
          bucket={woBucket}
          workOrderId={workOrderIdProp}
          listBasePath={basePath}
          onAfterSchedule={() => router.push(`${basePath}/services/work-orders/scheduled`)}
          listAddAction={{
            label: "Add",
            onClick: () => setAddWorkOrderOpen(true),
            dataAttr: "services-work-orders-list-add",
          }}
        />
      ) : bucketedRequests.length === 0 ? (
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
            Grouped by resident, the same way Payments and Tours are — a manager reads these tabs
            side by side, and one flat list beside two grouped ones reads as a different product.
            The resident is now the group HEADER rather than a repeated line in every subtitle.
          */}
          <div className={cn(INBOX_LIST_SCROLL, "space-y-3")} data-attr="services-resident-groups">
            {clusterRowsByResident(
              bucketedRequests.map((req) => ({ ...req, id: req.id })),
              (req) => resolveRequestPropertyLabel(req) || null,
            ).map((cluster) => (
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
                      {cluster.rows.length === 1 ? "1 request" : `${cluster.rows.length} requests`}
                    </Badge>
                  </>
                }
              >
                {cluster.rows.map((req) => {
                  const unit = resolveRequestUnit(req);
                  // The resident is in the header now, so the row says what the header does not.
                  const subtitle = [resolveRequestPropertyLabel(req), unit].filter(Boolean).join(" · ");
                  return (
                    <PortalServiceRecordRow
                      key={req.id}
                      title={req.offerName}
                      subtitle={subtitle || undefined}
                      statusLabel={reqBucket === "pending" ? "Pending" : reqBucket === "approved" ? "Approved" : "Denied"}
                      statusTone={
                        reqBucket === "approved" ? "success" : reqBucket === "denied" ? "danger" : "warning"
                      }
                      onOpen={() => navigate(serviceRequestDetailHref(basePath, reqBucket, req.id))}
                      dataAttr="service-request-list-row"
                    />
                  );
                })}
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

