"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { CalendarDays, Wrench } from "lucide-react";
import { FieldSingleSelect } from "@/components/ui/checkbox-multi-select";
import { PortalDialog } from "@/components/portal/portal-dialog";
import { RecordBandFilter, RecordListBand } from "@/components/portal/record-list-band";
import { PortalApplicantRecordRow, PortalRowFact } from "@/components/portal/portal-record-row";
import { useAppUi } from "@/components/providers/app-ui-provider";
import {
  MANAGER_WORK_ORDERS_EVENT,
  readManagerWorkOrderRows,
  syncManagerWorkOrdersFromServer,
} from "@/lib/manager-work-orders-storage";
import { formatServiceMoney } from "@/lib/manager-service-workflow";
import { matchesPortalListSearch } from "@/lib/portal-list-search";
import { portalEmptyNoMatchTitle } from "@/lib/portal-empty-copy";
import { workOrderDetailHref } from "@/lib/portal-detail-routes";
import { SERVICE_STAGE_LABEL } from "@/lib/service-stage-ids";
import {
  VENDOR_SERVICE_BUCKETS,
  buildVendorServiceItems,
  countVendorServiceBuckets,
  type VendorServiceBucket,
} from "@/lib/vendor-record-services";
import { fetchWorkOrderBids, type WorkOrderBid } from "@/lib/work-order-bids";
import { fetchWorkOrderVendorOffers, sendWorkOrderToVendors, type WorkOrderVendorOffer } from "@/lib/work-order-vendor-offers";

const NEW_SERVICE = "__new__";

/**
 * A vendor record's Services tab: Open · Assigned · Scheduled · Completed, with the same shared row as
 * the Services page and this vendor's own estimate/bid figure. The + requests a bid from this vendor
 * on an open service, or creates a new service assigned to them.
 */
