"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { Button } from "@/components/ui/button";
import { useAppUi } from "@/components/providers/app-ui-provider";
import { PortalDataTableEmpty } from "@/components/portal/portal-data-table";
import {
  ManagerPortalFilterRow,
  ManagerPortalPageShell,
  ManagerPortalStatusPills,
} from "@/components/portal/portal-metrics";
import { PortalRecordListSurface } from "@/components/portal/portal-record-list-surface";
import { PortalPropertyRecordRow } from "@/components/portal/portal-record-row";
import { PORTAL_BULK_BAR_BTN } from "@/lib/portal-bulk-bar";
import { PROPERTY_PIPELINE_EVENT, syncPropertyPipelineFromServer } from "@/lib/demo-property-pipeline";
import {
  adminKpiCounts,
  adminPropertyRentDisplayLabel,
  listAdminRow,
  publicListingHrefForPropertyRow,
  readAdminPropertyRows,
  unlistManagerListing,
  type AdminPropertyBucketIndex,
} from "@/lib/demo-admin-property-inventory";

/** Admin inventory tabs — listed ↔ unlisted only (no approval queue). */
const KPI_TABS: { bucket: AdminPropertyBucketIndex; label: string }[] = [
  { bucket: 2, label: "Listed" },
  { bucket: 3, label: "Unlisted" },
];

const TAB_PARAM_BY_BUCKET: Partial<Record<AdminPropertyBucketIndex, string>> = {
  2: "listed",
  3: "unlisted",
};

function bucketFromTabParam(tab: string | null): AdminPropertyBucketIndex | null {
  if (!tab) return null;
  if (tab === "pending" || tab === "request-change" || tab === "rejected") return 2;
  const entry = Object.entries(TAB_PARAM_BY_BUCKET).find(([, value]) => value === tab);
  return entry ? (Number(entry[0]) as AdminPropertyBucketIndex) : null;
}

const EMPTY_COPY: Partial<Record<AdminPropertyBucketIndex, string>> = {
  2: "No listed properties.",
  3: "No unlisted properties.",
};

export function AdminPropertiesClient() {
  const { showToast } = useAppUi();
  const searchParams = useSearchParams();
  const [activeKpi, setActiveKpi] = useState<AdminPropertyBucketIndex>(2);
  const [tick, setTick] = useState(0);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());

  const clearSelection = useCallback(() => setSelectedIds(new Set()), []);
  const toggleSelected = useCallback((key: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  useEffect(() => {
    const fromUrl = bucketFromTabParam(searchParams.get("tab"));
    if (fromUrl != null) setActiveKpi(fromUrl);
  }, [searchParams]);

  useEffect(() => {
    void syncPropertyPipelineFromServer().then(() => {
      setTick((t) => t + 1);
    });
    const on = () => setTick((t) => t + 1);
    window.addEventListener(PROPERTY_PIPELINE_EVENT, on);
    window.addEventListener("storage", on);
    return () => {
      window.removeEventListener(PROPERTY_PIPELINE_EVENT, on);
      window.removeEventListener("storage", on);
    };
  }, []);

  const kpiValues = useMemo(() => {
    void tick;
    return adminKpiCounts();
  }, [tick]);
  const rows = useMemo(() => {
    void tick;
    return readAdminPropertyRows(activeKpi);
  }, [tick, activeKpi]);
  const kpiTabs = useMemo(
    () => KPI_TABS.map(({ bucket, label }) => ({ id: String(bucket), label, count: kpiValues[bucket] })),
    [kpiValues],
  );

  const selectedRows = useMemo(
    () => rows.filter((row) => selectedIds.has(row.adminRefId + (row.listingId ?? ""))),
    [rows, selectedIds],
  );
  const singleSelected = selectedRows.length === 1 ? selectedRows[0]! : null;

  const runAction = (label: string, ok: boolean, err = "Action could not be completed.") => {
    if (!ok) {
      showToast(err);
      return;
    }
    showToast(label);
    setTick((t) => t + 1);
    clearSelection();
  };

  /**
   * View listing and Unlist — and List, for an unlisted row.
   *
   * Staff act on the public catalog, not the content: there is no edit here,
   * because the listing belongs to the manager who wrote it. "View listing"
   * opens the page a prospect sees, which is the honest way to check one
   * without handing staff an editor.
   */
  const bulkActions = singleSelected ? (
    <div className="flex min-w-0 flex-wrap items-center justify-start gap-2">
      {publicListingHrefForPropertyRow(singleSelected) ? (
        <Button
          type="button"
          variant="outline"
          className={PORTAL_BULK_BAR_BTN}
          data-attr="admin-property-view-listing"
          onClick={() => window.open(publicListingHrefForPropertyRow(singleSelected)!, "_blank", "noopener")}
        >
          View listing
        </Button>
      ) : null}
      {activeKpi === 2 && singleSelected.listingId ? (
        <Button
          type="button"
          variant="outline"
          className={`${PORTAL_BULK_BAR_BTN} border-rose-200 text-rose-800 hover:bg-[var(--status-overdue-bg)] portal-danger-outline`}
          data-attr="admin-property-unlist"
          onClick={() =>
            runAction("Unlisted property.", unlistManagerListing(singleSelected.listingId!))
          }
        >
          Unlist
        </Button>
      ) : null}
      {activeKpi === 3 ? (
        <Button
          type="button"
          variant="outline"
          className={PORTAL_BULK_BAR_BTN}
          data-attr="admin-property-list"
          onClick={() => {
            const id = listAdminRow(singleSelected);
            runAction(id ? "Property listed." : "Could not list property.", Boolean(id));
          }}
        >
          List
        </Button>
      ) : null}
    </div>
  ) : null;

  return (
    <ManagerPortalPageShell
      title="Properties"
      subtitle="Listed properties appear on Rent with PropLane. Unlist to take a property off the public catalog."
      filterRow={
        <ManagerPortalFilterRow>
          <ManagerPortalStatusPills
            tabs={kpiTabs}
            activeId={String(activeKpi)}
            onChange={(id) => {
              setActiveKpi(Number(id) as AdminPropertyBucketIndex);
              clearSelection();
            }}
          />
        </ManagerPortalFilterRow>
      }
    >
      {/*
        The shared list surface, not a bespoke table. Admin does not create
        listings, so there is no dashed ADD row here — the add path belongs to
        the manager who owns the property.
      */}
      <PortalRecordListSurface
        isEmpty={rows.length === 0}
        empty={<PortalDataTableEmpty icon="data" message={EMPTY_COPY[activeKpi] ?? "No properties."} />}
        bulkCount={selectedRows.length}
        bulkActions={bulkActions}
        dataAttr="admin-properties-list"
      >
        {rows.map((row) => {
          const rowKey = row.adminRefId + (row.listingId ?? "");
          return (
            <PortalPropertyRecordRow
              key={rowKey}
              title={`${row.buildingName} · ${row.unitLabel}`}
              address={`${row.address}${row.zip ? `, ${row.zip}` : ""}`}
              summary={`${adminPropertyRentDisplayLabel(row)} · ${row.beds} bd / ${row.baths} ba · ${row.neighborhood}`}
              checked={selectedIds.has(rowKey)}
              onSelectedChange={() => toggleSelected(rowKey)}
              dataAttr="admin-property-row"
            />
          );
        })}
      </PortalRecordListSurface>
    </ManagerPortalPageShell>
  );
}
