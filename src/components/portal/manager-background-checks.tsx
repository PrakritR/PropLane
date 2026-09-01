"use client";

import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { useAppUi } from "@/components/providers/app-ui-provider";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { ListSkeleton } from "@/components/ui/list-skeleton";
import { useManagerUserId } from "@/hooks/use-manager-user-id";
import { usePortalRowSelection } from "@/hooks/use-portal-row-selection";
import {
  ManagerPortalPageShell,
  PORTAL_COMMAND_ACTION_BTN,
} from "@/components/portal/portal-metrics";
import { PortalListGroupFilterFields } from "@/components/portal/portal-list-group-filter-fields";
import { PortalFilterSortSheet, portalFilterActiveCount } from "@/components/portal/portal-filter-sort-sheet";
import { PortalActiveFilterChips } from "@/components/portal/portal-filter-chips";
import { PortalListControlStack } from "@/components/portal/portal-list-control-stack";
import { PortalRecordDetailPage } from "@/components/portal/portal-record-detail-page";
import { PortalRecordListSurface } from "@/components/portal/portal-record-list-surface";
import {
  PORTAL_DATA_TABLE_WRAP,
  PortalDataTableEmpty,
  ResidentDocumentsDetailFooter,
} from "@/components/portal/portal-data-table";
import { ApplicationScreeningPanel } from "@/components/portal/application-screening-panel";
import { CheckrScreeningModal } from "@/components/portal/checkr-screening-modal";
import { ManagerScreeningSettingsModal } from "@/components/portal/manager-screening-settings";
import { ManagerBackgroundChecksGroupedTable } from "@/components/portal/manager-background-checks-grouped-table";
import { PORTAL_BULK_BAR_BTN } from "@/lib/portal-bulk-bar";
import { useCosignerSubmissionsMap } from "@/hooks/use-cosigner-submissions-map";
import type { DemoApplicantRow } from "@/data/demo-portal";
import {
  applicationShowsBackgroundCheck,
  resolveBackgroundCheckStatus,
} from "@/lib/application-background-check";
import {
  MANAGER_APPLICATIONS_EVENT,
  normalizeApplicationAxisId,
  readManagerApplicationRows,
  syncManagerApplicationsFromServer,
} from "@/lib/manager-applications-storage";
import {
  applicationVisibleToPortalUser,
  buildManagerPropertyFilterOptions,
} from "@/lib/manager-portfolio-access";
import { groupRowInputForRow } from "@/components/portal/application-group-section";
import { buildApplicationGroups } from "@/lib/rental-application/application-groups";
import { signerAppIdsForCosignerLookup } from "@/lib/rental-application/application-list-grouping";
import { resolveCosignerListSelection } from "@/lib/cosigner-list-selection";
import { isDemoModeActive } from "@/lib/demo/demo-session";
import { useScreeningTestMode } from "@/hooks/use-screening-test-mode";
import {
  isScreeningTestModeActive,
  setScreeningTestModeActive,
} from "@/lib/screening/screening-test-mode";
import {
  buildScreeningSubjects,
  cosignerSubmissionIdForSubject,
  resolveScreeningSubjectId,
  screeningRowForSubject,
} from "@/lib/background-check-subjects";
import { applicationRowSortMs } from "@/lib/manager-application-list";
import {
  DEFAULT_PORTAL_LIST_GROUP_MODE,
  PORTAL_LIST_GROUP_MODE_LABELS,
  portalListGroupModeActiveCount,
  type PortalListGroupMode,
} from "@/lib/portal-list-grouping";
import { usePortalNavigate } from "@/lib/portal-nav-client";
import {
  BACKGROUND_CHECK_LIST_TAB_LABELS,
  BACKGROUND_CHECK_LIST_TABS,
  backgroundCheckDetailHref,
  backgroundCheckListHref,
  type BackgroundCheckListTabId,
} from "@/lib/portal-detail-routes";
import {
  appendPortalPropertyFilterQuery,
  parsePortalPropertyFilterQuery,
  portalPropertyFilterIdsEqual,
  sanitizePortalPropertyFilterIds,
} from "@/lib/portal-property-list-filters";
import { PortalPageScrollBody } from "@/lib/portal-page-chrome-layout";
import { applicantDisplayName } from "@/lib/rental-application/applicant-name";
import { usePathname, useRouter, useSearchParams } from "next/navigation";

