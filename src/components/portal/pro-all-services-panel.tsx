"use client";

import { useEffect, useMemo, useState, type ComponentProps, type ReactNode } from "react";
import { usePathname, useRouter } from "next/navigation";
import { usePortalNavigate } from "@/lib/portal-nav-client";
import { ManagerServiceCardRow } from "@/components/portal/pro-service-card-row";
import { ServiceListRowMenu } from "@/components/portal/service-list-row-menu";
import { managerServiceRequestCardFigure } from "@/lib/manager-service-list-row";
import { managerServiceRequestRowMenuItems, managerServiceRowMenuItems } from "@/lib/manager-service-row-menu";
import {
  fetchVendorInvoiceIdForWorkOrder,
  outgoingPayHref,
} from "@/lib/manager-service-invoice-nav";
import { MANAGER_OUTGOING_PAYMENTS_EVENT } from "@/lib/manager-outgoing-payments";
import { formatPortalListDate } from "@/lib/portal-display-dates";
import { LocalDestinationNav } from "@/components/ui/destination-nav";
import {
  buildUnifiedServiceRows,
  countServiceRowsByState,
} from "@/lib/unified-service-rows";

/**
 * The four tabs the merged list filters by, in the order a manager works through them
 * (`service-lifecycle.ts`): Open · Assigned · Scheduled · Completed. There is no Vendors tab: who is
 * doing a service is a fact on the row, and a vendor's own work lives on the vendor record.
 */
export const SERVICE_STATE_TABS: { id: ServiceStage; label: string }[] = [...SERVICE_STAGE_TABS];
import { PortalRecordListSurface } from "@/components/portal/portal-record-list-surface";
import { PortalListResidentField } from "@/components/portal/portal-list-group-filter-fields";
import { ApplicationFilterSortFields } from "@/components/portal/application-filter-sort-fields";
import {
  FilterCollapsibleSection,
  FilterFieldsAccordion,
  FilterSingleSelectList,
  filterSingleSelectSummary,
  useFilterAccordionClose,
} from "@/components/portal/filter-field-lists";
import {
  PortalAdaptiveActionRow,
  type PortalAdaptiveAction,
} from "@/components/portal/portal-adaptive-action-row";
import { PORTAL_BULK_BAR_BTN } from "@/lib/portal-bulk-bar";
import {
  serviceRequestDetailHref,
  serviceRequestListHref,
  vendorDetailHref,
  workOrderDetailHref as buildWorkOrderDetailHref,
  type ServiceDetailTabId,
  type WorkOrderBucketId,
} from "@/lib/portal-detail-routes";
import { PortalRecordSectionChrome } from "@/components/portal/portal-record-section-chrome";
import { recordSections } from "@/lib/portals/record-sections";
import { renderRecordSection } from "@/components/portal/record-section-renderers";
import { PortalListEmptyCard } from "@/components/portal/portal-list-empty-card";
import { cn } from "@/lib/utils";
import { PortalDialog } from "@/components/portal/portal-dialog";
import { FieldSingleSelect } from "@/components/ui/checkbox-multi-select";
import { RecordFactCard, RecordFactRow } from "@/components/portal/portal-record-overview-kit";
import { ServiceCommunicationPane } from "@/components/portal/service-communication-pane";
import { ServiceOutgoingPaymentsList } from "@/components/portal/service-outgoing-payments-list";
import { ServiceIncomingPaymentsList } from "@/components/portal/service-incoming-payments-list";
import { buildServiceIncomingRows } from "@/lib/service-incoming-payments";
import { readChargesForManagerResident } from "@/lib/household-charges";
import { PortalFilterSortSheet, portalFilterActiveCount } from "@/components/portal/portal-filter-sort-sheet";
import { PORTAL_PROPERTY_FILTER_SHEET_CLASS } from "@/components/portal/portal-filter-shell";
import { PortalListControlStack } from "@/components/portal/portal-list-control-stack";
import { ManagerPortalPageShell } from "@/components/portal/portal-metrics";
import { PortalPrimaryIconAction } from "@/components/portal/portal-icon-action";
import { portalEmptyCopy, portalEmptyNoMatchTitle, type PortalEmptyCopyKey } from "@/lib/portal-empty-copy";
import { PortalActiveFilterChips, type PortalActiveFilterChip } from "@/components/portal/portal-filter-chips";
import { PortalRecordDetailPage, PortalRecordActions } from "@/components/portal/portal-record-detail-page";
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
  updateServiceRequest,
  SERVICE_REQUESTS_EVENT,
  type ServiceRequest,
} from "@/lib/service-requests-storage";
import {
  MANAGER_APPLICATIONS_EVENT,
  readManagerApplicationRows,
  syncManagerApplicationsFromServer,
} from "@/lib/manager-applications-storage";
import { directoryResidentEmailSet, isLinkedToDirectoryResident } from "@/lib/resident-directory-scope";
import { ConfirmDeleteModal } from "@/components/portal/confirm-delete-modal";
import type { DemoManagerWorkOrderRow } from "@/data/demo-portal";
import { ManagerWorkOrdersPanel } from "@/components/portal/pro-work-orders-panel";
import {
  ManagerServiceRequestDetail,
  managerServiceRequestBucket,
  managerServiceRequestPricingSummary,
  type ManagerServiceRequestBucket,
} from "@/components/portal/pro-service-request-detail";
import { ManagerAddServiceModal } from "@/components/portal/pro-add-service-modal";
import { ManagerEditServiceRequestsModal } from "@/components/portal/pro-edit-service-requests-modal";
import { ScheduleServiceVisitModal } from "@/components/portal/schedule-service-visit-modal";
import { ServiceEditPopup } from "@/components/portal/service-edit-popup";
import { ServiceWhoCard } from "@/components/portal/service-who-card";
import { useAddOnVendorJob } from "@/components/portal/use-add-on-vendor-job";
import { applyVendorJobToAddOn, linkedVendorJobFor, withoutLinkedVendorJobs } from "@/lib/add-on-vendor-job";
import { buildServicePipeline } from "@/lib/service-pipeline";
import { serviceCommunicationParties } from "@/lib/service-communication-scope";
import { isDemoModeActive } from "@/lib/demo/demo-session";
import { useAppUi } from "@/components/providers/app-ui-provider";
import { Button } from "@/components/ui/button";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { usePortalRowSelection } from "@/hooks/use-portal-row-selection";
import { useShallowTabId } from "@/components/ui/tabs";
import { fetchWorkOrderBids, type WorkOrderBid } from "@/lib/work-order-bids";
import { fetchWorkOrderVendorOffers, type WorkOrderVendorOffer } from "@/lib/work-order-vendor-offers";
import {
  managerServiceListCostFigure,
  resolveWorkOrderAssignee,
} from "@/lib/manager-service-workflow";
import { countSubmittedBids } from "@/lib/work-order-bid-cycle";
import {
  SERVICE_STAGE_LABEL,
  SERVICE_STAGE_TABS,
  addOnServiceStage,
  addOnStageFact,
  addOnStageSteps,
  formatServiceWhen,
  workOrderServiceStage,
  workOrderStageFact,
  type ServiceStage,
} from "@/lib/service-lifecycle";
import { ServiceVendorPipeline, type VendorsIntent } from "@/components/portal/service-vendor-cycle-section";
import { ServiceAssignDialog } from "@/components/portal/service-assign-dialog";
import { ServiceDetailsSection } from "@/components/portal/service-details-section";
import { ManagerAddPaymentModal } from "@/components/portal/pro-add-payment-modal";
import { ManagerAddOutgoingPaymentModal } from "@/components/portal/pro-add-outgoing-payment-modal";
import { addOnActivityEvents } from "@/lib/service-activity";
import { useWorkAssignmentDirectory } from "@/hooks/use-work-assignment-directory";
import { SERVICE_TAB_URL_SEGMENT, serviceTabFromSegment } from "@/lib/unified-service-rows";

