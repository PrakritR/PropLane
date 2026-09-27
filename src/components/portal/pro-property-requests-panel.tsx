"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import { ServiceRequestCatalogEditor } from "@/components/portal/service-request-catalog-editor";
import { PortalPropertySectionToolbar } from "@/components/portal/portal-property-section-toolbar";
import { PortalPropertySectionSettingsModal } from "@/components/portal/portal-property-section-settings-modal";
import { PortalRecordListSurface } from "@/components/portal/portal-record-list-surface";
import { PortalServiceRecordRow } from "@/components/portal/portal-record-row";
import { ManagerAddServiceModal } from "@/components/portal/pro-add-service-modal";
import { usePortalNavigate } from "@/lib/portal-nav-client";
import { samePropertyId } from "@/lib/co-manager-calendar";
import { moduleRowVisibleToPortalUser } from "@/lib/manager-portfolio-access";
import { formatServiceVisitLabel } from "@/lib/schedule-service-visit";
import {
  readManagerWorkOrderRows,
  syncManagerWorkOrdersFromServer,
  MANAGER_WORK_ORDERS_EVENT,
} from "@/lib/manager-work-orders-storage";
import {
  readAllServiceRequests,
  syncServiceRequestsFromServer,
  SERVICE_REQUESTS_EVENT,
} from "@/lib/service-requests-storage";
import { serviceRequestDetailHref } from "@/lib/portal-detail-routes";
import { managerServiceRequestBucket } from "@/components/portal/pro-service-request-detail";
import {
  buildUnifiedServiceRows,
  type ServiceRowState,
} from "@/lib/unified-service-rows";
import { type ManagerListingSubmissionV1 } from "@/lib/manager-listing-submission";

type RequestsSaveTarget =
  | { mode: "pending"; saveId: string }
  | { mode: "listing"; saveId: string }
  | { mode: "requestChange"; saveId: string }
  | null;

const STATUS_OPTIONS: { value: ServiceRowState; label: string }[] = [
  { value: "open", label: "Open" },
  { value: "scheduled", label: "Scheduled" },
  { value: "done", label: "Done" },
  { value: "declined", label: "Declined" },
];

/**
 * Per-property Services tab (S015/S016/S017, captain 2026-09-27): the round
 * blue + reuses the EXISTING `ManagerAddServiceModal` add flow, pre-scoped to
 * this property. The service TYPES catalog (allow/deny + prices — "Other
 * service types") that used to render inline here now lives behind the
 * Settings gear, moved verbatim rather than rebuilt.
 */
