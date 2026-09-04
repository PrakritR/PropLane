"use client";

import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Plus, Search } from "lucide-react";
import {
  ApplicationScreeningPanel,
  BackgroundCheckReportFrame,
} from "@/components/portal/application-screening-panel";
import { CheckrScreeningModal } from "@/components/portal/checkr-screening-modal";
import { ApplicationFilterSortFields } from "@/components/portal/application-filter-sort-fields";
import { PortalFilterSortSheet, portalFilterActiveCount } from "@/components/portal/portal-filter-sort-sheet";
import { PORTAL_MULTI_FIELD_FILTER_SHEET_CLASS } from "@/components/portal/portal-filter-shell";
import { usePortalFilterDraft } from "@/lib/portal-filter-draft";
import {
  FilterCollapsibleSection,
  FilterFieldsAccordion,
  FilterSingleSelectList,
  filterSingleSelectSummary,
} from "@/components/portal/filter-field-lists";
import { PortalActiveFilterChips } from "@/components/portal/portal-filter-chips";
import { PortalListControlStack } from "@/components/portal/portal-list-control-stack";
import { ManagerPortalPageShell, PORTAL_HEADER_PRIMARY_ACTION_BTN } from "@/components/portal/portal-metrics";
import { InboxTwoPane } from "@/components/portal/portal-inbox-ui";
import { Button } from "@/components/ui/button";
import { Modal } from "@/components/ui/modal";
import { useAppUi } from "@/components/providers/app-ui-provider";
import { useManagerUserId } from "@/hooks/use-manager-user-id";
import { usePortalNavigate } from "@/lib/portal-nav-client";
import type { DemoApplicantRow } from "@/data/demo-portal";
import { applicationShowsBackgroundCheck } from "@/lib/application-background-check";
import { applicantDisplayName, applicantSecondaryEmail } from "@/lib/rental-application/applicant-name";
import { buildDemoBackgroundCheck } from "@/lib/checkr/demo-simulate";
import { isDemoModeActive, resolveManagerScopeUserId } from "@/lib/demo/demo-session";
import {
  MANAGER_APPLICATIONS_EVENT,
  readManagerApplicationRows,
  syncManagerApplicationsFromServer,
} from "@/lib/manager-applications-storage";
import {
  applicationVisibleToPortalUser,
  buildManagerPropertyFilterOptions,
} from "@/lib/manager-portfolio-access";
import { isManagerFreePlan, type ManagerSubscriptionTier } from "@/lib/manager-access";
import { loadManagerSubscriptionTierClient } from "@/lib/manager-subscription-client";
import { MANAGER_PLAN_PORTAL_URL } from "@/lib/portals/manager-plan-path";
import {
  isScreeningTestModeActive,
  setScreeningTestModeActive,
  subscribeScreeningTestMode,
} from "@/lib/screening/screening-test-mode";
import {
  appendPortalPropertyFilterQuery,
  parsePortalPropertyFilterQuery,
  portalPropertyFilterIdsEqual,
  sanitizePortalPropertyFilterIds,
} from "@/lib/portal-property-list-filters";
import { applicationScreeningDetailHref } from "@/lib/portal-detail-routes";
import { cn } from "@/lib/utils";

type ScreeningStatusFilter = "all" | "complete" | "pending" | "none";
type ScreeningSort = "newest" | "oldest" | "name";

const STATUS_OPTIONS: { value: ScreeningStatusFilter; label: string }[] = [
  { value: "all", label: "All statuses" },
  { value: "complete", label: "Report completed" },
  { value: "pending", label: "In progress" },
  { value: "none", label: "Not started" },
];

const SORT_OPTIONS: { value: ScreeningSort; label: string }[] = [
  { value: "newest", label: "Newest first" },
  { value: "oldest", label: "Oldest first" },
  { value: "name", label: "Name (A–Z)" },
];