type FilterType = "requests" | "work-orders";

type RequestBucket = ManagerServiceRequestBucket;

const SERVICES_TAB_IDS = ["requests", "work-orders"] as const;

function unifiedServiceRowKey(row: { kind: string; id: string }): string {
  return `${row.kind}::${row.id}`;
}

function ServicesAssigneeFilterField({
  assigneeFilter,
  onAssigneeFilterChange,
  assigneeFilterOptions,
}: {
  assigneeFilter: string;
  onAssigneeFilterChange: (value: string) => void;
  assigneeFilterOptions: { id: string; label: string }[];
}) {
  const closeFieldMenu = useFilterAccordionClose();
  const options = assigneeFilterOptions.map((o) => ({ value: o.id, label: o.label }));
  const summary = filterSingleSelectSummary(assigneeFilter, options, "Anyone");
  return (
    <FilterCollapsibleSection
      sectionId="assignee"
      label="Assigned to"
      summary={summary}
      empty={!assigneeFilter}
      menuOptionCount={options.length}
      dataAttr="services-filter-assignee-trigger"
    >
      <FilterSingleSelectList
        options={options}
        value={assigneeFilter}
        onChange={onAssigneeFilterChange}
        onPick={closeFieldMenu}
        dataAttr="services-filter-assignee"
      />
    </FilterCollapsibleSection>
  );
}

