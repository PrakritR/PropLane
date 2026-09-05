"use client";

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { useShallowTabId } from "@/components/ui/tabs";
import { useAppUi } from "@/components/providers/app-ui-provider";
import { PortalListControlStack } from "@/components/portal/portal-list-control-stack";
import {
  ManagerPortalPageShell,
  MANAGER_TABLE_TH,
  PORTAL_COMMAND_ACTION_BTN,
  PORTAL_COMMAND_PRIMARY_ACTION_BTN,
  PORTAL_COMMAND_PRIMARY_ACTION_STYLE,
} from "@/components/portal/portal-metrics";
import {
  PORTAL_DATA_TABLE,
  PORTAL_DATA_TABLE_WRAP,
  PORTAL_DATA_TABLE_SCROLL,
  PORTAL_MOBILE_CARD_CLASS,
  PORTAL_TABLE_HEAD_ROW,
  PORTAL_TABLE_TR_EXPANDABLE,
  PORTAL_TABLE_TD,
  PORTAL_TABLE_DETAIL_ROW,
  PORTAL_TABLE_DETAIL_CELL,
  PORTAL_DETAIL_BTN,
  PortalTableDetailActions,
  PortalTableInlineExpand,
  PortalDataTableEmpty,
  createPortalRowExpandClick,
} from "@/components/portal/portal-data-table";
import {
  ReportExportButtons,
  type ReportFilterState,
} from "@/components/portal/reports/report-filter-bar";
import {
  buildFormalDocumentQuery,
  buildScopedReportQuery,
  type FormalDocumentFilterState,
} from "@/components/portal/reports/formal-document-scope-bar";
import { ReportGenerateModal } from "@/components/portal/reports/report-generate-modal";
import { ReportTable } from "@/components/portal/reports/report-table";
import { FormalDocumentsPreview, FinancialReportDocumentView, OccupancyDocumentView } from "@/components/portal/reports/formal-document-preview";
import { ReportGeneratePrompt } from "@/components/portal/reports/report-generate-prompt";
import { VendorTaxProfileModal } from "@/components/portal/vendor-tax-profile-modal";
import { useManagerUserId } from "@/hooks/use-manager-user-id";
import { buildManagerPropertyFilterOptions } from "@/lib/manager-portfolio-access";
import { syncPropertyPipelineFromServer } from "@/lib/demo-property-pipeline";
import type { OccupancyReport, PropertyRentReceiptDocument } from "@/lib/reports/formal-documents/spec";
import type { ReportResult } from "@/lib/reports/types";
import { isDemoModeActive } from "@/lib/demo/demo-session";
import {
  ManagerApplicationDocumentDetail,
  ManagerApplicationDocumentsTab,
  ManagerLeaseDocumentsTab,
  LeasingDocumentsPropertyFilterFields,
} from "@/components/portal/pro-documents-leasing-tabs";
import {
  DocumentLibraryFilterFields,
  DOCUMENT_LIBRARY_SCOPE_FILTER_OPTIONS,
  ManagerDocumentLibrary,
  type ManagerDocumentLibraryHandle,
  type DocumentLibraryFilterFieldsProps,
} from "@/components/portal/pro-document-library";
import { ManagerDocumentTemplatesPanel } from "@/components/portal/pro-document-templates-panel";
import { PortalFilterSortSheet, portalFilterActiveCount } from "@/components/portal/portal-filter-sort-sheet";
import { PortalActiveFilterChips, type PortalActiveFilterChip } from "@/components/portal/portal-filter-chips";
import {
  DOCUMENT_CATEGORIES,
  DOCUMENT_CATEGORY_LABELS,
} from "@/lib/documents/manager-documents";

export const DOCUMENT_TAB_DESTINATIONS = [
  { id: "applications", label: "Applications" },
  { id: "leases", label: "Leases" },
  { id: "other", label: "Other" },
] as const;