function ScreeningsNativeFilterFields({
  statusFilter,
  onStatusFilterChange,
  sort,
  onSortChange,
}: {
  statusFilter: ScreeningStatusFilter;
  onStatusFilterChange: (next: ScreeningStatusFilter) => void;
  sort: ScreeningSort;
  onSortChange: (next: ScreeningSort) => void;
}) {
  const [draftStatusFilter, setDraftStatusFilter] = usePortalFilterDraft(
    statusFilter,
    onStatusFilterChange,
    "all",
  );
  const [draftSort, setDraftSort] = usePortalFilterDraft(sort, onSortChange, "newest");

  return (
    <FilterFieldsAccordion>
      <FilterCollapsibleSection
        sectionId="screening-status"
        label="Status"
        summary={filterSingleSelectSummary(draftStatusFilter, STATUS_OPTIONS, "All statuses")}
        empty={draftStatusFilter === "all"}
        menuOptionCount={STATUS_OPTIONS.length}
        dataAttr="screenings-filter-status-trigger"
      >
        <FilterSingleSelectList
          options={STATUS_OPTIONS}
          value={draftStatusFilter}
          onChange={(value) => setDraftStatusFilter(value as ScreeningStatusFilter)}
          dataAttr="screenings-filter-status"
        />
      </FilterCollapsibleSection>
      <FilterCollapsibleSection
        sectionId="screening-sort"
        label="Sort"
        summary={filterSingleSelectSummary(draftSort, SORT_OPTIONS, "Newest first")}
        empty={draftSort === "newest"}
        menuOptionCount={SORT_OPTIONS.length}
        dataAttr="screenings-filter-sort-trigger"
      >
        <FilterSingleSelectList
          options={SORT_OPTIONS}
          value={draftSort}
          onChange={(value) => setDraftSort(value as ScreeningSort)}
          dataAttr="screenings-filter-sort"
        />
      </FilterCollapsibleSection>
    </FilterFieldsAccordion>
  );
}

function screeningStatusLabel(row: DemoApplicantRow): string {
  const bg = row.backgroundCheck;
  if (!bg) return "NOT STARTED";
  if (bg.status === "complete") return "REPORT COMPLETED";
  if (bg.status === "pending") return "IN PROGRESS";
  return bg.status.toUpperCase();
}

function screeningSortKey(row: DemoApplicantRow): number {
  const raw = row.backgroundCheck?.orderedAt ?? row.backgroundCheck?.completedAt ?? "";
  const parsed = raw ? Date.parse(raw) : 0;
  return Number.isFinite(parsed) ? parsed : 0;
}

function formatScreeningListDate(row: DemoApplicantRow): string {
  const raw = row.backgroundCheck?.completedAt ?? row.backgroundCheck?.orderedAt;
  if (!raw) return "";
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) return "";
  const now = Date.now();
  const diffDays = Math.round((now - date.getTime()) / (24 * 60 * 60 * 1000));
  if (diffDays <= 0) return "Today";
  if (diffDays === 1) return "Yesterday";
  if (diffDays < 14) return `${diffDays} days ago`;
  if (diffDays < 60) return `${Math.round(diffDays / 7)} weeks ago`;
  return date.toLocaleDateString("en-US", { month: "short", day: "2-digit" });
}

function enrichRowForTestMode(row: DemoApplicantRow): DemoApplicantRow {
  if (!row.application?.consentCredit) return row;
  if (row.backgroundCheck?.status === "complete") return row;
  const backgroundCheck = buildDemoBackgroundCheck(row);
  return { ...row, backgroundCheck };
}

function useScreeningTestMode(): boolean {
  return useSyncExternalStore(subscribeScreeningTestMode, isScreeningTestModeActive, () => false);
}