export function ManagerPropertyRequestsPanel({
  sub,
  saveTarget,
  managerUserId,
  onUpdated,
  showToast,
  onBulkActionsChange,
  propertyId,
  propertyLabel,
  propertiesBase,
}: {
  sub: ManagerListingSubmissionV1;
  saveTarget: RequestsSaveTarget;
  managerUserId: string | null;
  onUpdated: () => void;
  showToast: (m: string) => void;
  onBulkActionsChange?: (actions: ReactNode | null) => void;
  /** The real property row id — for scoping the live request/work-order list and the add flow. */
  propertyId?: string | null;
  propertyLabel?: string;
  /** Manager portal root ("/portal") — for linking a row to its own real record. */
  propertiesBase?: string;
}) {
  const navigate = usePortalNavigate();
  const [dataTick, setDataTick] = useState(0);
  const [statusFilter, setStatusFilter] = useState<string[]>(STATUS_OPTIONS.map((o) => o.value));
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [addServiceOpen, setAddServiceOpen] = useState(false);

  useEffect(() => {
    if (!managerUserId) return;
    void syncServiceRequestsFromServer({ force: true });
    void syncManagerWorkOrdersFromServer({ force: true });
    const bump = () => setDataTick((t) => t + 1);
    window.addEventListener(SERVICE_REQUESTS_EVENT, bump);
    window.addEventListener(MANAGER_WORK_ORDERS_EVENT, bump);
    return () => {
      window.removeEventListener(SERVICE_REQUESTS_EVENT, bump);
      window.removeEventListener(MANAGER_WORK_ORDERS_EVENT, bump);
    };
  }, [managerUserId]);

  const scopedAddOns = useMemo(() => {
    void dataTick;
    const id = propertyId?.trim();
    if (!managerUserId || !id) return [];
    return readAllServiceRequests()
      .filter((r) => moduleRowVisibleToPortalUser(r, managerUserId, "services"))
      .filter((r) => samePropertyId(r.propertyId, id));
  }, [managerUserId, propertyId, dataTick]);

  const scopedWorkOrders = useMemo(() => {
    void dataTick;
    const id = propertyId?.trim();
    if (!managerUserId || !id) return [];
    return readManagerWorkOrderRows()
      .filter((r) => moduleRowVisibleToPortalUser(r, managerUserId, "services"))
      .filter((r) => samePropertyId(r.propertyId, id));
  }, [managerUserId, propertyId, dataTick]);

  const unifiedRows = useMemo(
    () =>
      buildUnifiedServiceRows({
        addOns: scopedAddOns,
        maintenance: scopedWorkOrders,
        propertyLabelForRequest: () => propertyLabel,
      }),
    [scopedAddOns, scopedWorkOrders, propertyLabel],
  );

  const visibleRows = useMemo(
    () => unifiedRows.filter((row) => statusFilter.includes(row.state)),
    [unifiedRows, statusFilter],
  );

  if (!saveTarget || !managerUserId) return null;

  const basePath = propertiesBase ?? "/portal";

  return (
    <>
      <PortalPropertySectionToolbar
        filter={{
          label: "Status",
          options: STATUS_OPTIONS,
          selected: statusFilter,
          onChange: setStatusFilter,
          dataAttr: "property-services-filter",
        }}
        onSettings={() => setSettingsOpen(true)}
        settingsLabel="Service settings"
        settingsDataAttr="property-services-settings-open"
        onAdd={propertyId ? () => setAddServiceOpen(true) : undefined}
        addLabel="Add service"
        addDataAttr="property-services-add-top"
      />

      <PortalRecordListSurface
        className="mt-0"
        isEmpty={visibleRows.length === 0}
        emptyCard={{
          title: statusFilter.length < STATUS_OPTIONS.length ? "No services match this filter" : "No services yet",
          section: "services",
        }}
      >
        {visibleRows.map((row) => {
          const subtitleParts = [
            row.statusLabel,
            row.scheduledIso ? `Scheduled ${formatServiceVisitLabel(row.scheduledIso)}` : null,
          ].filter(Boolean);
          return (
            <PortalServiceRecordRow
              key={`${row.kind}::${row.id}`}
              title={row.title}
              subtitle={subtitleParts.join(" · ") || undefined}
              onOpen={() => {
                if (row.kind === "add-on") {
                  const raw = scopedAddOns.find((r) => r.id === row.id);
                  navigate(serviceRequestDetailHref(basePath, managerServiceRequestBucket(raw?.status ?? "pending"), row.id));
                  return;
                }
                const raw = scopedWorkOrders.find((r) => r.id === row.id);
                navigate(`${basePath}/services/work-orders/${raw?.bucket ?? "open"}/${encodeURIComponent(row.id)}`);
              }}
              dataAttr={row.kind === "add-on" ? "property-service-request-row" : "property-work-order-row"}
            />
          );
        })}
      </PortalRecordListSurface>

      <PortalPropertySectionSettingsModal
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        title="Service settings"
        propertyLabel={propertyLabel ?? "This property"}
        dataAttr="property-services-settings"
      >
        <ServiceRequestCatalogEditor
          sub={sub}
          saveTarget={saveTarget}
          managerUserId={managerUserId}
          onUpdated={onUpdated}
          showToast={showToast}
          onBulkActionsChange={onBulkActionsChange}
        />
      </PortalPropertySectionSettingsModal>

      {propertyId ? (
        <ManagerAddServiceModal
          open={addServiceOpen}
          onClose={() => setAddServiceOpen(false)}
          managerUserId={managerUserId}
          defaultPropertyId={propertyId}
          onSubmitted={() => {
            setDataTick((t) => t + 1);
            setAddServiceOpen(false);
          }}
        />
      ) : null}
    </>
  );
}