export function ManagerAllServicesPanel({
  tabId: serverTabId,
  basePath,
  requestBucket: requestBucketProp = "pending",
  workOrderBucket: workOrderBucketProp = "open",
  serviceRequestId: serviceRequestIdProp,
  workOrderId: workOrderIdProp,
  serviceDetailTab,
  lockedPropertyId,
  headerExtra,
}: {
  tabId: FilterType;
  basePath: string;
  requestBucket?: RequestBucket;
  workOrderBucket?: WorkOrderBucketId;
  serviceRequestId?: string;
  workOrderId?: string;
  /** The service record's own rail tab (docs/agents/record-page.md); undefined = Overview. */
  serviceDetailTab?: ServiceDetailTabId;
  /**
   * Embed the SAME list inside a property record: scoped to that property, no page shell, and no
   * property filter (the property is the record). One implementation, two places.
   */
  lockedPropertyId?: string;
  /** Extra header icon(s) beside Filter - the property record puts its service settings here. */
  headerExtra?: ReactNode;
}) {
  const tabId = useShallowTabId<FilterType>(serverTabId, SERVICES_TAB_IDS);
  const router = useRouter();
  const navigate = usePortalNavigate();
  const { showToast } = useAppUi();
  const { userId, ready: authReady } = useManagerUserId();
  const { teamMembers, vendors: rosterVendors } = useWorkAssignmentDirectory({ managerUserId: userId });
  const pathname = usePathname();
  const [propertyTick, setPropertyTick] = useState(0);
  const [dataTick, setDataTick] = useState(0);
  const [applicationTick, setApplicationTick] = useState(0);
  /** Approve / Deny / Edit / Delete, published by the detail and docked below it. */
  const [detailFooterActions, setDetailFooterActions] = useState<ReactNode | null>(null);
  const [propertyFilters, setPropertyFilters] = useState<string[]>(() => (lockedPropertyId ? [lockedPropertyId] : []));
  /** Resident emails (lower-cased); one at a time, like the property scope. */
  const [residentFilters, setResidentFilters] = useState<string[]>([]);
  const [assigneeFilter, setAssigneeFilter] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [woBucket, setWoBucket] = useState<WorkOrderBucketId>(workOrderBucketProp);
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
  const [assignOpen, setAssignOpen] = useState(false);
  const [addChargeOpen, setAddChargeOpen] = useState(false);
  const [addPaymentOpen, setAddPaymentOpen] = useState(false);
  const [editRequestOpen, setEditRequestOpen] = useState(false);
  /** The add-on's Vendors section opens on this tab (the header's next step, the Who's doing it card). */
  const [vendorsIntent, setVendorsIntent] = useState<VendorsIntent | null>(null);
  // The URL names the tab (`/services/work-orders/scheduled`), so it selects it - on first load, on
  // back/forward, and when the page is reached from a link. A tab click writes the URL back.
  // Old tab ids (`done`, `pending`, `active`, ...) resolve through `parseServiceStage`, so a saved link
  // lands on the right tab.
  const tabFromPath = (path: string | null | undefined): ServiceStage | null => {
    const parts = (path ?? "").split("/").filter(Boolean);
    const at = parts.lastIndexOf("work-orders");
    return at >= 0 && at === parts.length - 2 ? serviceTabFromSegment(parts[at + 1]) : null;
  };
  const urlTabSegment = lockedPropertyId || tabId !== "work-orders" ? null : serviceTabFromSegment(workOrderBucketProp);
  const [serviceState, setServiceStateRaw] = useState<ServiceStage>(
    () => (lockedPropertyId ? null : tabFromPath(pathname)) ?? urlTabSegment ?? "open",
  );
  const [prevPathname, setPrevPathname] = useState(pathname);
  if (pathname !== prevPathname) {
    setPrevPathname(pathname);
    const fromUrl = lockedPropertyId ? null : tabFromPath(pathname);
    if (fromUrl && fromUrl !== serviceState) setServiceStateRaw(fromUrl);
  }
  const setServiceState = (next: ServiceStage) => {
    setServiceStateRaw(next);
    if (lockedPropertyId || typeof window === "undefined") return;
    const href = `${basePath}/services/work-orders/${SERVICE_TAB_URL_SEGMENT[next]}`;
    if (window.location.pathname !== href) window.history.pushState(null, "", href);
  };
  const [editServiceRequestsOpen, setEditServiceRequestsOpen] = useState(false);
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
    void syncManagerApplicationsFromServer({ managerUserId: userId }).then(() => setApplicationTick((t) => t + 1));
    const onWo = () => setDataTick((t) => t + 1);
    const onSr = () => setDataTick((t) => t + 1);
    const onApp = () => setApplicationTick((t) => t + 1);
    window.addEventListener(MANAGER_WORK_ORDERS_EVENT, onWo);
    window.addEventListener(SERVICE_REQUESTS_EVENT, onSr);
    window.addEventListener(MANAGER_APPLICATIONS_EVENT, onApp);
    return () => {
      window.removeEventListener(MANAGER_WORK_ORDERS_EVENT, onWo);
      window.removeEventListener(SERVICE_REQUESTS_EVENT, onSr);
      window.removeEventListener(MANAGER_APPLICATIONS_EVENT, onApp);
    };
  }, [authReady, userId]);

  // N080: a work order / service request whose resident has no surviving
  // Potential/Current/Past application row is orphaned data — the manager
  // already deleted them from Residents (or a bug left the row behind) — and
  // must not keep showing up in Services or its dashboard counts.
  const directoryEmails = useMemo(() => {
    void applicationTick;
    return directoryResidentEmailSet(readManagerApplicationRows());
  }, [applicationTick]);

  const allWorkOrders = useMemo<DemoManagerWorkOrderRow[]>(() => {
    void dataTick;
    if (!userId) return [];
    // Owner rows + linked-property rows for co-managers with services access.
    // A general property maintenance row (no resident named at all) is never
    // "orphaned" — only a row that names an email with no surviving directory
    // row is dropped.
    return readManagerWorkOrderRows()
      .filter((r) => moduleRowVisibleToPortalUser(r, userId, "services"))
      .filter((r) => !r.residentEmail?.trim() || isLinkedToDirectoryResident(r.residentEmail, directoryEmails));
  }, [userId, dataTick, directoryEmails]);

  // An add-on's vendor job (`add-on-vendor-job.ts`) is a work order behind the scenes: the two models keep
  // separate lists and counts, so the Services lists never draw it as a service of its own.
  const workOrders = useMemo(() => withoutLinkedVendorJobs(allWorkOrders), [allWorkOrders]);

  const serviceRequests = useMemo<ServiceRequest[]>(() => {
    void dataTick;
    if (!userId) return [];
    // Match work orders: owned manager id OR owned/linked property — not exact
    // managerUserId alone (stale/mis-stamped rows still show for property owners).
    return readAllServiceRequests()
      .filter((r) => moduleRowVisibleToPortalUser(r, userId, "services"))
      .filter((r) => !r.residentEmail?.trim() || isLinkedToDirectoryResident(r.residentEmail, directoryEmails))
      // Once a vendor is on the add-on's job, the add-on reads Assigned / Scheduled / Completed with it.
      .map((r) => applyVendorJobToAddOn(r, linkedVendorJobFor(r, allWorkOrders)));
  }, [userId, dataTick, directoryEmails, allWorkOrders]);

  // C253: bid counts for the Overview tile and the list row's glyph fact — one
  // batched fetch (no workOrderId = every bid across this manager's work orders,
  // scoped server-side to `manager_user_id`) rather than one request per row.
  const [allBids, setAllBids] = useState<WorkOrderBid[]>([]);
  useEffect(() => {
    if (!authReady || !userId) return;
    let cancelled = false;
    void fetchWorkOrderBids().then((bids) => {
      if (!cancelled) setAllBids(bids);
    });
    return () => {
      cancelled = true;
    };
  }, [authReady, userId, dataTick]);
  const [allOffers, setAllOffers] = useState<WorkOrderVendorOffer[]>([]);
  useEffect(() => {
    if (!authReady || !userId) return;
    let cancelled = false;
    void fetchWorkOrderVendorOffers().then((offers) => {
      if (!cancelled) setAllOffers(offers);
    });
    return () => {
      cancelled = true;
    };
  }, [authReady, userId, dataTick]);
  const bidCountByWorkOrderId = useMemo(() => {
    // Submitted bids only: an estimate or a booked visit is not something to compare.
    const byWorkOrder = new Map<string, WorkOrderBid[]>();
    for (const bid of allBids) byWorkOrder.set(bid.workOrderId, [...(byWorkOrder.get(bid.workOrderId) ?? []), bid]);
    return new Map([...byWorkOrder].map(([id, bids]) => [id, countSubmittedBids(bids)]));
  }, [allBids]);

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
    if (propertyFilters.length > 0) rows = rows.filter((r) => propertyFilters.some((id) => samePropertyId(r.propertyId, id) || samePropertyId(r.assignedPropertyId, id)));
    if (residentFilters.length > 0) {
      rows = rows.filter((r) => residentFilters.includes((r.residentEmail ?? "").trim().toLowerCase()));
    }
    if (assigneeFilter === "unassigned") {
      rows = rows.filter((r) => !resolveWorkOrderAssignee(r));
    } else if (assigneeFilter === "assigned") {
      rows = rows.filter((r) => Boolean(resolveWorkOrderAssignee(r)));
    } else if (assigneeFilter.startsWith("vendor:")) {
      const id = assigneeFilter.slice("vendor:".length);
      rows = rows.filter((r) => r.vendorId === id);
    } else if (assigneeFilter.startsWith("team:")) {
      const id = assigneeFilter.slice("team:".length);
      rows = rows.filter((r) => r.assignee?.type === "team" && r.assignee.id === id);
    }
    return rows;
  }, [workOrders, propertyFilters, residentFilters, assigneeFilter]);

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

  const detailJob = useMemo(() => (detailRequest ? linkedVendorJobFor(detailRequest, allWorkOrders) : null), [detailRequest, allWorkOrders]);
  const addOnJob = useAddOnVendorJob({
    request: detailRequest,
    job: detailJob,
    managerUserId: userId ?? null,
    propertyLabel: detailRequest && resolveRequestPropertyLabel(detailRequest) !== "—" ? resolveRequestPropertyLabel(detailRequest) : "",
    showToast,
    onChanged: () => setDataTick((t) => t + 1),
  });

  const propertyFilterLabel = useMemo(() => {
    if (propertyFilters.length === 0) return "";
    if (propertyFilters.length === 1) {
      return filterPropertyOptions.find((option) => samePropertyId(option.id, propertyFilters[0]))?.label ?? propertyFilters[0];
    }
    return `${propertyFilters.length} properties`;
  }, [propertyFilters, filterPropertyOptions]);

  const assigneeFilterOptions = useMemo(() => {
    const opts: { id: string; label: string }[] = [
      { id: "", label: "Anyone" },
      { id: "unassigned", label: "Unassigned" },
      { id: "assigned", label: "Assigned" },
    ];
    const seen = new Set<string>();
    for (const row of workOrders) {
      const a = resolveWorkOrderAssignee(row);
      if (!a) continue;
      const key = a.kind === "vendor" ? `vendor:${a.id}` : `team:${a.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      opts.push({ id: key, label: a.name });
    }
    return opts;
  }, [workOrders]);

  const resetServicesFilters = () => {
    setPropertyFilters(lockedPropertyId ? [lockedPropertyId] : []);
    setResidentFilters([]);
    setAssigneeFilter("");
  };

  const servicesFilterActiveCount = portalFilterActiveCount([lockedPropertyId ? [] : propertyFilters, residentFilters, assigneeFilter ? [assigneeFilter] : []]);
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
        <FilterFieldsAccordion>
          {lockedPropertyId ? null : (
            <ApplicationFilterSortFields
              propertyOptions={filterPropertyOptions}
              propertyFilters={propertyFilters}
              onPropertyFiltersChange={setPropertyFilters}
              dataAttr="services-filter-property"
              selectionMode="single"
            />
          )}
          <PortalListResidentField
            residentOptions={filterResidentOptions}
            residentFilters={residentFilters}
            onResidentFiltersChange={setResidentFilters}
            dataAttr="services-filter-resident"
          />
        </FilterFieldsAccordion>
        <ServicesAssigneeFilterField
          assigneeFilter={assigneeFilter}
          onAssigneeFilterChange={setAssigneeFilter}
          assigneeFilterOptions={assigneeFilterOptions}
        />
      </PortalFilterSortSheet>
  );

  const activeFilterChips = useMemo((): PortalActiveFilterChip[] => {
    const chips: PortalActiveFilterChip[] = [];
    if (propertyFilters.length > 0 && !lockedPropertyId) {
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
    if (assigneeFilter) {
      chips.push({
        id: "assignee",
        label: `Assigned: ${assigneeFilterOptions.find((o) => o.id === assigneeFilter)?.label ?? assigneeFilter}`,
        onRemove: () => setAssigneeFilter(""),
      });
    }
    return chips;
  }, [propertyFilters, propertyFilterLabel, residentFilters, residentFilterLabel, assigneeFilter, assigneeFilterOptions, lockedPropertyId]);

  const renderRequestDetail = (req: ServiceRequest, opts?: { actionsOnly?: boolean; onEdit?: () => void; onMarkDone?: () => void }) => {
    return (
      <ManagerServiceRequestDetail
        req={req}
        actionsOnly={opts?.actionsOnly}
        onEdit={opts?.onEdit}
        onMarkDone={opts?.onMarkDone}
        onFooterActionsChange={setDetailFooterActions}
        propertyLabel={resolveRequestPropertyLabel(req)}
        onUpdated={() => setDataTick((t) => t + 1)}
        onApproved={() => router.push(`${basePath}/services/requests/approved`)}
        onDenied={() => router.push(`${basePath}/services/requests/denied`)}
        onCollapsed={() => navigate(serviceRequestListHref(basePath, reqBucket))}
        onMessage={() =>
          navigate(serviceRequestDetailHref(basePath, reqBucket, req.id, "communication"))
        }
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
        // The tab a service sits in comes from the same stage the record's stage bar shows.
        maintenance: filteredWorkOrders.map((workOrder) => ({
          ...workOrder,
          state: workOrderServiceStage(workOrder, {
            bids: allBids.filter((bid) => bid.workOrderId === workOrder.id),
            offers: allOffers.filter((offer) => offer.workOrderId === workOrder.id),
          }),
        })),
        propertyLabelForRequest: (propertyId) =>
          propertyOptions.find((option) => option.id === propertyId)?.label,
      }),
    [filteredRequests, filteredWorkOrders, propertyOptions, allBids, allOffers],
  );
  const unifiedCounts = useMemo(() => countServiceRowsByState(unifiedRows), [unifiedRows]);
  const tabUnifiedRows = useMemo(() => {
    let rows = unifiedRows;
    if (serviceState === "completed") {
      rows = rows.filter((row) => row.state === "completed" || row.state === "declined");
    } else {
      rows = rows.filter((row) => row.state === serviceState);
    }
    return rows;
  }, [unifiedRows, serviceState]);

  const visibleUnifiedRows = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return tabUnifiedRows;
    return tabUnifiedRows.filter((row) => {
      const hay = `${row.title} ${row.residentName} ${row.residentEmail} ${row.propertyLabel} ${row.unitLabel ?? ""}`.toLowerCase();
      return hay.includes(q);
    });
  }, [tabUnifiedRows, searchQuery]);

  const servicesSearchExcludesAll =
    Boolean(searchQuery.trim()) && tabUnifiedRows.length > 0 && visibleUnifiedRows.length === 0;
  const { selectedIds, toggleSelected, clearSelection } = usePortalRowSelection(serviceState);
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

          // C247: Schedule/Confirm time only apply once a vendor is actually assigned —
          // offering them on an unassigned service is a dead click (nothing to schedule
          // a visit for yet). "Invite more vendors" / "Decline" stay reachable regardless
          // via the record's own header actions.
          if (
            selectedSingleRow.kind === "maintenance" &&
            selectedWorkOrder?.bucket === "open" &&
            Boolean(selectedWorkOrder?.vendorId || selectedWorkOrder?.vendorName)
          ) {
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
    const bidCount = row.kind === "maintenance" ? bidCountByWorkOrderId.get(row.id) ?? 0 : 0;
    const maintenanceRow =
      row.kind === "maintenance" ? filteredWorkOrders.find((w) => w.id === row.id) ?? null : null;
    const addOnRequest =
      row.kind === "add-on" ? filteredRequests.find((r) => r.id === row.id) ?? null : null;
    const costFigure = maintenanceRow
      ? managerServiceListCostFigure(maintenanceRow, allBids.find((bid) => bid.workOrderId === maintenanceRow.id && bid.status === "accepted")) || undefined
      : addOnRequest
        ? managerServiceRequestCardFigure(addOnRequest)
        : undefined;
    const menuItems = maintenanceRow
      ? managerServiceRowMenuItems(maintenanceRow, {
          bidCount,
          communicationHref: buildWorkOrderDetailHref(basePath, maintenanceRow.bucket, maintenanceRow.id, "communication"),
        })
      : addOnRequest
        ? managerServiceRequestRowMenuItems(addOnRequest)
        : [];
    const openRow = () =>
      navigate(
        row.kind === "add-on"
          ? serviceRequestDetailHref(basePath, reqBucket, row.id)
          : buildWorkOrderDetailHref(basePath, serviceState, row.id),
      );
    const onMenuAction = (id: string) => {
      if (addOnRequest) {
        const bucket = managerServiceRequestBucket(addOnRequest.status);
        const detailHref = (tab?: ServiceDetailTabId) =>
          serviceRequestDetailHref(basePath, bucket, addOnRequest.id, tab);
        if (id === "message") {
          navigate(detailHref("communication"));
          return;
        }
        if (id === "delete") {
          setBulkDeleteRequest(addOnRequest);
          return;
        }
        if (id === "approve" || id === "deny" || id === "edit") {
          navigate(detailHref());
          return;
        }
        openRow();
        return;
      }
      if (!maintenanceRow) return openRow();
      if (id === "message") {
        navigate(buildWorkOrderDetailHref(basePath, maintenanceRow.bucket, maintenanceRow.id, "communication"));
        return;
      }
      if (id === "schedule") {
        setScheduleVisitRow(maintenanceRow);
        return;
      }
      if (id === "request-bids" || id === "compare-bids" || id === "approve-bid" || id === "assign") {
        navigate(buildWorkOrderDetailHref(basePath, maintenanceRow.bucket, maintenanceRow.id, "vendors"));
        return;
      }
      if (id === "approve-invoice") {
        void (async () => {
          const submitted = await fetchVendorInvoiceIdForWorkOrder(maintenanceRow.id, "submitted");
          if (submitted) {
            const res = await fetch(`/api/vendor/invoices/${encodeURIComponent(submitted)}/decision`, {
              method: "PATCH",
              headers: { "Content-Type": "application/json" },
              credentials: "include",
              body: JSON.stringify({ status: "approved" }),
            });
            const data = await res.json();
            if (!res.ok) {
              showToast(data.error ?? "Could not approve invoice.");
              return;
            }
            showToast("Invoice approved.");
            window.dispatchEvent(new Event(MANAGER_OUTGOING_PAYMENTS_EVENT));
            navigate(outgoingPayHref(basePath, submitted));
            return;
          }
          navigate(buildWorkOrderDetailHref(basePath, maintenanceRow.bucket, maintenanceRow.id));
        })();
        return;
      }
      if (id === "pay") {
        void (async () => {
          const approved =
            (await fetchVendorInvoiceIdForWorkOrder(maintenanceRow.id, "approved")) ??
            (await fetchVendorInvoiceIdForWorkOrder(maintenanceRow.id, "submitted"));
          if (approved) {
            navigate(outgoingPayHref(basePath, approved));
            return;
          }
          navigate(`${basePath}/outgoing/to-pay`);
        })();
        return;
      }
      if (id === "complete") {
        navigate(buildWorkOrderDetailHref(basePath, maintenanceRow.bucket, maintenanceRow.id));
        return;
      }
      if (id === "cancel") {
        setBulkDeleteWorkOrder(maintenanceRow);
        return;
      }
      openRow();
    };
    return (
      <ManagerServiceCardRow
        key={rowKey}
        row={row}
        omitProperty={omitPropertyInSubtitle}
        figure={costFigure}
        stageFact={
          maintenanceRow
            ? workOrderStageFact(maintenanceRow, {
                bids: allBids.filter((bid) => bid.workOrderId === maintenanceRow.id),
                offers: allOffers.filter((offer) => offer.workOrderId === maintenanceRow.id),
              })
            : addOnRequest
              ? addOnStageFact(addOnRequest)
              : undefined
        }
        menu={
          menuItems.length > 0 ? (
            <ServiceListRowMenu title={row.title} items={menuItems} onAction={onMenuAction} />
          ) : undefined
        }
        checked={selectedIds.has(rowKey)}
        onSelectedChange={() => toggleSelected(rowKey)}
        onOpen={openRow}
        dataAttr={row.kind === "add-on" ? "service-request-list-row" : "work-order-list-row"}
        rowId={row.kind === "maintenance" ? `svc-row-${row.id}` : undefined}
      />
    );
  };

  // One row of state pills over the merged list. The Requests / Work orders type nav is gone —
  // that split is now just the `kind` carried on each row.
  if (serviceRequestIdProp && detailRequest) {
    // An add-on request's real actions (Approve/Deny/Edit/Delete) already live in the footer via
    // `renderRequestDetail` — the header carries none of the generic assign-vendor/schedule/close
    // set, which does not describe an add-on (docs/agents/record-page.md § Known gap).
    const sections = {
      ...recordSections("manager", "service", { basePath, serviceKind: "request", serviceBucket: reqBucket }),
      headerActions: [],
    };
    const activeTab = serviceDetailTab ?? "service";
    const backHref = serviceRequestListHref(basePath, reqBucket);
    // An add-on stays with the manager team (`assignableKindsFor`: a vendor takes tasks and
    // maintenance only), so its Assign popup offers a teammate or yourself and never vendors.
    const applyAddOnAssign = (next: { id: string; name: string }) => {
      updateServiceRequest(detailRequest.id, { assignee: { type: "team", id: next.id, name: next.name } });
      setDataTick((t) => t + 1);
      showToast(next.id === userId ? "You're handling this yourself." : `Assigned ${next.name}.`);
    };
    const propertyForModals = detailRequest.propertyId?.trim() || undefined;
    const vendorsHref = serviceRequestDetailHref(basePath, reqBucket, detailRequest.id, "vendors");
    const sendToVendors = () => {
      setVendorsIntent({ tab: "available", nonce: (vendorsIntent?.nonce ?? 0) + 1 });
      if (activeTab !== "vendors") navigate(vendorsHref);
    };
    const pipeline = buildServicePipeline({
      job: detailJob,
      offers: addOnJob.offers,
      bids: addOnJob.bids,
      roster: rosterVendors,
      jobTrade: "",
    });
    const hiredVendor = detailRequest.assignee?.type === "vendor";
    const ownContent =
      activeTab === "vendors" ? (
        <ServiceVendorPipeline
          pipeline={pipeline}
          trade="General"
          intent={vendorsIntent}
          sending={addOnJob.sending}
          approvingBidId={addOnJob.approvingBidId}
          allowMarketplace={!isDemoModeActive()}
          onSend={addOnJob.send}
          onWithdraw={(request) => void addOnJob.withdraw(request)}
          onApprove={(request) => void addOnJob.approve(request)}
          onSchedule={() => {
            if (detailJob) setScheduleVisitRow(detailJob);
          }}
          onMarkDone={() => void addOnJob.markDone()}
          onPay={() => void addOnJob.pay()}
          onMessage={() => navigate(serviceRequestDetailHref(basePath, reqBucket, detailRequest.id, "communication"))}
        />
      ) : activeTab === "incoming-payments" ? (
        <ServiceIncomingPaymentsList
          rows={buildServiceIncomingRows({
            charges: readChargesForManagerResident(detailRequest.residentEmail, detailRequest.managerUserId ?? null),
            request: detailRequest,
          })}
          onAddCharge={() => setAddChargeOpen(true)}
        />
      ) : activeTab === "outgoing-payments" ? (
        <ServiceOutgoingPaymentsList rows={[]} busyId={null} onApproveAndPay={() => undefined} onAddPayment={() => setAddPaymentOpen(true)} />
      ) : activeTab === "communication" ? (
        <ServiceCommunicationPane
          recordId={detailRequest.id}
          linkedWorkOrderId={detailJob?.id ?? detailRequest.linkedWorkOrderId}
          recordLabel={detailRequest.offerName}
          propertyId={detailRequest.propertyId}
          basePath={basePath}
          parties={serviceCommunicationParties({
            resident: { name: detailRequest.residentName, email: detailRequest.residentEmail },
            offers: addOnJob.offers,
            bids: addOnJob.bids,
            roster: rosterVendors,
          })}
        />
      ) : (
        <ServiceDetailsSection
          stages={addOnStageSteps(detailRequest)}
          photos={[]}
          activity={addOnActivityEvents(detailRequest)}
          onEdit={detailRequest.status === "pending" || detailRequest.status === "approved" ? () => setEditRequestOpen(true) : undefined}
          details={
        <>
        <div className="mb-3">
          <ServiceWhoCard
            who={
              detailRequest.assignee
                ? {
                    name: detailRequest.assignee.name?.trim() || "Assigned",
                    kind: hiredVendor ? "vendor" : "team",
                    visit: formatServiceWhen(detailRequest.proposedVisit?.iso),
                    price: hiredVendor && detailJob ? managerServiceListCostFigure(detailJob, addOnJob.acceptedBid) : managerServiceRequestPricingSummary(detailRequest).replace(/^—$/, ""),
                  }
                : null
            }
            finished={detailRequest.status === "returned" || detailRequest.status === "denied"}
            onAssignTeam={() => setAssignOpen(true)}
            onSendToVendors={sendToVendors}
          />
        </div>
        {renderRecordSection("overview", {
          role: "manager",
          kind: "service",
          kindLabel: "service",
          recordId: detailRequest.id,
          recordLabel: detailRequest.offerName,
          overviewTiles: [
            { id: "status", label: "Status", value: detailRequest.status.toLowerCase() === "denied" ? "Declined" : SERVICE_STAGE_LABEL[addOnServiceStage(detailRequest)] },
            { id: "vendor", label: "Assigned to", value: detailRequest.assignee?.name ?? "Not assigned" },
            { id: "cost", label: "Cost", value: managerServiceRequestPricingSummary(detailRequest) },
            { id: "requested", label: "Requested", value: formatPortalListDate(detailRequest.requestedAt) },
          ],
          overviewNeeds: [],
          overviewCards: [
            {
              id: "request",
              title: "Request",
              rows: [
                { label: "Details", value: detailRequest.offerDescription || detailRequest.notes || "—" },
                { label: "Reported", value: formatPortalListDate(detailRequest.requestedAt) },
              ],
            },
            {
              id: "home",
              title: "Home",
              rows: [
                { label: "Property", value: resolveRequestPropertyLabel(detailRequest) },
                { label: "Resident", value: detailRequest.residentName },
              ],
            },
          ],
        })}
        </>
          }
        />
      );
    return (
      <>
        {renderRequestDetail(detailRequest, {
          actionsOnly: true,
          onEdit: () => setEditRequestOpen(true),
          onMarkDone: () => void addOnJob.markDone(),
        })}
        <ScheduleServiceVisitModal
          open={scheduleVisitRow !== null}
          row={scheduleVisitRow}
          onClose={() => setScheduleVisitRow(null)}
          onScheduled={() => setDataTick((t) => t + 1)}
        />
        <ServiceAssignDialog
          open={assignOpen}
          onClose={() => setAssignOpen(false)}
          allowVendors={false}
          vendors={[]}
          teamMembers={teamMembers}
          meUserId={userId}
          onRequestBids={() => undefined}
          onAssign={(next) => applyAddOnAssign(next)}
        />
        {addChargeOpen ? (
          <ManagerAddPaymentModal
            open={addChargeOpen}
            onClose={() => setAddChargeOpen(false)}
            onSubmitted={() => setDataTick((t) => t + 1)}
            managerUserId={userId}
            initialResidentEmail={detailRequest.residentEmail}
            initialPropertyId={propertyForModals}
            initialTitle={detailRequest.offerName}
            serviceRecordId={detailRequest.id}
          />
        ) : null}
        {addPaymentOpen ? (
          <ManagerAddOutgoingPaymentModal
            open={addPaymentOpen}
            onClose={() => setAddPaymentOpen(false)}
            onSubmitted={() => window.dispatchEvent(new Event(MANAGER_OUTGOING_PAYMENTS_EVENT))}
            managerUserId={userId}
            initialPropertyId={propertyForModals}
            initialVendorId={detailRequest.assignee?.type === "vendor" ? detailRequest.assignee.id : undefined}
            initialMemo={detailRequest.offerName}
          />
        ) : null}
        <ServiceEditPopup
          open={editRequestOpen}
          target={{ kind: "add-on", request: detailRequest }}
          managerUserId={userId ?? null}
          onClose={() => setEditRequestOpen(false)}
          onSaved={() => setDataTick((t) => t + 1)}
        />
        <PortalRecordDetailPage
          pageTitle="Services"
          title={detailRequest.offerName}
          subtitle={detailRequest.residentName}
          avatarName={detailRequest.residentName}
          backHref={backHref}
          hideBackText
          bareHeader
          iconTitleActions
          dataAttrBack="service-request-detail-back"
          pinScrollBody
        >
          {detailFooterActions ? (
            <PortalRecordActions omitSpacer>{detailFooterActions}</PortalRecordActions>
          ) : null}
          <PortalRecordSectionChrome
            sections={sections}
            recordId={detailRequest.id}
            activeId={activeTab}
            title={detailRequest.offerName}
            subtitle={detailRequest.residentName}
            backHref={backHref}
            backLabel="All services"
            ariaLabel="Service sections"
          >
            {ownContent}
          </PortalRecordSectionChrome>
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
          serviceDetailTab={serviceDetailTab}
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
    servicesSearchExcludesAll
      ? {
          title: portalEmptyNoMatchTitle("services"),
          section: "services",
          tone: "muted",
          clear: { label: "Clear search", onClick: () => setSearchQuery(""), dataAttr: "services-empty-clear-search" },
        }
      : propertyFilters.length > 0 && !lockedPropertyId
        ? {
            title: portalEmptyNoMatchTitle("services"),
            section: "services",
            tone: "muted",
            clear: { label: "Clear filters", onClick: () => setPropertyFilters([]), dataAttr: "services-empty-clear-filters" },
          }
        : {
            title: portalEmptyCopy(`services.${serviceState}` as PortalEmptyCopyKey).title,
            section: "services",
          };

  const servicesListIsEmpty = tabUnifiedRows.length === 0 || servicesSearchExcludesAll;

  const servicesListDestinations = (
    <LocalDestinationNav
      items={SERVICE_STATE_TABS.map((tab) => ({
        id: tab.id,
        label: tab.label,
        count: tab.id === "completed" ? unifiedCounts.completed + unifiedCounts.declined : unifiedCounts[tab.id],
        dataAttr: `manager-services-state-${tab.id}`,
      }))}
      activeId={serviceState}
      onChange={(id) => setServiceState(id as ServiceStage)}
      ariaLabel="Service status"
      appearance="command"
    />
  );

  const servicesBody = (
    <>
      {/*
        * Rows share one joined card with the header. An empty tab drops that outer
        * chrome: the empty card carries its own border, so keeping both drew a box
        * in a box. Empty = header card, then the one empty card (like Properties).
        */}
      <div
        className={cn("svc30", !servicesListIsEmpty && "overflow-hidden rounded-xl border border-border bg-card shadow-sm")}
        data-svc-page={serviceState}
        data-svc-empty={servicesListIsEmpty ? "true" : undefined}
      >
      <PortalListControlStack
        className={cn("plp-header-card", servicesListIsEmpty ? "mb-2 max-lg:mb-1.5" : "!border-0 !shadow-none !rounded-none bg-transparent")}
        variant="command"
        embedded={false}
        stickyDestinations={false}
        destinationRow={servicesListDestinations}
        search={{
          value: searchQuery,
          onChange: setSearchQuery,
          placeholder: "Search services",
          dataAttr: "services-list-search",
          ariaLabel: "Search services",
        }}
        actions={<>{servicesFilterSheet}{headerExtra}</>}
        primary={
          <PortalPrimaryIconAction
            label="Add service"
            data-attr="services-add-top"
            onClick={() => setAddServiceOpen(true)}
          />
        }
        activeFilterChips={<PortalActiveFilterChips chips={activeFilterChips} />}
      />
      <PortalRecordListSurface className={cn("plp-listsurface", !servicesListIsEmpty && "border-t border-border")} isEmpty={servicesListIsEmpty} emptyCard={servicesEmptyCard} onBulkClear={clearSelection} bulkCount={selectedIds.size} bulkActions={selectedIds.size > 0 ? (
        <>
          <PortalAdaptiveActionRow actions={bulkSelectionActions} />
        </>
      ) : null}>
          <div data-attr="services-flat-list">
            {visibleUnifiedRows.map((row) => renderServiceRow(row, Boolean(lockedPropertyId)))}
          </div>
      </PortalRecordListSurface>
      </div>

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

      <ServiceEditPopup
        open={editWorkOrderRow !== null}
        target={editWorkOrderRow ? { kind: "maintenance", row: editWorkOrderRow } : null}
        managerUserId={userId ?? null}
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
    </>
  );

  if (lockedPropertyId) return servicesBody;
  return (
    <ManagerPortalPageShell title="Services" hideTitleOnMobileNav titleInlineFilter={null} compactFilterRow>
      {servicesBody}
    </ManagerPortalPageShell>
  );
}

