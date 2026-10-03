"use client";

import { useEffect, useMemo, useState } from "react";
import { LeaseSendSheet } from "@/components/portal/lease-send-sheet";
import { ManagerLeasesPipelinePanel } from "@/components/portal/pro-leases-pipeline-panel";
import { ApplicationFilterSortFields } from "@/components/portal/application-filter-sort-fields";
import { PortalFilterSortSheet, portalFilterActiveCount } from "@/components/portal/portal-filter-sort-sheet";
import { PORTAL_PROPERTY_FILTER_SHEET_CLASS } from "@/components/portal/portal-filter-shell";
import { PortalActiveFilterChips } from "@/components/portal/portal-filter-chips";
import { PortalListControlStack } from "@/components/portal/portal-list-control-stack";
import { ManagerPortalPageShell } from "@/components/portal/portal-metrics";
import { PortalIconAction, PortalPrimaryIconAction } from "@/components/portal/portal-icon-action";
import { portalEmptyCopy, portalEmptyNoMatchTitle, portalEmptySibling, type PortalEmptyCopyKey } from "@/lib/portal-empty-copy";
import type { ManagerLeaseTab } from "@/data/demo-portal";
import { useManagerUserId } from "@/hooks/use-manager-user-id";
import {
  LEASE_PIPELINE_EVENT,
  countLeaseListTabs,
  readLeasePipeline,
  syncLeasePipelineFromServer,
} from "@/lib/lease-pipeline-storage";
import { MANAGER_APPLICATIONS_EVENT, syncManagerApplicationsFromServer } from "@/lib/manager-applications-storage";
import { buildManagerPropertyFilterOptions } from "@/lib/manager-portfolio-access";
import { syncPropertyPipelineFromServer } from "@/lib/demo-property-pipeline";
import { getPropertyById } from "@/lib/rental-application/data";
import { leaseDetailHref, leaseListHref } from "@/lib/portal-detail-routes";
import { usePortalNavigate } from "@/lib/portal-nav-client";
import { AGENT_PENDING_ACTIONS_EVENT } from "@/lib/axis-assistant/pending-actions-events";

/**
 * Three stages, the replica's: Draft, Sent, Signed. "Sent" holds every lease out
 * for signature — waiting on the resident and waiting on the manager's
 * countersignature — so a lease never sits in a stage of its own just because
 * of whose turn it is. The route ids are unchanged (`manager`, `resident`,
 * `completed`); a legacy `/leases/signed` link lands on Sent.
 */
const LEASE_LABELS: { id: "manager" | "resident" | "completed"; label: string; dataAttr: string }[] = [
  { id: "manager", label: "Draft", dataAttr: "leases-tab-manager" },
  { id: "resident", label: "Sent", dataAttr: "leases-tab-resident" },
  { id: "completed", label: "Signed", dataAttr: "leases-tab-completed" },
];