/** Every routable documents tab id (including hidden report views kept for bookmarks). */
export const DOCUMENT_TABS = [
  ...DOCUMENT_TAB_DESTINATIONS,
  { id: "library", label: "All files" },
  { id: "templates", label: "Templates" },
  { id: "income-documents", label: "Rent documents" },
  { id: "expense-documents", label: "Expense documents" },
  { id: "occupancy", label: "Occupancy" },
  { id: "1099", label: "1099 forms" },
  { id: "tax-summary", label: "Tax summary" },
] as const;

function defaultFilters(): ReportFilterState {
  const now = new Date();
  const yearStart = new Date(now.getFullYear(), 0, 1);
  const defaultTaxYear = now.getMonth() <= 2 ? now.getFullYear() - 1 : now.getFullYear() - 1;
  return {
    propertyId: "",
    from: yearStart.toISOString().slice(0, 10),
    to: now.toISOString().slice(0, 10),
    daysAhead: "90",
    taxYear: String(defaultTaxYear),
  };
}

function defaultDocumentScopeFilters(): FormalDocumentFilterState {
  return {
    scope: "portfolio",
    propertyId: "",
    residentEmail: "",
    roomLabel: "",
  };
}

function w9StatusTone(status: string) {
  const s = status.toLowerCase();
  if (s.includes("complete")) return "portal-badge-success ring-1 ring-[color-mix(in_srgb,currentColor_25%,transparent)]";
  if (s.includes("missing")) return "portal-badge-danger ring-1 ring-[color-mix(in_srgb,currentColor_25%,transparent)]";
  if (s.includes("pending")) return "portal-badge-pending ring-1 ring-[color-mix(in_srgb,currentColor_25%,transparent)]";
  return "bg-accent/30 text-foreground ring-1 ring-border";
}