export function VendorRecordServicesTab({
  vendorId,
  vendorName,
  vendorUserId,
  basePath,
  onNavigate,
  onCreateService,
}: {
  vendorId: string;
  vendorName: string;
  vendorUserId?: string | null;
  basePath: string;
  onNavigate: (href: string) => void;
  /** Opens the create-a-service flow already assigned to this vendor. */
  onCreateService: () => void;
}) {
  const { showToast } = useAppUi();
  const [tab, setTab] = useState<VendorServiceBucket>("open");
  const [search, setSearch] = useState("");
  const [propertyFilter, setPropertyFilter] = useState("");
  const [tick, setTick] = useState(0);
  const [bids, setBids] = useState<WorkOrderBid[]>([]);
  const [offers, setOffers] = useState<WorkOrderVendorOffer[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [requestOpen, setRequestOpen] = useState(false);
  const [pick, setPick] = useState(NEW_SERVICE);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void syncManagerWorkOrdersFromServer();
    const bump = () => setTick((n) => n + 1);
    window.addEventListener(MANAGER_WORK_ORDERS_EVENT, bump);
    void Promise.all([fetchWorkOrderBids(), fetchWorkOrderVendorOffers()]).then(([nextBids, nextOffers]) => {
      if (cancelled) return;
      setBids(nextBids);
      setOffers(nextOffers);
      setLoaded(true);
    });
    return () => {
      cancelled = true;
      window.removeEventListener(MANAGER_WORK_ORDERS_EVENT, bump);
    };
  }, [tick]);

  const workOrders = useMemo(() => {
    void tick;
    return readManagerWorkOrderRows();
  }, [tick]);

  const items = useMemo(
    () => buildVendorServiceItems({ vendorId, vendorUserId, workOrders, bids, offers }),
    [vendorId, vendorUserId, workOrders, bids, offers],
  );
  const counts = useMemo(() => countVendorServiceBuckets(items), [items]);
  const shown = useMemo(
    () =>
      items.filter(
        (item) =>
          item.bucket === tab &&
          (!propertyFilter || item.propertyName === propertyFilter) &&
          matchesPortalListSearch(search, item.title, item.propertyName, item.unit),
      ),
    [items, tab, search, propertyFilter],
  );

  const propertyOptions = useMemo(
    () => [...new Set(items.map((item) => item.propertyName).filter((name) => name && name !== "—"))].sort().map((name) => ({ value: name, label: name })),
    [items],
  );

  // Open services this vendor has not been asked about yet.
  const requestable = useMemo(() => {
    const requestedIds = new Set(items.map((item) => item.workOrderId));
    return workOrders.filter((wo) => wo.bucket === "open" && !wo.vendorId && !wo.selfAssigned && !requestedIds.has(wo.id));
  }, [items, workOrders]);

  const submitRequest = useCallback(async () => {
    if (pick === NEW_SERVICE) {
      setRequestOpen(false);
      onCreateService();
      return;
    }
    setBusy(true);
    try {
      const result = await sendWorkOrderToVendors(pick, [vendorId]);
      if (!result.ok) throw new Error(result.error ?? "Could not request this vendor.");
      showToast(`Requested ${vendorName}.`);
      setRequestOpen(false);
      setTick((n) => n + 1);
    } catch (e) {
      showToast(e instanceof Error ? e.message : "Could not request this vendor.");
    } finally {
      setBusy(false);
    }
  }, [onCreateService, pick, showToast, vendorId, vendorName]);

  return (
    <>
      <RecordListBand
        dataAttr="vendor-services-list"
        ariaLabel="Service status"
        tabs={VENDOR_SERVICE_BUCKETS.map((bucket) => ({ id: bucket.id, label: bucket.label, count: counts[bucket.id] }))}
        activeId={tab}
        onChange={(id) => setTab(id as VendorServiceBucket)}
        search={{ value: search, onChange: setSearch, placeholder: "Search services" }}
        actions={
          <RecordBandFilter
            dataAttr="vendor-services-list"
            fields={
              propertyOptions.length > 0
                ? [{ id: "property", label: "Property", anyLabel: "Any property", value: propertyFilter, options: propertyOptions, onChange: setPropertyFilter }]
                : []
            }
          />
        }
        plus={{
          label: "Request a bid",
          dataAttr: "vendor-services-add",
          onClick: () => {
            setPick(requestable.length > 0 ? requestable[0]!.id : NEW_SERVICE);
            setRequestOpen(true);
          },
        }}
        loading={!loaded}
        isEmpty={shown.length === 0}
        emptyTitle={search.trim() || propertyFilter ? portalEmptyNoMatchTitle("services", search) : `No ${SERVICE_STAGE_LABEL[tab].toLowerCase()} services with ${vendorName}`}
      >
        {shown.map((item) => (
          <PortalApplicantRecordRow
            key={item.workOrderId}
            name={item.title}
            tileIcon={Wrench}
            address={[item.propertyName === "—" ? "" : item.propertyName, item.unit && item.unit !== "—" ? item.unit : ""].filter(Boolean).join(" · ") || undefined}
            facts={<PortalRowFact icon={CalendarDays}>{item.fact}</PortalRowFact>}
            amount={item.figureCents != null ? formatServiceMoney(item.figureCents) : undefined}
            amountSubLabel={item.figureLabel}
            onOpen={() => {
              const wo = workOrders.find((w) => w.id === item.workOrderId);
              onNavigate(workOrderDetailHref(basePath, wo?.bucket ?? "open", item.workOrderId, item.needsDecision ? "vendors" : undefined));
            }}
            dataAttr="vendor-service-row"
            rowId={item.workOrderId}
          />
        ))}
      </RecordListBand>

      <PortalDialog
        open={requestOpen}
        onClose={() => {
          if (!busy) setRequestOpen(false);
        }}
        dismissBlocked={busy}
        title={`Request a bid from ${vendorName}`}
        primaryAction={{
          label: pick === NEW_SERVICE ? "Create service" : "Request a bid",
          onClick: () => void submitRequest(),
          loading: busy,
          disabled: busy,
          dataAttr: "vendor-services-request-submit",
        }}
      >
        <FieldSingleSelect
          label="Service"
          value={pick}
          onChange={setPick}
          options={[
            ...requestable.map((wo) => ({ value: wo.id, label: `${wo.title} · ${wo.propertyName}` })),
            { value: NEW_SERVICE, label: "New service" },
          ]}
          dataAttr="vendor-services-request-select"
        />
      </PortalDialog>
    </>
  );
}