export function ManagerLeases({
  tab: tabProp = "manager",
  basePath = "/portal",
  leaseId: leaseIdProp,
  leaseDetailTab,
}: {
  tab?: ManagerLeaseTab;
  basePath?: string;
  leaseId?: string;
  /** The lease record's own rail tab (docs/agents/record-page.md); undefined = Overview. */
  leaseDetailTab?: import("@/lib/portal-detail-routes").LeaseDetailTabId;
}) {
  const navigate = usePortalNavigate();
  const { userId, ready: authReady } = useManagerUserId();
  const listTabProp: ManagerLeaseTab = tabProp === "signed" ? "resident" : tabProp;
  const [tab, setTab] = useState<ManagerLeaseTab>(listTabProp);
  const [prevTabProp, setPrevTabProp] = useState(listTabProp);
  if (listTabProp !== prevTabProp) {
    setPrevTabProp(listTabProp);
    if (tab !== listTabProp) setTab(listTabProp);
  }
  const [tick, setTick] = useState(0);
  const [propertyTick, setPropertyTick] = useState(0);
  const [propertyFilters, setPropertyFilters] = useState<string[]>([]);
  const [listSearch, setListSearch] = useState("");
  const [clientReady, setClientReady] = useState(false);
  const [addLeaseOpen, setAddLeaseOpen] = useState(false);

  useEffect(() => {
    queueMicrotask(() => setClientReady(true));
  }, []);

  useEffect(() => {
    if (!authReady || !userId) return;
    const on = () => setTick((t) => t + 1);
    void Promise.all([
      syncManagerApplicationsFromServer({ managerUserId: userId }),
      syncLeasePipelineFromServer(userId),
    ]).then(on);
    const onAgentActions = () => {
      void syncLeasePipelineFromServer(userId, { force: true }).then(on);
    };
    window.addEventListener(LEASE_PIPELINE_EVENT, on);
    window.addEventListener(MANAGER_APPLICATIONS_EVENT, on);
    window.addEventListener(AGENT_PENDING_ACTIONS_EVENT, onAgentActions);
    return () => {
      window.removeEventListener(LEASE_PIPELINE_EVENT, on);
      window.removeEventListener(MANAGER_APPLICATIONS_EVENT, on);
      window.removeEventListener(AGENT_PENDING_ACTIONS_EVENT, onAgentActions);
    };
  }, [authReady, userId]);

  useEffect(() => {
    if (!authReady || !userId) return;
    void syncPropertyPipelineFromServer().then(() => setPropertyTick((t) => t + 1));
  }, [authReady, userId]);

  const propertyOptions = useMemo(() => {
    if (!clientReady) return [];
    void tick;
    void propertyTick;
    const base = buildManagerPropertyFilterOptions(userId);
    const labelById = new Map(base.map((option) => [option.id, option.label]));
    for (const row of readLeasePipeline(userId)) {
      const propertyId = row.application?.propertyId?.trim();
      if (!propertyId || labelById.has(propertyId)) continue;
      labelById.set(propertyId, getPropertyById(propertyId)?.title?.trim() || row.unit || propertyId);
    }
    return [...labelById.entries()]
      .map(([id, label]) => ({ id, label }))
      .sort((a, b) => a.label.localeCompare(b.label, undefined, { sensitivity: "base" }));
  }, [clientReady, userId, tick, propertyTick]);

  const propertyFilterLabel = useMemo(() => {
    if (propertyFilters.length === 0) return "";
    if (propertyFilters.length === 1) {
      return propertyOptions.find((option) => option.id === propertyFilters[0])?.label ?? propertyFilters[0];
    }
    return `${propertyFilters.length} properties`;
  }, [propertyFilters, propertyOptions]);

  const rows = useMemo(() => {
    if (!clientReady) return [];
    void tick;
    const allRows = readLeasePipeline(userId);
    if (propertyFilters.length === 0) return allRows;
    return allRows.filter((row) => propertyFilters.includes(row.application?.propertyId?.trim() ?? ""));
  }, [clientReady, tick, propertyFilters, userId]);

  const counts = useMemo(() => countLeaseListTabs(rows), [rows]);
  const tabs = useMemo(
    () => LEASE_LABELS.map(({ id, label, dataAttr }) => ({ id, label, count: counts[id], dataAttr })),
    [counts],
  );
  const leasesFilterSheet = (
    <PortalFilterSortSheet
      activeCount={portalFilterActiveCount([propertyFilters])}
      compactPanel
      commandStripTrigger
      filterFieldCount={1}
      constrainDropdownToTitleBand={false}
      mobileFlushBody
      className={PORTAL_PROPERTY_FILTER_SHEET_CLASS}
      onReset={() => setPropertyFilters([])}
      dataAttr="leases-filter-sheet-open"
    >
      <ApplicationFilterSortFields
        propertyOptions={propertyOptions}
        propertyFilters={propertyFilters}
        onPropertyFiltersChange={setPropertyFilters}
        dataAttr="leases-filter-property"
      />
    </PortalFilterSortSheet>
  );

  const leasesListActions = <>{leasesFilterSheet}</>;

  const openLeaseAfterSend = (leaseId: string) => {
    navigate(leaseDetailHref(basePath, "resident", leaseId));
  };

  const modals = (
    <>
      {/* The + is Send lease: the one screen, with a resident picker on top (it replaced the Add lease wizard). */}
      <LeaseSendSheet
        open={addLeaseOpen}
        pickResident
        managerUserId={userId}
        onClose={() => setAddLeaseOpen(false)}
        onSent={(leaseId) => {
          setTick((n) => n + 1);
          openLeaseAfterSend(leaseId);
        }}
      />
    </>
  );

  if (leaseIdProp) {
    return (
      <>
        <ManagerLeasesPipelinePanel
          rows={rows}
          tab={tab}
          refreshKey={tick}
          managerUserId={userId}
          leaseId={leaseIdProp}
          leaseDetailTab={leaseDetailTab}
          listBasePath={basePath}
          onAddLease={() => setAddLeaseOpen(true)}
        />
        {modals}
      </>
    );
  }

  return (
    <>
      <ManagerPortalPageShell
        title="Leases"
          titleInlineFilter={null}
        hideTitleOnMobileNav
        compactFilterRow
      >
        <PortalListControlStack
          className="mb-2 max-lg:mb-1.5"
          variant="command"
          destinations={tabs.map((t) => ({
            id: t.id,
            label: t.label,
            href: leaseListHref(basePath, t.id),
            count: t.count,
            dataAttr: t.dataAttr,
          }))}
          activeDestinationId={tab}
          destinationAriaLabel="Lease pipeline stage"
          search={{
            value: listSearch,
            onChange: setListSearch,
            placeholder: "Search leases",
            dataAttr: "leases-search",
          }}
          actions={leasesListActions}
          primary={
            <PortalPrimaryIconAction
              label="Send lease"
              data-attr="leases-add-top"
              onClick={() => setAddLeaseOpen(true)}
            />
          }
          activeFilterChips={
            propertyFilters.length > 0 ? (
              <PortalActiveFilterChips
                chips={[
                  {
                    id: "property",
                    label: `Property: ${propertyFilterLabel}`,
                    onRemove: () => setPropertyFilters([]),
                  },
                ]}
              />
            ) : null
          }
        />
        <ManagerLeasesPipelinePanel
          rows={rows}
          tab={tab}
          refreshKey={tick}
          managerUserId={userId}
          leaseId={leaseIdProp}
          leaseDetailTab={leaseDetailTab}
          listBasePath={basePath}
          onAddLease={() => setAddLeaseOpen(true)}
          searchQuery={listSearch}
          onClearSearch={() => setListSearch("")}
          emptyCard={
            propertyFilters.length > 0
              ? {
                  title: portalEmptyNoMatchTitle("leases"),
                  section: "leases",
                  tone: "muted",
                  clear: { label: "Clear filters", onClick: () => setPropertyFilters([]), dataAttr: "leases-empty-clear-filters" },
                }
              : {
                  title: portalEmptyCopy(`leases.${tab}` as PortalEmptyCopyKey).title,
                  section: "leases",
                  sibling: portalEmptySibling(
                    tabs.map((t) => ({ id: t.id, label: t.label, count: t.count, href: leaseListHref(basePath, t.id) })),
                    tab,
                  ),
                  // A lease waits on the resident or on your signature — adding one there
                  // would land in Manager review, so only the tabs a new lease reaches offer the pill.
                  actions:
                    tab === "resident" || tab === "signed"
                      ? []
                      : [{ label: "Send lease", onClick: () => setAddLeaseOpen(true), dataAttr: "leases-list-add" }],
                }
          }
        />
      </ManagerPortalPageShell>
      {modals}
    </>
  );
}