function applicationRowPropertyId(row: DemoApplicantRow): string {
  return row.assignedPropertyId?.trim() || row.propertyId?.trim() || row.application?.propertyId?.trim() || "";
}

function tabForBackgroundCheckRow(row: DemoApplicantRow): BackgroundCheckListTabId {
  const status = resolveBackgroundCheckStatus(row);
  if (status === "passed") return "passed";
  if (status === "flagged") return "flagged";
  return "pending_review";
}

export function ManagerBackgroundChecks({
  tab: tabProp = "pending_review",
  basePath = "/portal",
  applicationId: applicationIdProp,
}: {
  tab?: BackgroundCheckListTabId;
  basePath?: string;
  applicationId?: string;
}) {
  const { showToast } = useAppUi();
  const { userId, ready: authReady } = useManagerUserId();
  const screeningTestMode = useScreeningTestMode();
  const pathname = usePathname();
  const router = useRouter();
  const searchParams = useSearchParams();
  const navigate = usePortalNavigate();
  const [tab, setTab] = useState<BackgroundCheckListTabId>(tabProp);
  const [prevTabProp, setPrevTabProp] = useState(tabProp);
  if (tabProp !== prevTabProp) {
    setPrevTabProp(tabProp);
    if (tab !== tabProp) setTab(tabProp);
  }
  const [rows, setRows] = useState<DemoApplicantRow[]>(() =>
    typeof window === "undefined" ? [] : readManagerApplicationRows(),
  );
  const [filterOpen, setFilterOpen] = useState(false);
  const [groupMode, setGroupMode] = useState<PortalListGroupMode>(DEFAULT_PORTAL_LIST_GROUP_MODE);
  const [screeningSettingsOpen, setScreeningSettingsOpen] = useState(false);
  const [checkrScreeningRowId, setCheckrScreeningRowId] = useState<string | null>(null);
  const [checkrScreeningCosignerId, setCheckrScreeningCosignerId] = useState<string | null>(null);
  const [checkrScreeningShowPicker, setCheckrScreeningShowPicker] = useState(false);
  const [screeningSubjectId, setScreeningSubjectId] = useState<string | null>(null);
  const [detailScreeningFooterActions, setDetailScreeningFooterActions] = useState<ReactNode>(null);
  const [cosignerSubmissionsTick, setCosignerSubmissionsTick] = useState(0);

  const propertyOptions = useMemo(() => buildManagerPropertyFilterOptions(userId), [userId]);
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

  const scopedRows = useMemo(
    () =>
      rows.filter(
        (row) =>
          applicationVisibleToPortalUser(row, userId) &&
          applicationShowsBackgroundCheck(row) &&
          Boolean(row.application),
      ),
    [rows, userId],
  );

  const propertyFilteredRows = useMemo(() => {
    if (propertyFilters.length === 0) return scopedRows;
    return scopedRows.filter((row) => propertyFilters.includes(applicationRowPropertyId(row)));
  }, [scopedRows, propertyFilters]);

  const applicationGroups = useMemo(
    () => buildApplicationGroups(propertyFilteredRows.map(groupRowInputForRow)),
    [propertyFilteredRows],
  );

  const counts = useMemo(() => {
    const c: Record<BackgroundCheckListTabId, number> = {
      pending_review: 0,
      passed: 0,
      flagged: 0,
    };
    for (const row of propertyFilteredRows) {
      c[tabForBackgroundCheckRow(row)] += 1;
    }
    return c;
  }, [propertyFilteredRows]);

  const tabs = useMemo(
    () =>
      BACKGROUND_CHECK_LIST_TABS.map((id) => ({
        id,
        label: BACKGROUND_CHECK_LIST_TAB_LABELS[id],
        count: counts[id],
      })),
    [counts],
  );

  const rowsForTab = useMemo(() => {
    const filtered = propertyFilteredRows.filter((row) => tabForBackgroundCheckRow(row) === tab);
    return [...filtered].sort((a, b) => applicationRowSortMs(b) - applicationRowSortMs(a));
  }, [propertyFilteredRows, tab]);

  const { selectedIds, toggleSelected } = usePortalRowSelection(tab);
  const listSelectedCount = selectedIds.size;
  const singleListSelectedId = listSelectedCount === 1 ? [...selectedIds][0]! : null;
  const singleListSelectedRow = useMemo(
    () => (singleListSelectedId ? rowsForTab.find((row) => row.id === singleListSelectedId) ?? null : null),
    [rowsForTab, singleListSelectedId],
  );

  const cosignerSignerIds = useMemo(() => signerAppIdsForCosignerLookup(rowsForTab), [rowsForTab]);
  const cosignerSubmissionsBySigner = useCosignerSubmissionsMap(cosignerSignerIds, cosignerSubmissionsTick);

  const singleListSelectedCosigner = useMemo(() => {
    if (listSelectedCount !== 1 || !singleListSelectedId || singleListSelectedRow) return null;
    return resolveCosignerListSelection(singleListSelectedId, rowsForTab, cosignerSubmissionsBySigner);
  }, [
    listSelectedCount,
    singleListSelectedId,
    singleListSelectedRow,
    rowsForTab,
    cosignerSubmissionsBySigner,
  ]);

  const canBulkRunBackgroundCheck = useMemo(() => {
    if (singleListSelectedRow) {
      return (
        applicationShowsBackgroundCheck(singleListSelectedRow) &&
        singleListSelectedRow.backgroundCheck?.status !== "pending" &&
        singleListSelectedRow.backgroundCheck?.status !== "complete"
      );
    }
    if (singleListSelectedCosigner) {
      const { signerRow, sub } = singleListSelectedCosigner;
      return (
        applicationShowsBackgroundCheck(signerRow) &&
        sub.backgroundCheck?.status !== "pending" &&
        sub.backgroundCheck?.status !== "complete"
      );
    }
    return false;
  }, [singleListSelectedCosigner, singleListSelectedRow]);

  const detailRow = useMemo(() => {
    if (!applicationIdProp) return null;
    const target = normalizeApplicationAxisId(decodeURIComponent(applicationIdProp)).toUpperCase();
    return scopedRows.find((r) => normalizeApplicationAxisId(r.id).toUpperCase() === target) ?? null;
  }, [applicationIdProp, scopedRows]);

  const detailCosignerSubmissions = useMemo(() => {
    if (!detailRow) return [];
    const key = normalizeApplicationAxisId(detailRow.id).toUpperCase();
    return cosignerSubmissionsBySigner.get(key) ?? [];
  }, [detailRow, cosignerSubmissionsBySigner]);

  const detailScreeningSubjects = useMemo(() => {
    if (!detailRow) return [];
    return buildScreeningSubjects(detailRow, detailCosignerSubmissions);
  }, [detailRow, detailCosignerSubmissions]);

  const resolvedScreeningSubjectId = detailRow
    ? resolveScreeningSubjectId(detailScreeningSubjects, screeningSubjectId, detailRow.id)
    : "";

  const activeScreeningRow = useMemo(() => {
    if (!detailRow) return null;
    return screeningRowForSubject(detailRow, detailCosignerSubmissions, resolvedScreeningSubjectId);
  }, [detailRow, detailCosignerSubmissions, resolvedScreeningSubjectId]);

  const openScreeningModal = useCallback(
    (row: DemoApplicantRow, opts?: { showPackagePicker?: boolean; cosignerSubmissionId?: string }) => {
      setCheckrScreeningShowPicker(Boolean(opts?.showPackagePicker));
      setCheckrScreeningRowId(row.id);
      setCheckrScreeningCosignerId(opts?.cosignerSubmissionId?.trim() || null);
    },
    [],
  );

  const openBulkRunBackgroundCheck = useCallback(() => {
    const skipConsentGate = isDemoModeActive() || isScreeningTestModeActive();
    if (singleListSelectedCosigner) {
      const { signerRow, sub } = singleListSelectedCosigner;
      if (!skipConsentGate && !sub.consentCredit) {
        showToast("Applicant must authorize a background check first.");
        return;
      }
      openScreeningModal(signerRow, { cosignerSubmissionId: sub.id });
      return;
    }
    if (singleListSelectedRow) {
      if (!skipConsentGate && !singleListSelectedRow.application?.consentCredit) {
        showToast("Applicant must authorize a background check first.");
        return;
      }
      openScreeningModal(singleListSelectedRow);
    }
  }, [
    openScreeningModal,
    showToast,
    singleListSelectedCosigner,
    singleListSelectedRow,
  ]);

  const handleScreeningUpdated = useCallback(() => {
    void syncManagerApplicationsFromServer({ managerUserId: userId, force: true }).then(() => {
      setRows(readManagerApplicationRows());
      setCosignerSubmissionsTick((n) => n + 1);
    });
  }, [userId]);

  const screeningModalRow = useMemo(() => {
    if (!checkrScreeningRowId) return null;
    const row = scopedRows.find((r) => r.id === checkrScreeningRowId);
    if (!row) return null;
    const signerKey = normalizeApplicationAxisId(row.id).toUpperCase();
    const cosigners = cosignerSubmissionsBySigner.get(signerKey) ?? [];
    if (checkrScreeningCosignerId) {
      return screeningRowForSubject(row, cosigners, `cosigner:${checkrScreeningCosignerId}`);
    }
    return row;
  }, [checkrScreeningCosignerId, checkrScreeningRowId, cosignerSubmissionsBySigner, scopedRows]);

  const checkrModalSubjects = useMemo(() => {
    if (!screeningModalRow) return [];
    const signerKey = normalizeApplicationAxisId(screeningModalRow.id).toUpperCase();
    const cosigners = cosignerSubmissionsBySigner.get(signerKey) ?? [];
    return buildScreeningSubjects(screeningModalRow, cosigners);
  }, [cosignerSubmissionsBySigner, screeningModalRow]);

  const propertyFilterLabel = useMemo(() => {
    if (propertyFilters.length === 0) return "";
    if (propertyFilters.length === 1) {
      return propertyOptions.find((o) => o.id === propertyFilters[0])?.label ?? propertyFilters[0];
    }
    return `${propertyFilters.length} properties`;
  }, [propertyFilters, propertyOptions]);

  const filterSheet = (
    <PortalFilterSortSheet
      open={filterOpen}
      onOpenChange={setFilterOpen}
      activeCount={portalFilterActiveCount([propertyFilters, portalListGroupModeActiveCount(groupMode)])}
      compactPanel
      commandStripTrigger
      filterFieldCount={2}
      constrainDropdownToTitleBand={false}
      mobileFlushBody
      onReset={() => {
        setPropertyFilters([]);
        setGroupMode(DEFAULT_PORTAL_LIST_GROUP_MODE);
      }}
      dataAttr="background-checks-filter-sheet-open"
    >
      <PortalListGroupFilterFields
        groupMode={groupMode}
        onGroupModeChange={setGroupMode}
        propertyOptions={propertyOptions}
        propertyFilters={propertyFilters}
        onPropertyFiltersChange={setPropertyFilters}
        propertyAllLabel="All properties"
        propertyDataAttr="background-checks-filter-property"
        groupModeDataAttr="background-checks-filter-group-mode"
        showPropertyFilter={propertyOptions.length > 0}
      />
    </PortalFilterSortSheet>
  );

  const settingsButton = (
    <Button
      type="button"
      variant="outline"
      className={PORTAL_COMMAND_ACTION_BTN}
      data-attr="background-check-settings-open"
      onClick={() => setScreeningSettingsOpen(true)}
    >
      Settings
    </Button>
  );

  const listActions = (
    <>
      {filterSheet}
      {settingsButton}
    </>
  );

  const screeningModal = screeningModalRow ? (
    <CheckrScreeningModal
      open={checkrScreeningRowId !== null}
      onClose={() => {
        setCheckrScreeningRowId(null);
        setCheckrScreeningCosignerId(null);
        setCheckrScreeningShowPicker(false);
      }}
      row={screeningModalRow}
      screeningSubjects={checkrModalSubjects}
      screeningSubjectId={checkrScreeningCosignerId ? `cosigner:${checkrScreeningCosignerId}` : screeningModalRow.id}
      showPackagePickerInitially={checkrScreeningShowPicker}
      cosignerSubmissionId={checkrScreeningCosignerId}
      onUpdated={handleScreeningUpdated}
    />
  ) : null;

  if (applicationIdProp) {
    if (!detailRow) {
      return (
        <>
          {screeningModal}
          <PortalRecordDetailPage
            pageTitle="Background check"
            title="Background check"
            backHref={backgroundCheckListHref(basePath, tab)}
            hideBackText
            bareHeader
            dataAttrBack="background-check-detail-back"
            pinScrollBody
          >
            <div className="px-3 py-6">
              <ListSkeleton rows={4} showLeading={false} />
            </div>
          </PortalRecordDetailPage>
        </>
      );
    }

    return (
      <>
        {screeningModal}
        <ManagerScreeningSettingsModal open={screeningSettingsOpen} onClose={() => setScreeningSettingsOpen(false)} />
        <PortalRecordDetailPage
          pageTitle="Background check"
          title={applicantDisplayName(detailRow)}
          subtitle={detailRow.email?.trim() || undefined}
          backHref={backgroundCheckListHref(basePath, tab)}
          hideBackText
          bareHeader
          dataAttrBack="background-check-detail-back"
          pinScrollBody
          scrollBody={false}
          footerOmitSpacer
          footer={
            detailScreeningFooterActions ? (
              <ResidentDocumentsDetailFooter>{detailScreeningFooterActions}</ResidentDocumentsDetailFooter>
            ) : undefined
          }
        >
          <div className="flex min-h-0 flex-1 flex-col">
            <PortalPageScrollBody className="min-w-0 max-w-full pt-3 pb-[calc(2.75rem+var(--portal-native-bottom-nav-inset,0px)+env(safe-area-inset-bottom,0px))] lg:pb-3">
              {applicationShowsBackgroundCheck(detailRow) ? (
                <ApplicationScreeningPanel
                  row={activeScreeningRow ?? detailRow}
                  collapsible={false}
                  presentation="full"
                  bareCanvas
                  stretch
                  headerActionsPlacement="parent"
                  compactTabFooterActions
                  onHeaderActionsChange={setDetailScreeningFooterActions}
                  onUpdated={handleScreeningUpdated}
                  onOpenScreeningModal={(opts) =>
                    openScreeningModal(detailRow, {
                      ...opts,
                      cosignerSubmissionId: cosignerSubmissionIdForSubject(
                        detailScreeningSubjects,
                        resolvedScreeningSubjectId,
                      ),
                    })
                  }
                  cosignerSubmissions={detailCosignerSubmissions}
                  screeningSubjectId={resolvedScreeningSubjectId}
                  onScreeningSubjectChange={setScreeningSubjectId}
                  onRequestChecksForSubjects={(subjectIds) => {
                    if (subjectIds.length === 0) return;
                    const firstId = subjectIds[0]!;
                    setScreeningSubjectId(firstId);
                    openScreeningModal(detailRow, {
                      cosignerSubmissionId: cosignerSubmissionIdForSubject(detailScreeningSubjects, firstId),
                    });
                  }}
                  className="min-h-0 flex-1"
                />
              ) : (
                <p className="text-sm text-muted">No background check for this application.</p>
              )}
            </PortalPageScrollBody>
          </div>
        </PortalRecordDetailPage>
      </>
    );
  }

  return (
    <>
      <ManagerPortalPageShell title="Background check" hideTitleOnMobileNav titleInlineFilter={null} compactFilterRow>
        <PortalListControlStack
          className="mb-2 max-lg:mb-2"
          variant="command"
          destinations={tabs.map((t) => ({
            id: t.id,
            label: t.label,
            href: backgroundCheckListHref(basePath, t.id),
            count: t.count,
            dataAttr: `background-checks-bucket-${t.id}`,
          }))}
          activeDestinationId={tab}
          destinationAriaLabel="Background check status"
          actions={listActions}
          activeFilterChips={
            propertyFilters.length > 0 || groupMode !== DEFAULT_PORTAL_LIST_GROUP_MODE ? (
              <PortalActiveFilterChips
                chips={[
                  ...(groupMode !== DEFAULT_PORTAL_LIST_GROUP_MODE
                    ? [
                        {
                          id: "group-mode",
                          label: PORTAL_LIST_GROUP_MODE_LABELS[groupMode],
                          onRemove: () => setGroupMode(DEFAULT_PORTAL_LIST_GROUP_MODE),
                        },
                      ]
                    : []),
                  ...(propertyFilters.length > 0
                    ? [
                        {
                          id: "property",
                          label: `Property: ${propertyFilterLabel}`,
                          onRemove: () => setPropertyFilters([]),
                        },
                      ]
                    : []),
                ]}
              />
            ) : null
          }
        />
        <div className="mt-2 space-y-4 max-md:mt-3">
          <ManagerScreeningSettingsModal open={screeningSettingsOpen} onClose={() => setScreeningSettingsOpen(false)} />
          {screeningModal}
          {!authReady && rows.length === 0 ? (
            <div className={PORTAL_DATA_TABLE_WRAP}>
              <ListSkeleton rows={5} showLeading={false} />
            </div>
          ) : (
            <PortalRecordListSurface
              isEmpty={rowsForTab.length === 0}
              empty={
                propertyFilters.length > 0 ? (
                  <PortalDataTableEmpty icon="default" message="No background checks match your filters." />
                ) : (
                  <PortalDataTableEmpty icon="default" message="No background checks in this tab yet." />
                )
              }
              bulkCount={listSelectedCount}
              bulkActions={
                <Button
                  type="button"
                  variant="outline"
                  className={PORTAL_BULK_BAR_BTN}
                  data-attr="background-checks-bulk-run"
                  disabled={!canBulkRunBackgroundCheck}
                  onClick={openBulkRunBackgroundCheck}
                >
                  Run background check
                </Button>
              }
            >
              {rowsForTab.length > 0 ? (
                <ManagerBackgroundChecksGroupedTable
                  rows={rowsForTab}
                  groupMode={groupMode}
                  cosignerSubmissionsBySigner={cosignerSubmissionsBySigner}
                  selectable
                  selectedIds={selectedIds}
                  onToggleSelected={toggleSelected}
                  onOpenApplication={(row) =>
                    navigate(backgroundCheckDetailHref(basePath, tabForBackgroundCheckRow(row), row.id))
                  }
                  onOpenCosigner={(row, index) =>
                    navigate(`${backgroundCheckDetailHref(basePath, tabForBackgroundCheckRow(row), row.id)}?cosigner=${index}`)
                  }
                />
              ) : null}
            </PortalRecordListSurface>
          )}
        </div>
      </ManagerPortalPageShell>

      <div
        className="fixed bottom-[calc(var(--portal-floating-bottom-gap)+3.5rem+var(--portal-native-bottom-nav-inset,0px)+env(safe-area-inset-bottom,0px))] left-4 z-40 flex items-center gap-2 rounded-full border border-border bg-card px-3 py-2 text-xs shadow-lg lg:bottom-[calc(var(--portal-floating-bottom-gap)+env(safe-area-inset-bottom,0px))]"
      >
        <span className="font-medium text-foreground">Test mode</span>
        <button
          type="button"
          role="switch"
          aria-checked={screeningTestMode}
          className={cn(
            "relative h-6 w-11 rounded-full transition",
            screeningTestMode ? "bg-amber-400" : "bg-muted",
          )}
          onClick={() => {
            const next = !screeningTestMode;
            setScreeningTestModeActive(next);
            showToast(
              next
                ? "Screening test mode on — simulated reports, no charges."
                : "Live screening mode — real Checkr orders.",
            );
            handleScreeningUpdated();
          }}
          data-attr="screening-test-mode-toggle"
        >
          <span
            className={cn(
              "absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition",
              screeningTestMode ? "left-[22px]" : "left-0.5",
            )}
          />
        </button>
      </div>
    </>
  );
}