export function ManagerDocumentsPanel({
  tabId: serverTabId,
  basePath = "/portal",
  applicationId,
}: {
  tabId: string;
  basePath?: string;
  applicationId?: string;
}) {
  // Tab switches are shallow (client-only) — see TabNav `shallow` below.
  const tabId = useShallowTabId(
    serverTabId,
    DOCUMENT_TABS.map((t) => t.id),
  );
  const { showToast } = useAppUi();
  const { userId, ready } = useManagerUserId();
  const [propertyTick, setPropertyTick] = useState(0);
  const [filters, setFilters] = useState(defaultFilters);
  const [scopeFilters, setScopeFilters] = useState(defaultDocumentScopeFilters);
  const [report, setReport] = useState<ReportResult | null>(null);
  const [propertyDocuments, setPropertyDocuments] = useState<PropertyRentReceiptDocument[] | null>(null);
  const [occupancyReport, setOccupancyReport] = useState<OccupancyReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [generated, setGenerated] = useState(false);
  const [taxVendorId, setTaxVendorId] = useState<string | null>(null);
  const [taxVendorName, setTaxVendorName] = useState("");
  const [expanded1099Id, setExpanded1099Id] = useState<string | null>(null);
  const [generateModalOpen, setGenerateModalOpen] = useState(false);
  const [leasingPropertyFilter, setLeasingPropertyFilter] = useState("");
  const [librarySearch, setLibrarySearch] = useState("");
  const [libraryCategoryFilter, setLibraryCategoryFilter] = useState("");
  const [libraryScopeFilter, setLibraryScopeFilter] = useState("");
  const [libraryPropertyFilter, setLibraryPropertyFilter] = useState("");
  const [libraryExpiryFilter, setLibraryExpiryFilter] = useState("");
  const [libraryExpiryPills, setLibraryExpiryPills] = useState<
    DocumentLibraryFilterFieldsProps["expiryPills"]
  >([{ id: "", label: "All", count: 0 }]);
  const libraryRef = useRef<ManagerDocumentLibraryHandle>(null);

  const openDocumentUpload = useCallback(() => {
    libraryRef.current?.openUpload();
  }, []);

  const propertyOptions = useMemo(() => {
    void propertyTick;
    return buildManagerPropertyFilterOptions(userId ?? null);
  }, [userId, propertyTick]);

  useEffect(() => {
    if (!ready) return;
    // Not forced: the pipeline sync has a session TTL + in-flight guard, so
    // tab switches reuse fresh data instead of refetching the full snapshot.
    void syncPropertyPipelineFromServer().then(() => setPropertyTick((n) => n + 1));
  }, [ready, userId]);

  const runReport = useCallback(async () => {
    setLoading(true);
    try {
      // Demo sandbox: build every report from the browser-local demo data —
      // the reports API needs auth and knows nothing about the demo account.
      if (isDemoModeActive()) {
        const demo = await import("@/lib/demo/demo-finance-reports");
        const demoPropertyId = scopeFilters.propertyId || filters.propertyId || undefined;
        if (tabId === "expense-documents") {
          setPropertyDocuments(null);
          setReport(demo.buildDemoFinanceReport("expenses", demoPropertyId));
        } else if (tabId === "income-documents") {
          const { documents, preview } = demo.buildDemoRentReceiptDocuments(demoPropertyId);
          setPropertyDocuments(documents);
          setReport(preview);
        } else if (tabId === "1099") {
          setPropertyDocuments(null);
          setReport(demo.buildDemo1099Report(filters.taxYear));
        } else if (tabId === "tax-summary") {
          setPropertyDocuments(null);
          setReport(demo.buildDemoTaxSummaryReport(demoPropertyId));
        } else if (tabId === "occupancy") {
          setPropertyDocuments(null);
          setReport(null);
          setOccupancyReport(demo.buildDemoOccupancyReport(demoPropertyId));
        }
        setGenerated(true);
        setLoading(false);
        return;
      }
      if (tabId === "expense-documents") {
        const qs = buildScopedReportQuery(
          { from: filters.from, to: filters.to },
          scopeFilters,
        );
        const res = await fetch(`/api/reports/expenses?${qs}`);
        const data = await res.json();
        if (!res.ok) throw new Error(data.error ?? "Failed to load expense documents.");
        setPropertyDocuments(null);
        setReport(data as ReportResult);
      } else if (tabId === "income-documents") {
        const qs = buildFormalDocumentQuery(
          "property_rent_receipt",
          { from: filters.from, to: filters.to },
          scopeFilters,
        );
        const res = await fetch(`/api/reports/formal-documents/preview?${qs}`, { credentials: "include" });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error ?? "Failed to load rent receipts.");
        setPropertyDocuments((data.documents as PropertyRentReceiptDocument[]) ?? []);
        setReport(data.preview as ReportResult);
      } else if (tabId === "1099") {
        const params = new URLSearchParams({ taxYear: filters.taxYear });
        const res = await fetch(`/api/reports/1099-candidates?${params}`);
        const data = await res.json();
        if (!res.ok) throw new Error(data.error ?? "Failed to load report.");
        setPropertyDocuments(null);
        setReport(data as ReportResult);
      } else if (tabId === "tax-summary") {
        const params = new URLSearchParams({ from: filters.from, to: filters.to });
        if (filters.propertyId) params.set("propertyId", filters.propertyId);
        const res = await fetch(`/api/reports/tax-summary?${params}`);
        const data = await res.json();
        if (!res.ok) throw new Error(data.error ?? "Failed to load report.");
        setPropertyDocuments(null);
        setReport(data as ReportResult);
      } else if (tabId === "occupancy") {
        const params = new URLSearchParams({ from: filters.from, to: filters.to });
        if (filters.propertyId) params.set("propertyId", filters.propertyId);
        const res = await fetch(`/api/reports/occupancy?${params}`, { credentials: "include" });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error ?? "Failed to load occupancy report.");
        setPropertyDocuments(null);
        setReport(null);
        setOccupancyReport(data as OccupancyReport);
      } else {
        setPropertyDocuments(null);
        setReport(null);
        setOccupancyReport(null);
      }
      setGenerated(true);
    } catch (e) {
      showToast(e instanceof Error ? e.message : "Failed to load report.");
      setPropertyDocuments(null);
      setReport(null);
      setGenerated(false);
    } finally {
      setLoading(false);
    }
  }, [tabId, filters, scopeFilters, showToast]);

  useEffect(() => {
    queueMicrotask(() => {
      setReport(null);
      setPropertyDocuments(null);
      setOccupancyReport(null);
      setGenerated(false);
      setGenerateModalOpen(false);
      setLeasingPropertyFilter("");
      setLibrarySearch("");
      setLibraryCategoryFilter("");
      setLibraryScopeFilter("");
      setLibraryPropertyFilter("");
      setLibraryExpiryFilter("");
    });
  }, [tabId]);

  // Demo sandbox: generate immediately so every Documents tab opens populated.
  useEffect(() => {
    if (!isDemoModeActive()) return;
    queueMicrotask(() => void runReport());
    // Only re-run when switching tabs — filter edits happen in the generate modal.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabId]);

  const incomeReceiptExportHref =
    tabId === "income-documents"
      ? `/api/reports/formal-documents/export?${buildFormalDocumentQuery("property_rent_receipt", { from: filters.from, to: filters.to }, scopeFilters)}`
      : null;

  const expenseExportQuery =
    tabId === "expense-documents"
      ? buildScopedReportQuery({ from: filters.from, to: filters.to }, scopeFilters)
      : "";

  const showDateRange = tabId !== "1099" && tabId !== "applications" && tabId !== "leases";
  const showProperty = tabId === "tax-summary" || tabId === "occupancy";
  const showTaxYear = tabId === "1099";
  const showScope = tabId === "income-documents" || tabId === "expense-documents";
  const isLeasingDocumentsTab = tabId === "applications" || tabId === "leases";
  const isOtherDocumentsTab = tabId === "other" || tabId === "library";
  const activeTabLabel = DOCUMENT_TABS.find((tab) => tab.id === tabId)?.label ?? "Documents";

  const libraryCategoryFilterOptions = useMemo(
    () => DOCUMENT_CATEGORIES.map((c) => ({ id: c, label: DOCUMENT_CATEGORY_LABELS[c] })),
    [],
  );
  const libraryScopeFilterOptions = useMemo(
    () => DOCUMENT_LIBRARY_SCOPE_FILTER_OPTIONS.map((s) => ({ id: s.id, label: s.label })),
    [],
  );
  const libraryPropertyFilterOptions = useMemo(
    () => propertyOptions.map((p) => ({ id: p.id, label: p.label })),
    [propertyOptions],
  );

  const resetLeasingFilters = useCallback(() => setLeasingPropertyFilter(""), []);
  const resetLibraryFilters = useCallback(() => {
    setLibrarySearch("");
    setLibraryCategoryFilter("");
    setLibraryScopeFilter("");
    setLibraryPropertyFilter("");
    setLibraryExpiryFilter("");
  }, []);

  const leasingPropertyLabel = useMemo(() => {
    if (!leasingPropertyFilter) return "";
    return propertyOptions.find((p) => p.id === leasingPropertyFilter)?.label ?? leasingPropertyFilter;
  }, [leasingPropertyFilter, propertyOptions]);

  const libraryPropertyLabel = useMemo(() => {
    if (!libraryPropertyFilter) return "";
    return propertyOptions.find((p) => p.id === libraryPropertyFilter)?.label ?? libraryPropertyFilter;
  }, [libraryPropertyFilter, propertyOptions]);

  const documentsFilterSheet = isLeasingDocumentsTab ? (
    <PortalFilterSortSheet
      activeCount={portalFilterActiveCount([leasingPropertyFilter])}
      compactPanel
      filterFieldCount={propertyOptions.length > 0 ? 1 : 0}
      constrainDropdownToTitleBand
      mobileFlushBody
      className="min-w-0 w-auto shrink-0 max-md:w-full max-md:[&_button]:w-full max-md:[&_button]:px-2.5 md:!w-auto md:!max-w-none"
      onReset={resetLeasingFilters}
      dataAttr="documents-leasing-filter-sheet-open"
    >
      <LeasingDocumentsPropertyFilterFields
        propertyFilter={leasingPropertyFilter}
        onPropertyFilterChange={setLeasingPropertyFilter}
        propertyOptions={propertyOptions}
        dataAttr={
          tabId === "applications"
            ? "documents-applications-property-filter"
            : "documents-leases-property-filter"
        }
      />
    </PortalFilterSortSheet>
  ) : isOtherDocumentsTab ? (
    <PortalFilterSortSheet
      activeCount={portalFilterActiveCount([
        librarySearch,
        libraryCategoryFilter,
        libraryScopeFilter,
        libraryPropertyFilter,
        libraryExpiryFilter,
      ])}
      compactPanel
      filterFieldCount={propertyOptions.length > 0 ? 4 : 3}
      constrainDropdownToTitleBand
      mobileFlushBody
      className="min-w-0 w-auto shrink-0 max-md:w-full max-md:[&_button]:w-full max-md:[&_button]:px-2.5 md:!w-auto md:!max-w-none"
      onReset={resetLibraryFilters}
      dataAttr="documents-library-filter-sheet-open"
    >
      <DocumentLibraryFilterFields
        search={librarySearch}
        onSearchChange={setLibrarySearch}
        categoryFilter={libraryCategoryFilter}
        onCategoryFilterChange={setLibraryCategoryFilter}
        scopeFilter={libraryScopeFilter}
        onScopeFilterChange={setLibraryScopeFilter}
        propertyFilter={libraryPropertyFilter}
        onPropertyFilterChange={setLibraryPropertyFilter}
        expiryFilter={libraryExpiryFilter}
        onExpiryFilterChange={setLibraryExpiryFilter}
        expiryPills={libraryExpiryPills}
        categoryFilterOptions={libraryCategoryFilterOptions}
        scopeFilterOptions={libraryScopeFilterOptions}
        propertyFilterOptions={libraryPropertyFilterOptions}
        propertyOptions={propertyOptions}
      />
    </PortalFilterSortSheet>
  ) : null;

  const activeDocumentsFilterChips = useMemo((): PortalActiveFilterChip[] => {
    if (isLeasingDocumentsTab) {
      if (!leasingPropertyFilter) return [];
      return [
        {
          id: "property",
          label: `Property: ${leasingPropertyLabel}`,
          onRemove: () => setLeasingPropertyFilter(""),
        },
      ];
    }
    if (!isOtherDocumentsTab) return [];
    const chips: PortalActiveFilterChip[] = [];
    if (librarySearch.trim()) {
      chips.push({ id: "search", label: `Search: ${librarySearch.trim()}`, onRemove: () => setLibrarySearch("") });
    }
    if (libraryCategoryFilter) {
      const label =
        libraryCategoryFilterOptions.find((o) => o.id === libraryCategoryFilter)?.label ?? libraryCategoryFilter;
      chips.push({ id: "category", label: `Category: ${label}`, onRemove: () => setLibraryCategoryFilter("") });
    }
    if (libraryScopeFilter) {
      const label =
        libraryScopeFilterOptions.find((o) => o.id === libraryScopeFilter)?.label ?? libraryScopeFilter;
      chips.push({ id: "scope", label: `Scope: ${label}`, onRemove: () => setLibraryScopeFilter("") });
    }
    if (libraryPropertyFilter) {
      chips.push({
        id: "property",
        label: `Property: ${libraryPropertyLabel}`,
        onRemove: () => setLibraryPropertyFilter(""),
      });
    }
    if (libraryExpiryFilter) {
      const expiryLabels: Record<string, string> = {
        expired: "Expired",
        expiring30: "Expiring ≤30d",
        expiring90: "Expiring ≤90d",
      };
      chips.push({
        id: "expiry",
        label: `Expiry: ${expiryLabels[libraryExpiryFilter] ?? libraryExpiryFilter}`,
        onRemove: () => setLibraryExpiryFilter(""),
      });
    }
    return chips;
  }, [
    isLeasingDocumentsTab,
    isOtherDocumentsTab,
    leasingPropertyFilter,
    leasingPropertyLabel,
    librarySearch,
    libraryCategoryFilter,
    libraryCategoryFilterOptions,
    libraryScopeFilter,
    libraryScopeFilterOptions,
    libraryPropertyFilter,
    libraryPropertyLabel,
    libraryExpiryFilter,
  ]);

  const handleGenerateReport = useCallback(() => {
    setGenerateModalOpen(false);
    void runReport();
  }, [runReport]);

  const documentTabItems = useMemo(
    () => DOCUMENT_TAB_DESTINATIONS.map((tab) => ({ ...tab, href: `${basePath}/documents/${tab.id}` })),
    [basePath],
  );

  const activeDestinationId =
    tabId === "library" || tabId === "templates"
      ? "other"
      : DOCUMENT_TAB_DESTINATIONS.some((tab) => tab.id === tabId)
        ? tabId
        : "applications";

  const exportActions = (
    <>
      {tabId === "1099" ? (
        <a
          href={`/api/reports/1099-nec/export?taxYear=${filters.taxYear}&all=1`}
          className={`inline-flex items-center justify-center ${PORTAL_COMMAND_ACTION_BTN}`}
        >
          Download all 1099s
        </a>
      ) : null}
      {tabId === "expense-documents" && generated ? (
        <ReportExportButtons reportId="expenses" query={expenseExportQuery} />
      ) : null}
      {incomeReceiptExportHref && generated ? (
        <a
          href={incomeReceiptExportHref}
          className={`inline-flex items-center justify-center ${PORTAL_COMMAND_ACTION_BTN}`}
        >
          Download PDF
        </a>
      ) : null}
    </>
  );

  // Export routes are server-side PDFs behind auth — hidden in the demo.
  const hasExportActions =
    !isDemoModeActive() &&
    (tabId === "1099" ||
      (tabId === "expense-documents" && generated) ||
      Boolean(incomeReceiptExportHref && generated));

  const documentsCommandActions =
    !isLeasingDocumentsTab && !isOtherDocumentsTab && tabId !== "templates" ? (
      <>
        {hasExportActions ? exportActions : null}
        <Button
          type="button"
          className={PORTAL_COMMAND_PRIMARY_ACTION_BTN}
          style={PORTAL_COMMAND_PRIMARY_ACTION_STYLE}
          onClick={() => setGenerateModalOpen(true)}
          disabled={loading}
          data-attr="documents-generate-report"
        >
          {loading ? "Generating…" : "Generate report"}
        </Button>
      </>
    ) : documentsFilterSheet ? (
      <>{documentsFilterSheet}</>
    ) : null;

  if (tabId === "applications" && applicationId) {
    return (
      <ManagerApplicationDocumentDetail
        applicationId={applicationId}
        basePath={basePath}
        userId={userId ?? null}
        ready={ready}
      />
    );
  }

  return (
    <ManagerPortalPageShell
      title="Documents"
      titleInlineFilter={null}
      hideTitleOnMobileNav
      compactFilterRow
    >
      <PortalListControlStack
        className="mb-2 max-lg:mb-1.5"
        variant="command"
        stickyDestinations={false}
        destinations={documentTabItems.map((tab) => ({
          id: tab.id,
          label: tab.label,
          href: tab.href,
          dataAttr: `documents-tab-${tab.id}`,
        }))}
        activeDestinationId={activeDestinationId}
        destinationAriaLabel="Document view"
        actions={documentsCommandActions}
        activeFilterChips={
          activeDocumentsFilterChips.length > 0 ? (
            <PortalActiveFilterChips chips={activeDocumentsFilterChips} />
          ) : null
        }
      />
      {tabId === "templates" ? (
          <ManagerDocumentTemplatesPanel />
        ) : isLeasingDocumentsTab ? (
          <>
            {tabId === "applications" ? (
              <ManagerApplicationDocumentsTab
                userId={userId ?? null}
                basePath={basePath}
                propertyFilter={leasingPropertyFilter}
                onAddDocument={openDocumentUpload}
              />
            ) : (
              <ManagerLeaseDocumentsTab
                userId={userId ?? null}
                propertyFilter={leasingPropertyFilter}
                onAddDocument={openDocumentUpload}
              />
            )}
            <ManagerDocumentLibrary ref={libraryRef} userId={userId ?? null} listHidden hideFilterChrome />
          </>
        ) : isOtherDocumentsTab ? (
            <ManagerDocumentLibrary
              ref={libraryRef}
              userId={userId ?? null}
              hideFilterChrome
              search={librarySearch}
              onSearchChange={setLibrarySearch}
              categoryFilter={libraryCategoryFilter}
              onCategoryFilterChange={setLibraryCategoryFilter}
              scopeFilter={libraryScopeFilter}
              onScopeFilterChange={setLibraryScopeFilter}
              propertyFilter={libraryPropertyFilter}
              onPropertyFilterChange={setLibraryPropertyFilter}
              expiryFilter={libraryExpiryFilter}
              onExpiryFilterChange={setLibraryExpiryFilter}
              onExpiryPillsChange={setLibraryExpiryPills}
            />
          ) : tabId === "income-documents" ? (
          <div>
            {loading ? (
              <ReportGeneratePrompt loading loadingTitle="Generating documents…" />
            ) : !generated ? (
              <ReportGeneratePrompt title="No rent receipt documents yet." />
            ) : propertyDocuments && propertyDocuments.length > 0 ? (
              <FormalDocumentsPreview propertyDocuments={propertyDocuments} />
            ) : (
              <ReportTable report={report} loading={loading} generated={generated} />
            )}
          </div>
        ) : tabId === "1099" && report ? (
          <div>
            {report.rows.length === 0 ? (
              <PortalDataTableEmpty message="No 1099 candidates yet." icon="document" />
            ) : (
              (() => {
                const renderVendorDetail = (vendorId: string, vendorName: string) => (
                  <>
                    <PortalTableDetailActions placement="top">
                      <Button
                        type="button"
                        variant="outline"
                        className={PORTAL_DETAIL_BTN}
                        onClick={() => {
                          setTaxVendorId(vendorId);
                          setTaxVendorName(vendorName);
                        }}
                      >
                        Edit W-9
                      </Button>
                      <a
                        href={`/api/reports/1099-nec/export?vendorId=${encodeURIComponent(vendorId)}&taxYear=${filters.taxYear}`}
                        className={`inline-flex h-8 items-center rounded-lg border border-border px-3 text-xs font-medium hover:bg-accent/40 ${PORTAL_DETAIL_BTN}`}
                      >
                        Download 1099
                      </a>
                    </PortalTableDetailActions>
                    <p className="mt-3 text-xs text-muted">
                      Tag expenses with a vendor to include them in 1099 totals. Complete your payer tax profile under
                      Plan if PDF download is blocked.
                    </p>
                  </>
                );

                return (
                  <>
                    <div className="space-y-2 lg:hidden">
                      {report.rows.map((row) => {
                        const vendorId = String(row.vendorId ?? "");
                        const vendorName = String(row.vendorName ?? "");
                        const w9Status = String(row.w9Status ?? "");
                        const expanded = expanded1099Id === vendorId;
                        return (
                          <div key={vendorId} className={PORTAL_MOBILE_CARD_CLASS}>
                            <button
                              type="button"
                              className="w-full text-left"
                              onClick={() => setExpanded1099Id((cur) => (cur === vendorId ? null : vendorId))}
                              aria-expanded={expanded}
                            >
                              <div className="flex min-w-0 items-start justify-between gap-2">
                                <div className="min-w-0 flex-1">
                                  <PortalTableInlineExpand expanded={expanded} className="font-semibold text-foreground">
                                    <span className="truncate">{vendorName}</span>
                                  </PortalTableInlineExpand>
                                  <p className="mt-0.5 truncate text-xs text-muted tabular-nums">
                                    {String(row.totalPaid)}
                                  </p>
                                </div>
                                <span
                                  className={`inline-flex shrink-0 rounded-full px-2.5 py-0.5 text-[11px] font-semibold ${w9StatusTone(w9Status)}`}
                                >
                                  {w9Status || "Unknown"}
                                </span>
                              </div>
                            </button>
                            {expanded ? (
                              <div className="mt-3 border-t border-border pt-3">
                                {renderVendorDetail(vendorId, vendorName)}
                              </div>
                            ) : null}
                          </div>
                        );
                      })}
                    </div>
                    <div className={`${PORTAL_DATA_TABLE_WRAP} hidden lg:block`}>
                      <div className={PORTAL_DATA_TABLE_SCROLL}>
                        <table className={PORTAL_DATA_TABLE}>
                          <thead>
                            <tr className={PORTAL_TABLE_HEAD_ROW}>
                              <th className={`${MANAGER_TABLE_TH} text-left`}>Vendor</th>
                              <th className={`${MANAGER_TABLE_TH} text-left`}>Total paid</th>
                              <th className={`${MANAGER_TABLE_TH} text-left`}>W-9 status</th>
                            </tr>
                          </thead>
                          <tbody>
                            {report.rows.map((row) => {
                              const vendorId = String(row.vendorId ?? "");
                              const vendorName = String(row.vendorName ?? "");
                              const w9Status = String(row.w9Status ?? "");
                              return (
                                <Fragment key={vendorId}>
                                  <tr
                                    className={PORTAL_TABLE_TR_EXPANDABLE}
                                    onClick={createPortalRowExpandClick(() =>
                                      setExpanded1099Id((cur) => (cur === vendorId ? null : vendorId)),
                                    )}
                                    aria-expanded={expanded1099Id === vendorId}
                                  >
                                    <td className={`${PORTAL_TABLE_TD} font-medium text-foreground`}>
                                      <PortalTableInlineExpand expanded={expanded1099Id === vendorId}>
                                        {vendorName}
                                      </PortalTableInlineExpand>
                                    </td>
                                    <td className={`${PORTAL_TABLE_TD} tabular-nums`}>{String(row.totalPaid)}</td>
                                    <td className={PORTAL_TABLE_TD}>
                                      <span
                                        className={`inline-flex rounded-full px-2.5 py-0.5 text-[11px] font-semibold ${w9StatusTone(w9Status)}`}
                                      >
                                        {w9Status || "Unknown"}
                                      </span>
                                    </td>
                                  </tr>
                                  {expanded1099Id === vendorId ? (
                                    <tr className={PORTAL_TABLE_DETAIL_ROW}>
                                      <td colSpan={3} className={PORTAL_TABLE_DETAIL_CELL}>
                                        {renderVendorDetail(vendorId, vendorName)}
                                      </td>
                                    </tr>
                                  ) : null}
                                </Fragment>
                              );
                            })}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  </>
                );
              })()
            )}
          </div>
        ) : tabId === "occupancy" && generated && occupancyReport ? (
          <div className="rounded-2xl border border-border bg-[#eef2f7] p-4 sm:p-6">
            <OccupancyDocumentView report={occupancyReport} />
          </div>
        ) : tabId === "occupancy" && generated && !occupancyReport ? (
          <ReportGeneratePrompt title="No occupancy data yet." />
        ) : tabId === "expense-documents" && generated && report ? (
          <FinancialReportDocumentView report={report} />
        ) : tabId === "expense-documents" && !generated ? (
          <ReportGeneratePrompt title="No expense documents yet." />
        ) : tabId === "tax-summary" && generated && report ? (
          <FinancialReportDocumentView report={report} />
        ) : (
          <ReportTable report={report} loading={loading} generated={generated} />
        )}

      <VendorTaxProfileModal
        open={Boolean(taxVendorId)}
        vendorId={taxVendorId}
        vendorName={taxVendorName}
        onClose={() => setTaxVendorId(null)}
        onSaved={() => void runReport()}
      />

      <ReportGenerateModal
        open={generateModalOpen}
        onClose={() => setGenerateModalOpen(false)}
        tabLabel={activeTabLabel}
        showScope={showScope}
        showProperty={showProperty}
        showDateRange={showDateRange}
        showTaxYear={showTaxYear}
        propertyOptions={propertyOptions}
        filters={filters}
        onFiltersChange={(next) => setFilters((f) => ({ ...f, ...next }))}
        scopeFilters={scopeFilters}
        onScopeFiltersChange={(next) => setScopeFilters((f) => ({ ...f, ...next }))}
        onGenerate={handleGenerateReport}
        loading={loading}
      />
    </ManagerPortalPageShell>
  );
}