export function ManagerScreenings({
  basePath = "/portal",
  screeningId,
  embedded = false,
}: {
  basePath?: string;
  screeningId?: string;
  /** When true, render inside Applications (no page shell — parent owns tabs/title). */
  embedded?: boolean;
}) {
  const { showToast } = useAppUi();
  const { userId, ready: authReady } = useManagerUserId();
  const scopeUserId = resolveManagerScopeUserId(userId);
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const navigate = usePortalNavigate();
  const testMode = useScreeningTestMode();
  const [rows, setRows] = useState<DemoApplicantRow[]>([]);
  const [screeningAllowed, setScreeningAllowed] = useState(true);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [modalRowId, setModalRowId] = useState<string | null>(null);
  const [modalShowPackagePicker, setModalShowPackagePicker] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<ScreeningStatusFilter>("all");
  const [sort, setSort] = useState<ScreeningSort>("newest");

  const propertyOptions = useMemo(
    () => buildManagerPropertyFilterOptions(scopeUserId),
    [scopeUserId],
  );
  const propertyFilters = useMemo(
    () =>
      sanitizePortalPropertyFilterIds(
        parsePortalPropertyFilterQuery(searchParams),
        propertyOptions.map((o) => o.id),
      ),
    [searchParams, propertyOptions],
  );

  const setPropertyFilters = useCallback(
    (ids: string[]) => {
      const sanitized = sanitizePortalPropertyFilterIds(ids, propertyOptions.map((o) => o.id));
      if (portalPropertyFilterIdsEqual(sanitized, propertyFilters)) return;
      router.replace(appendPortalPropertyFilterQuery(pathname, sanitized), { scroll: false });
    },
    [pathname, propertyFilters, propertyOptions, router],
  );

  useEffect(() => {
    if (!authReady) return;
    const sync = () => setRows(readManagerApplicationRows());
    void syncManagerApplicationsFromServer({ managerUserId: userId }).then(sync);
    window.addEventListener(MANAGER_APPLICATIONS_EVENT, sync);
    return () => window.removeEventListener(MANAGER_APPLICATIONS_EVENT, sync);
  }, [authReady, userId]);

  useEffect(() => {
    if (!authReady) return;
    void loadManagerSubscriptionTierClient().then((tier) => {
      setScreeningAllowed(!isManagerFreePlan(tier as ManagerSubscriptionTier));
    });
  }, [authReady]);

  const scopedRows = useMemo(() => {
    const visible = rows.filter((r) => applicationVisibleToPortalUser(r, scopeUserId));
    const withBg = testMode
      ? visible
          .filter((r) => applicationShowsBackgroundCheck(r) && r.application?.consentCredit)
          .map(enrichRowForTestMode)
      : visible.filter((r) => r.backgroundCheck);
    if (propertyFilters.length === 0) return withBg;
    return withBg.filter((r) => {
      const pid = r.assignedPropertyId?.trim() || r.propertyId?.trim() || r.application?.propertyId?.trim();
      return pid ? propertyFilters.includes(pid) : false;
    });
  }, [rows, scopeUserId, testMode, propertyFilters]);

  const filteredRows = useMemo(() => {
    let list = scopedRows;
    if (statusFilter === "complete") list = list.filter((r) => r.backgroundCheck?.status === "complete");
    else if (statusFilter === "pending") list = list.filter((r) => r.backgroundCheck?.status === "pending");
    else if (statusFilter === "none") list = list.filter((r) => !r.backgroundCheck);
    const q = searchQuery.trim().toLowerCase();
    if (q) {
      list = list.filter((r) =>
        [r.name, r.email, r.property, r.id].filter(Boolean).join(" ").toLowerCase().includes(q),
      );
    }
    const sorted = [...list];
    sorted.sort((a, b) => {
      if (sort === "name") return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
      const da = screeningSortKey(a);
      const db = screeningSortKey(b);
      return sort === "oldest" ? da - db : db - da;
    });
    return sorted;
  }, [scopedRows, statusFilter, searchQuery, sort]);

  const selectedRow = useMemo(() => {
    if (!screeningId) return filteredRows[0] ?? null;
    const decoded = decodeURIComponent(screeningId);
    return filteredRows.find((r) => r.id === decoded) ?? filteredRows[0] ?? null;
  }, [screeningId, filteredRows]);

  const openScreening = useCallback(
    (row: DemoApplicantRow) => {
      navigate(applicationScreeningDetailHref(basePath, row.id));
    },
    [basePath, navigate],
  );

  const handleUpdated = useCallback(() => {
    void syncManagerApplicationsFromServer({ managerUserId: userId, force: true }).then(setRows);
  }, [userId]);

  const propertyFilterLabel = useMemo(() => {
    if (propertyFilters.length === 0) return "All properties";
    if (propertyFilters.length === 1) {
      return propertyOptions.find((o) => o.id === propertyFilters[0])?.label ?? propertyFilters[0];
    }
    return `${propertyFilters.length} properties`;
  }, [propertyFilters, propertyOptions]);

  const statusFilterLabel = STATUS_OPTIONS.find((o) => o.value === statusFilter)?.label ?? "All statuses";

  const filterSheet = (
    <PortalFilterSortSheet
      compactPanel
      filterFieldCount={3}
      constrainDropdownToTitleBand
      mobileFlushBody
      className={PORTAL_MULTI_FIELD_FILTER_SHEET_CLASS}
      activeCount={portalFilterActiveCount([propertyFilters, statusFilter !== "all", sort !== "newest"])}
      onReset={() => {
        setPropertyFilters([]);
        setStatusFilter("all");
        setSort("newest");
      }}
      dataAttr="screenings-filter-sheet-open"
    >
      <ApplicationFilterSortFields
        propertyOptions={propertyOptions}
        propertyFilters={propertyFilters}
        onPropertyFiltersChange={setPropertyFilters}
        dataAttr="screenings-filter-property"
      />
      <ScreeningsNativeFilterFields
        statusFilter={statusFilter}
        onStatusFilterChange={setStatusFilter}
        sort={sort}
        onSortChange={setSort}
      />
    </PortalFilterSortSheet>
  );

  const listPane = (
    <div className="flex h-full min-h-0 flex-col rounded-2xl border border-border bg-card">
      <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-2 text-xs text-muted">
        <span>
          Sorted by: <span className="font-semibold text-foreground">{SORT_OPTIONS.find((o) => o.value === sort)?.label}</span>
        </span>
        <span className="tabular-nums">{filteredRows.length}</span>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {filteredRows.length === 0 ? (
          <p className="px-4 py-8 text-center text-sm text-muted">No screenings match these filters.</p>
        ) : (
          <ul>
            {filteredRows.map((row) => {
              const active = selectedRow?.id === row.id;
              return (
                <li key={row.id}>
                  <button
                    type="button"
                    className={cn(
                      "w-full border-b border-border px-4 py-3 text-left transition hover:bg-foreground/5",
                      active && "bg-primary/10",
                    )}
                    onClick={() => openScreening(row)}
                    data-attr={`screening-list-row-${row.id}`}
                  >
                    <p className="font-semibold text-foreground">{applicantDisplayName(row)}</p>
                    <p className="mt-1 text-[10px] font-bold uppercase tracking-wide text-muted">
                      {screeningStatusLabel(row)}
                      {formatScreeningListDate(row) ? ` · ${formatScreeningListDate(row)}` : ""}
                    </p>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );

  const detailPane = selectedRow ? (
    <div className="flex h-full min-h-0 flex-col overflow-hidden rounded-2xl border border-border bg-card">
      <div className="border-b border-border px-4 py-3">
        <p className="text-lg font-bold text-foreground">{applicantDisplayName(selectedRow)}</p>
        <p className="text-sm text-muted">
          {selectedRow.property}
          {applicantSecondaryEmail(selectedRow) ? ` · ${applicantSecondaryEmail(selectedRow)}` : ""}
        </p>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        <BackgroundCheckReportFrame row={selectedRow} demo={testMode || isDemoModeActive()} bareCanvas />
      </div>
      <div className="flex flex-wrap justify-end gap-2 border-t border-border px-4 py-3">
        <ApplicationScreeningPanel
          row={selectedRow}
          collapsible={false}
          bareCanvas
          presentation="compact"
          onUpdated={handleUpdated}
          onOpenScreeningModal={(opts) => {
            setModalShowPackagePicker(Boolean(opts?.showPackagePicker));
            setModalRowId(selectedRow.id);
          }}
        />
      </div>
    </div>
  ) : (
    <div className="flex h-full min-h-[280px] flex-col items-center justify-center rounded-2xl border border-border bg-card px-6 text-center">
      <p className="text-sm text-muted">You haven&apos;t started a screening yet.</p>
      <Button type="button" variant="outline" className={cn("mt-4", PORTAL_HEADER_PRIMARY_ACTION_BTN)} onClick={() => setPickerOpen(true)}>
        Start a new screening
      </Button>
    </div>
  );

  const eligibleForNew = useMemo(
    () =>
      rows.filter(
        (r) =>
          applicationVisibleToPortalUser(r, scopeUserId) &&
          applicationShowsBackgroundCheck(r) &&
          r.application?.consentCredit &&
          r.backgroundCheck?.status !== "pending",
      ),
    [rows, scopeUserId],
  );

  if (!screeningAllowed) {
    const upgradeMessage = (
      <p className="text-sm text-muted">
        Applicant screening requires Pro or Business.{" "}
        <Link href={MANAGER_PLAN_PORTAL_URL} className="font-semibold text-primary hover:underline">
          Upgrade your plan
        </Link>
      </p>
    );
    if (embedded) return upgradeMessage;
    return <ManagerPortalPageShell title="Screenings">{upgradeMessage}</ManagerPortalPageShell>;
  }

  const screeningsControls = (
    <>
      {embedded ? (
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          {filterSheet}
          <Button type="button" variant="outline" className={PORTAL_HEADER_PRIMARY_ACTION_BTN} onClick={() => setPickerOpen(true)}>
            <Plus className="mr-1 h-4 w-4" />
            New screening
          </Button>
        </div>
      ) : null}
      {!embedded ? (
        <div className="mb-2 sm:hidden">
          <label className="relative block">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" />
            <input
              type="search"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search applicants"
              className="h-9 w-full rounded-xl border border-border bg-background px-3 pl-9 text-sm outline-none focus:border-primary/40 focus:ring-2 focus:ring-primary/15"
              data-attr="screenings-search-mobile"
            />
          </label>
        </div>
      ) : null}
      <PortalListControlStack
        className="mb-2"
        search={
          embedded
            ? {
                value: searchQuery,
                onChange: setSearchQuery,
                placeholder: "Search screenings",
                dataAttr: "screenings-search",
              }
            : undefined
        }
        activeFilterChips={
          propertyFilters.length > 0 || statusFilter !== "all" ? (
            <PortalActiveFilterChips
              chips={[
                ...(statusFilter !== "all"
                  ? [{ id: "status", label: `Status: ${statusFilterLabel}`, onRemove: () => setStatusFilter("all") }]
                  : []),
                ...(propertyFilters.length > 0
                  ? [{ id: "property", label: `Property: ${propertyFilterLabel}`, onRemove: () => setPropertyFilters([]) }]
                  : []),
              ]}
            />
          ) : null
        }
      />
    </>
  );

  const screeningsBody = (
    <>
      {!embedded ? (
        <ManagerPortalPageShell
          title="Screenings"
          titleInlineFilter={filterSheet}
          titleAside={
            <div className="flex items-center gap-2">
              <label className="relative hidden sm:block">
                <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" />
                <input
                  type="search"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="Search"
                  className="h-9 w-44 rounded-full border border-border bg-card pl-9 pr-3 text-sm lg:w-52"
                  data-attr="screenings-search"
                />
              </label>
              <Button type="button" variant="outline" className={PORTAL_HEADER_PRIMARY_ACTION_BTN} onClick={() => setPickerOpen(true)}>
                <Plus className="mr-1 h-4 w-4" />
                New screening
              </Button>
            </div>
          }
          compactFilterRow
        >
          {screeningsControls}
          <InboxTwoPane list={listPane} thread={detailPane} threadOpen={Boolean(selectedRow)} heightMode="viewport" />
        </ManagerPortalPageShell>
      ) : (
        <>
          {screeningsControls}
          <InboxTwoPane list={listPane} thread={detailPane} threadOpen={Boolean(selectedRow)} heightMode="viewport" />
        </>
      )}

      <div className="fixed bottom-4 left-4 z-40 flex items-center gap-2 rounded-full border border-border bg-card px-3 py-2 text-xs shadow-lg">
        <span className="font-medium text-foreground">Test mode</span>
        <button
          type="button"
          role="switch"
          aria-checked={testMode}
          className={cn(
            "relative h-6 w-11 rounded-full transition",
            testMode ? "bg-amber-400" : "bg-muted",
          )}
          onClick={() => {
            const next = !testMode;
            setScreeningTestModeActive(next);
            showToast(next ? "Screening test mode on — simulated reports, no charges." : "Live screening mode — real Checkr orders.");
            handleUpdated();
          }}
          data-attr="screening-test-mode-toggle"
        >
          <span
            className={cn(
              "absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition",
              testMode ? "left-[22px]" : "left-0.5",
            )}
          />
        </button>
      </div>

      <Modal open={pickerOpen} onClose={() => setPickerOpen(false)} title="Start a new screening" panelClassName="max-w-lg">
        <div className="max-h-[min(50vh,24rem)] space-y-2 overflow-y-auto">
          {eligibleForNew.length === 0 ? (
            <p className="text-sm text-muted">No applicants are ready for screening. They need background-check consent first.</p>
          ) : (
            eligibleForNew.map((row) => (
              <button
                key={row.id}
                type="button"
                className="flex w-full flex-col rounded-xl border border-border px-3 py-2 text-left hover:border-primary/40 hover:bg-primary/5"
                onClick={() => {
                  setPickerOpen(false);
                  setModalShowPackagePicker(false);
                  setModalRowId(row.id);
                }}
              >
                <span className="font-semibold text-foreground">{applicantDisplayName(row)}</span>
                <span className="text-xs text-muted">{row.property}</span>
              </button>
            ))
          )}
        </div>
      </Modal>

      <CheckrScreeningModal
        key={modalRowId ?? "none"}
        row={modalRowId ? rows.find((r) => r.id === modalRowId) ?? null : null}
        open={modalRowId !== null}
        showPackagePickerInitially={modalShowPackagePicker}
        onClose={() => {
          setModalRowId(null);
          setModalShowPackagePicker(false);
        }}
        onUpdated={() => {
          handleUpdated();
          const row = modalRowId ? rows.find((r) => r.id === modalRowId) : null;
          if (row) openScreening(row);
        }}
      />
    </>
  );

  return screeningsBody;
}
