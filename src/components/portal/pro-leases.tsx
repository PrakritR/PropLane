"use client";

import { useEffect, useMemo, useState } from "react";
import { LeaseSendSheet } from "@/components/portal/lease-send-sheet";
import { ManagerLeasesPipelinePanel } from "@/components/portal/pro-leases-pipeline-panel";
import {
  LeaseFilterFields,
  leaseUpdatedWindowLabel,
  leaseUpdatedWithinWindow,
  type LeaseUpdatedWindow,
} from "@/components/portal/lease-filter-fields";
import { ManagerSettingsGear } from "@/components/portal/manager-settings-gear";
import { PortalFilterSortSheet, portalFilterActiveCount } from "@/components/portal/portal-filter-sort-sheet";
import { PORTAL_PROPERTY_FILTER_SHEET_CLASS } from "@/components/portal/portal-filter-shell";
import { PortalActiveFilterChips } from "@/components/portal/portal-filter-chips";
import { PortalListControlStack, portalListAddPrimaryLabel } from "@/components/portal/portal-list-control-stack";
import { ManagerPortalPageShell } from "@/components/portal/portal-metrics";
import { PortalPrimaryIconAction } from "@/components/portal/portal-icon-action";
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
 * Four stages, in this order: Draft, Resident signature, Manager signature, Signed. Draft is a
 * lease not yet sent to the resident; after that a lease sits in the stage of whose turn it is — a
 * lease in review and the manager's countersignature are both Manager signature. The route ids
 * are `draft`, `resident`, `manager`, `completed`; a legacy `/leases/signed` link lands on Manager
 * signature, and the first tab (Draft) is the default.
 */
const LEASE_LABELS: { id: "draft" | "manager" | "resident" | "completed"; label: string; dataAttr: string }[] = [
  { id: "draft", label: "Draft", dataAttr: "leases-tab-draft" },
  { id: "resident", label: "Resident signature", dataAttr: "leases-tab-resident" },
  { id: "manager", label: "Manager signature", dataAttr: "leases-tab-manager" },
  { id: "completed", label: "Signed", dataAttr: "leases-tab-completed" },
];

export function ManagerLeases({
  tab: tabProp = "draft",
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
  const listTabProp: ManagerLeaseTab = tabProp === "signed" ? "manager" : tabProp;
  const [tab, setTab] = useState<ManagerLeaseTab>(listTabProp);
  const [prevTabProp, setPrevTabProp] = useState(listTabProp);
  if (listTabProp !== prevTabProp) {
    setPrevTabProp(listTabProp);
    if (tab !== listTabProp) setTab(listTabProp);
  }
  const [tick, setTick] = useState(0);
  const [propertyTick, setPropertyTick] = useState(0);
  const [propertyFilters, setPropertyFilters] = useState<string[]>([]);
  const [stageFilters, setStageFilters] = useState<string[]>([]);
  const [updatedWindow, setUpdatedWindow] = useState<LeaseUpdatedWindow>("any");
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

  const stageOptions = useMemo(() => {
    if (!clientReady) return [];
    void tick;
    const seen = new Set<string>();
    for (const row of readLeasePipeline(userId)) {
      const label = row.stageLabel?.trim();
      if (label && label !== "—") seen.add(label);
    }
    return [...seen].sort((a, b) => a.localeCompare(b)).map((label) => ({ value: label, label }));
  }, [clientReady, tick, userId]);

  const rows = useMemo(() => {
    if (!clientReady) return [];
    void tick;
    const now = Date.now();
    return readLeasePipeline(userId).filter(
      (row) =>
        (propertyFilters.length === 0 || propertyFilters.includes(row.application?.propertyId?.trim() ?? "")) &&
        (stageFilters.length === 0 || stageFilters.includes(row.stageLabel?.trim() ?? "")) &&
        leaseUpdatedWithinWindow(row.updatedAtIso, updatedWindow, now),
    );
  }, [clientReady, tick, propertyFilters, stageFilters, updatedWindow, userId]);

  const hasActiveFilters = propertyFilters.length > 0 || stageFilters.length > 0 || updatedWindow !== "any";
  const clearAllFilters = () => {
    setPropertyFilters([]);
    setStageFilters([]);
    setUpdatedWindow("any");
  };

  const counts = useMemo(() => countLeaseListTabs(rows), [rows]);
  const tabs = useMemo(
    () => LEASE_LABELS.map(({ id, label, dataAttr }) => ({ id, label, count: counts[id], dataAttr })),
    [counts],
  );
  const leasesFilterSheet = (
    <PortalFilterSortSheet
      activeCount={portalFilterActiveCount([propertyFilters, stageFilters, updatedWindow === "any" ? "" : updatedWindow])}
      compactPanel
      commandStripTrigger
      filterFieldCount={3}
      constrainDropdownToTitleBand={false}
      mobileFlushBody
      className={PORTAL_PROPERTY_FILTER_SHEET_CLASS}
      onReset={clearAllFilters}
      dataAttr="leases-filter-sheet-open"
    >
      <LeaseFilterFields
        propertyOptions={propertyOptions}
        propertyFilters={propertyFilters}
        onPropertyFiltersChange={setPropertyFilters}
        stageOptions={stageOptions}
        stageFilters={stageFilters}
        onStageFiltersChange={setStageFilters}
        updatedWindow={updatedWindow}
        onUpdatedWindowChange={setUpdatedWindow}
      />
    </PortalFilterSortSheet>
  );

  // Header order: Filter · Settings · round +. Upload is not a header icon: the + opens Send lease,
  // whose own "Start from a file" card reads an uploaded lease. The gear opens the Leases section
  // of Settings -> Automations (deposit accounting, auto-send), never a pop-up.
  const leasesListActions = (
    <>
      {leasesFilterSheet}
      <ManagerSettingsGear target="leases" label="Lease settings" />
    </>
  );

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
              label={portalListAddPrimaryLabel("lease")}
              data-attr="leases-add-top"
              onClick={() => setAddLeaseOpen(true)}
            />
          }
          activeFilterChips={
            hasActiveFilters ? (
              <PortalActiveFilterChips
                chips={[
                  ...(propertyFilters.length > 0
                    ? [{ id: "property", label: `Property: ${propertyFilterLabel}`, onRemove: () => setPropertyFilters([]) }]
                    : []),
                  ...(stageFilters.length > 0
                    ? [
                        {
                          id: "stage",
                          label: `Stage: ${stageFilters.length === 1 ? stageFilters[0] : `${stageFilters.length} stages`}`,
                          onRemove: () => setStageFilters([]),
                        },
                      ]
                    : []),
                  ...(updatedWindow !== "any"
                    ? [{ id: "updated", label: `Updated: ${leaseUpdatedWindowLabel(updatedWindow)}`, onRemove: () => setUpdatedWindow("any") }]
                    : []),
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
            hasActiveFilters
              ? {
                  title: portalEmptyNoMatchTitle("leases"),
                  section: "leases",
                  tone: "muted",
                  clear: { label: "Clear filters", onClick: clearAllFilters, dataAttr: "leases-empty-clear-filters" },
                }
              : {
                  title: portalEmptyCopy(`leases.${tab}` as PortalEmptyCopyKey).title,
                  section: "leases",
                  sibling: portalEmptySibling(
                    tabs.map((t) => ({ id: t.id, label: t.label, count: t.count, href: leaseListHref(basePath, t.id) })),
                    tab,
                  ),
                  // A lease waiting on the resident is already out — a new one starts in Manager
                  // signature, so only the tabs a new lease reaches offer the pill.
                  actions:
                    tab === "resident"
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
