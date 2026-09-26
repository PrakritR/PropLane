"use client";

import { PortalIconAction } from "@/components/portal/portal-icon-action";
import { ListSkeleton } from "@/components/ui/list-skeleton";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { CalendarDays, Camera, ClipboardCheck, Settings } from "lucide-react";
import { Button } from "@/components/ui/button";
import { portalEmptyCopy, portalEmptyNoMatchTitle, portalEmptySibling } from "@/lib/portal-empty-copy";
import { matchesPortalListSearch } from "@/lib/portal-list-search";
import { PortalRecordListSurface } from "@/components/portal/portal-record-list-surface";
import { PortalApplicantRecordRow, PortalRowFact } from "@/components/portal/portal-record-row";
import { PortalListControlStack } from "@/components/portal/portal-list-control-stack";
import { ResidentDetailSubsectionChrome } from "@/components/portal/resident-detail-subsection-chrome";
import { PortalSectionActionRow } from "@/components/portal/portal-section-action-row";
import { ManagerPortalPageShell, ManagerPortalStatusPills } from "@/components/portal/portal-metrics";
import { InspectionEditor, type InspectionEditorHandle } from "@/components/portal/inspection-editor";
import { PortalRecordDetailPage, PortalRecordActions } from "@/components/portal/portal-record-detail-page";
import { PortalRecordSectionChrome, PortalRecordHeaderIconActions } from "@/components/portal/portal-record-section-chrome";
import { PortalRecordRelatedPanel } from "@/components/portal/portal-record-related-panel";
import { recordSections } from "@/lib/portals/record-sections";
import { renderRecordSection } from "@/components/portal/record-section-renderers";
import { useAppUi } from "@/components/providers/app-ui-provider";
import { inspectionDetailHref, parseServiceRecordTab } from "@/lib/portal-detail-routes";
import { ProPortalSettingsModal } from "@/components/portal/pro-portal-settings-modal";
import {
  getSettingsEntryPoint,
  settingsDialogTitlePrefix,
} from "@/components/portal/settings-entry-points";
import { usePortalSession } from "@/hooks/use-portal-session";
import { workspaceContainsProperty } from "@/lib/workspaces/selection";
import { buildManagerPropertyFilterOptions } from "@/lib/manager-portfolio-access";
import { isDemoModeActive } from "@/lib/demo/demo-session";
import { downloadInspection, inspectionRequest, loadInspectionList, INSPECTIONS_CHANGED, type InspectionList } from "@/lib/inspections/client";
import { inspectionPhotoCounts, inspectionRoomLabel, type InspectionDetail, type InspectionDocument, type InspectionKind, type InspectionPhotoCounts, type InspectionResidency, type InspectionRole, type InspectionRoomProgress, type InspectionSummary } from "@/lib/inspections/model";
import { PortalFilterSortSheet, portalFilterActiveCount } from "@/components/portal/portal-filter-sort-sheet";
import { FieldSingleSelect } from "@/components/ui/checkbox-multi-select";
import {
  residentInspectionTab,
  RESIDENT_INSPECTION_TAB_LABELS,
  RESIDENT_INSPECTION_TAB_ORDER,
  RESIDENT_INSPECTION_TYPE_LABELS,
  type ResidentInspectionTab,
  type ResidentInspectionTypeFilter,
} from "@/lib/resident-inspections-tabs";

const inspectionsSettingsEntry = getSettingsEntryPoint("inspections");

const kindLabel = (kind: InspectionKind) => kind === "move-in" ? "Move-in" : "Move-out";
/**
 * A row says how many photos exist and who added them. It deliberately does not say which
 * review step the report is parked on: there are no review steps — a report is a room, and
 * photos of it from either side.
 */
const photoLine = (photos: InspectionPhotoCounts) => {
  if (!photos.total) return "No photos yet";
  const parts = [photos.resident ? `resident ${photos.resident}` : "", photos.manager ? `manager ${photos.manager}` : ""].filter(Boolean);
  return `${photos.total} photo${photos.total === 1 ? "" : "s"}${parts.length > 1 ? ` · ${parts.join(", ")}` : ""}`;
};

/**
 * "3 of 8 rooms photographed" (C250/U033) — the roster row's second fact, so a manager can tell
 * which residents still need specific rooms covered without opening every report. Empty once a
 * report has no rooms at all (should not happen, but never divide by zero into a line).
 */
const roomProgressLine = (progress: InspectionRoomProgress): string =>
  progress.total ? `${progress.done} of ${progress.total} room${progress.total === 1 ? "" : "s"} photographed` : "";

/** Room-by-room progress straight from the stored document — the same rows Rooms itself renders. */
function inspectionRoomStats(document: InspectionDocument): { done: number; total: number; issues: number } {
  let done = 0;
  let issues = 0;
  for (const area of document.areas) {
    const allChecked = area.items.every((item) => item.manager.condition !== "unchecked");
    if (allChecked) done += 1;
    if (area.items.some((item) => item.manager.condition === "damaged" || item.resident.condition === "damaged")) {
      issues += 1;
    }
  }
  return { done, total: document.areas.length, issues };
}

const INSPECTION_STATUS_LABEL: Record<InspectionDetail["report"]["status"], string> = {
  draft: "In progress",
  submitted: "Submitted",
  completed: "Completed",
};

/** Hide the dev-only missing-table banner for managers; still show real partial-load notices. */
function showInspectionLoadNotice(role: InspectionRole, notice: string): boolean {
  if (role !== "manager") return true;
  return !/not set up in this environment yet/i.test(notice);
}

/**
 * A tenancy date is a WALL date (`2026-03-04`), so it is formatted from its parts. Building a
 * Date from the string parses it as UTC and prints the previous day west of Greenwich.
 */
function tenancyDate(iso: string): string {
  const parts = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso.trim());
  if (!parts) return "";
  const date = new Date(Number(parts[1]), Number(parts[2]) - 1, Number(parts[3]));
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

/**
 * One line per PERSON, not per filed report. A manager with residents and no reports yet was
 * shown an empty page telling them an approved resident was needed — while nine approved
 * residents sat one tab away. The roster is the list; a report, when one exists, rides on the
 * row it belongs to.
 *
 * The row is the Properties card: initials tile, the name, the place line, and glyph facts.
 * No pill — the photo count IS the state, and a "Needs photos" tag on every row said nothing
 * the photo fact did not already say (PLAN-0920-0436).
 */
export type InspectionRow = {
  key: string;
  name: string;
  /** "5259 Brooklyn Ave · Room 4" — the place line under the name. */
  address: string;
  /** "Moved in Aug 15, 2026" / "Moves in Oct 1, 2026" / "Moves out …"; empty when the residency is gone. */
  tenancy: string;
  /** "No photos yet" or "4 photos · resident 2, manager 2". */
  photos: string;
  /** Set only once a report exists — there is no per-room data before one is created. */
  roomProgress?: InspectionRoomProgress;
  /** The room's own configuration requires this kind of inspection. */
  required: boolean;
  report?: InspectionSummary;
  residency?: InspectionResidency;
  /** Ascending sort within a tab: the date that tab is about, blanks last. */
  sortKey: string;
};

/** Which occupancy states belong on each tab. A past resident no longer needs a move-in. */
const TAB_OCCUPANCY: Record<InspectionKind, InspectionResidency["occupancy"][]> = {
  "move-in": ["upcoming", "current"],
  "move-out": ["current", "past"],
};

export function buildInspectionRows(kind: InspectionKind, residencies: InspectionResidency[], reports: InspectionSummary[]): InspectionRow[] {
  const onTab = residencies.filter(residency => TAB_OCCUPANCY[kind].includes(residency.occupancy));
  const byId = new Map(onTab.map(residency => [residency.id, residency]));
  const forKind = reports.filter(report => report.kind === kind);

  const tenancyLine = (residency: InspectionResidency | undefined): string => {
    if (!residency) return "";
    const moveIn = tenancyDate(residency.moveInDate);
    const moveOut = tenancyDate(residency.moveOutDate);
    if (kind === "move-in") {
      if (residency.occupancy === "upcoming") return moveIn ? `Moves in ${moveIn}` : "Move-in date not set";
      return moveIn ? `Moved in ${moveIn}` : "Living here";
    }
    return moveOut ? `Moves out ${moveOut}` : "Move-out date not set";
  };
  // One row per FILED report, so an earlier completed report never becomes unreachable just
  // because a newer one exists — plus one roster row for every resident who has none yet. A
  // report whose residency is gone (withdrawn, reassigned) still gets its row: evidence must
  // not disappear because the application row moved on.
  // A room whose own configuration requires this inspection says so on the person's row.
  // A separate "required" banner above the list drew the same resident twice.
  const requiredFor = (residency: InspectionResidency | undefined): boolean => residency?.requiredKinds?.includes(kind) ?? false;
  // A trailing " · " with nothing after it is worse than no room segment at all — only
  // append when the raw value resolves to a real room name (never a fabricated one).
  const roomSuffix = (raw: string | undefined): string => {
    const label = raw ? inspectionRoomLabel(raw) : "";
    return label ? ` · ${label}` : "";
  };
  const rows: InspectionRow[] = forKind.map(report => {
    const residency = byId.get(report.application_id);
    return {
      key: `report:${report.id}`,
      name: residency?.name || report.resident_name,
      address: `${residency?.property || report.property_label}${roomSuffix(residency?.room || report.room_label)}`,
      tenancy: tenancyLine(residency),
      photos: photoLine(report.photos),
      roomProgress: report.roomProgress,
      required: requiredFor(residency),
      report,
      residency,
      sortKey: (residency && (kind === "move-in" ? residency.moveInDate : residency.moveOutDate)) || report.inspection_date || "9999-12-31",
    };
  });

  const withReport = new Set(forKind.map(report => report.application_id));
  for (const residency of onTab) {
    if (withReport.has(residency.id)) continue;
    rows.push({
      key: `residency:${residency.id}`,
      name: residency.name,
      address: `${residency.property}${roomSuffix(residency.room)}`,
      tenancy: tenancyLine(residency),
      photos: "No photos yet",
      required: requiredFor(residency),
      residency,
      sortKey: (kind === "move-in" ? residency.moveInDate : residency.moveOutDate) || "9999-12-31",
    });
  }

  // Tenancy date, then the person, then their reports oldest-first — two reports for one
  // resident read as a history rather than an arbitrary pair.
  return rows.sort((a, b) => a.sortKey.localeCompare(b.sortKey) || a.name.localeCompare(b.name)
    || (a.report?.inspection_date ?? "").localeCompare(b.report?.inspection_date ?? "") || a.key.localeCompare(b.key));
}

/**
 * The search box narrows the current tab's rows by everything the card shows — name, place
 * line, tenancy, photo line, and "required" — through the one matcher every list tab shares.
 * Tab counts stay the unfiltered bucket totals.
 */
export function filterInspectionRows(rows: InspectionRow[], query: string): InspectionRow[] {
  if (!query.trim()) return rows;
  return rows.filter(row => matchesPortalListSearch(query, row.name, row.address, row.tenancy, row.photos, row.required ? "required" : ""));
}

/**
 * The report a residency opens into: the newest one for that moment. Older reports are never
 * deleted, so a residency that somehow holds two keeps both — the newest is simply the one the
 * shortcut opens, and the same rule runs on the server in `ensureInspection`.
 */
export function pickPrimaryInspectionReport(reports: InspectionSummary[]): InspectionSummary | undefined {
  if (!reports.length) return undefined;
  return [...reports].sort((a, b) => b.inspection_date.localeCompare(a.inspection_date) || b.created_at.localeCompare(a.created_at))[0];
}

/**
 * Resident's own Inspections section. Two route grammars share this page:
 * - New bucket list (`bucket` set): a merged move-in + move-out roster,
 *   grouped Upcoming / In progress / Done, with Move-in/Move-out as a "Type"
 *   filter instead of a top destination (captain, 2026-09-25).
 * - Legacy kind-based detail (`kind` + `reportId`, `bucket` omitted): unchanged
 *   — a filed report still opens at `/inspections/{move-in|move-out}/{id}`.
 */
export function ResidentInspectionsPage({
  kind = "move-in",
  reportId,
  basePath = "/resident",
  bucket,
  typeFilter,
}: {
  kind?: InspectionKind;
  reportId?: string;
  basePath?: string;
  bucket?: ResidentInspectionTab;
  typeFilter?: ResidentInspectionTypeFilter;
}) {
  if (reportId) return <InspectionsPanel role="resident" initialKind={kind} reportId={reportId} routeBase={`${basePath}/inspections`} />;
  return (
    <ManagerPortalPageShell
      title="Inspections"
      hideTitleOnMobileNav
      compactFilterRow
    >
      <InspectionsPanel
        role="resident"
        initialKind={kind}
        reportId={reportId}
        routeBase={`${basePath}/inspections`}
        residentBucket={bucket}
        residentTypeFilter={typeFilter}
      />
    </ManagerPortalPageShell>
  );
}

export function ManagerInspectionsPage({ kind = "move-in", reportId, recordTab, basePath = "/portal" }: { kind?: InspectionKind; reportId?: string; recordTab?: string; basePath?: string }) {
  if (reportId) return <InspectionsPanel role="manager" initialKind={kind} reportId={reportId} recordTab={recordTab} routeBase={`${basePath}/inspections`} />;
  return (
    <ManagerPortalPageShell
      title="Inspections"
      hideTitleOnMobileNav
      compactFilterRow
    >
      <InspectionsPanel role="manager" initialKind={kind} reportId={reportId} routeBase={`${basePath}/inspections`} />
    </ManagerPortalPageShell>
  );
}

export function InspectionsPanel({ role, applicationId, initialKind = "move-in", reportId, recordTab, routeBase, embeddedInResident = false, residentBucket, residentTypeFilter }: {
  role: InspectionRole; applicationId?: string; initialKind?: InspectionKind; reportId?: string; recordTab?: string; routeBase?: string; embeddedInResident?: boolean;
  /** Resident-only bucket list mode. Omitted (always, for manager) keeps the kind-based view exactly as it was. */
  residentBucket?: ResidentInspectionTab;
  residentTypeFilter?: ResidentInspectionTypeFilter;
}) {
  const { userId, ready } = usePortalSession();
  // Remount state on an account/portal/residency change so another viewer never sees old evidence.
  // A bare "Loading…" paragraph here (instead of the same shimmering
  // skeleton every other list content area uses) read, on a slow session
  // read, as the whole page having failed to mount its shell — the caller
  // (`ResidentInspectionsPage` / `ManagerInspectionsPage`) already keeps the
  // portal shell mounted around this content slot, so only this content
  // area needs a loading shape.
  if (!ready) return <ListSkeleton rows={4} showLeading={false} className="p-1" />;
  if (!userId && !isDemoModeActive()) return <p className="p-4 text-sm text-muted">Sign in to view your inspections.</p>;
  return (
    <InspectionWorkspace
      key={`${role}:${userId}:${applicationId ?? ""}:${reportId ?? ""}:${initialKind}:${residentBucket ?? ""}`}
      userId={userId ?? "demo"}
      role={role}
      applicationId={applicationId}
      initialKind={initialKind}
      reportId={reportId}
      recordTab={recordTab}
      routeBase={routeBase}
      embeddedInResident={embeddedInResident}
      residentBucket={residentBucket}
      residentTypeFilter={residentTypeFilter}
    />
  );
}

function InspectionWorkspace({ userId, role, applicationId, initialKind, reportId, recordTab, routeBase, embeddedInResident = false, residentBucket, residentTypeFilter }: {
  userId: string; role: InspectionRole; applicationId?: string; initialKind: InspectionKind; reportId?: string; recordTab?: string; routeBase?: string; embeddedInResident?: boolean;
  residentBucket?: ResidentInspectionTab;
  residentTypeFilter?: ResidentInspectionTypeFilter;
}) {
  const router = useRouter();
  const { showToast } = useAppUi();
  const [kind, setKind] = useState(initialKind);
  const [data, setData] = useState<InspectionList>({ reports: [], residencies: [] });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [detail, setDetail] = useState<InspectionDetail | null>(null);
  // Bumped by the retry button below so the detail effect re-runs without a full remount.
  const [detailRetryToken, setDetailRetryToken] = useState(0);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [query, setQuery] = useState("");
  // Resident-only "Type" filter (Filter popover), narrowing the merged
  // move-in + move-out roster within the active bucket. Initialized once from
  // the routed prop; the workspace remounts (see `key` above) when the bucket
  // itself changes, so this never goes stale.
  const [residentTypeFilterState, setResidentTypeFilterState] = useState<ResidentInspectionTypeFilter>(
    residentTypeFilter ?? "all",
  );
  const propertyOptions = useMemo(
    () => (role === "manager" ? buildManagerPropertyFilterOptions(userId) : []),
    [role, userId],
  );
  const working = useRef(false);
  const requestVersion = useRef(0);
  const live = useRef(true);
  const editorRef = useRef<InspectionEditorHandle>(null);
  useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);
  const refresh = useCallback(async (force = false) => {
    const version = ++requestVersion.current;
    try {
      const value = await loadInspectionList(userId, role, applicationId, force);
      if (live.current && version === requestVersion.current) { setData(value); setError(""); }
    } catch (e) { if (live.current && version === requestVersion.current) setError(e instanceof Error ? e.message : "Could not load inspections."); }
    finally { if (live.current && version === requestVersion.current) setLoading(false); }
  }, [applicationId, role, userId]);
  useEffect(() => {
    // Fetching subscribes this panel to an external server snapshot.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refresh();
    const changed = () => { void refresh(true); };
    window.addEventListener(INSPECTIONS_CHANGED, changed);
    return () => window.removeEventListener(INSPECTIONS_CHANGED, changed);
  }, [refresh]);
  useEffect(() => {
    if (!reportId) return;
    let cancelled = false;
    // Clearing a stale error before a retry, not synchronizing with an external read.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setError("");
    // C202: a stalled fetch (dropped connection, a proxy that never closes the
    // response) previously left `detail` null forever — the loading paragraph
    // below had no error and no timeout to fall back on, and photos stayed
    // unreachable behind it. A bounded wait guarantees this always resolves
    // into either the report or a retryable error.
    const controller = new AbortController();
    const stall = setTimeout(() => controller.abort(), 15_000);
    inspectionRequest<InspectionDetail>(role, `/${reportId}`, { signal: controller.signal }).then(value => {
      if (!cancelled) setDetail(value);
    }).catch(e => {
      if (cancelled) return;
      const stalled = e instanceof DOMException && e.name === "AbortError";
      setError(stalled ? "This report is taking longer than expected to load." : e instanceof Error ? e.message : "Could not open this report.");
    }).finally(() => clearTimeout(stall));
    return () => { cancelled = true; controller.abort(); clearTimeout(stall); };
  }, [reportId, role, detailRetryToken]);
  const run = async (operation: () => Promise<void>) => {
    if (working.current) return;
    working.current = true; setBusy(true); setError("");
    try { await operation(); }
    catch (e) { if (live.current) setError(e instanceof Error ? e.message : "Could not finish the request."); }
    finally { working.current = false; if (live.current) setBusy(false); }
  };
  // `kindOverride` lets the resident bucket view (a merged move-in + move-out
  // list) open a row under ITS OWN real kind rather than whatever the `kind`
  // state happens to hold — every other caller omits it and keeps today's
  // behavior exactly.
  const open = (id: string, kindOverride?: InspectionKind) => run(async () => {
    const useKind = kindOverride ?? kind;
    if (routeBase) { router.push(`${routeBase}/${useKind}/${id}`); return; }
    setDetail(await inspectionRequest<InspectionDetail>(role, `/${id}`)); setSelected(new Set());
  });
  /**
   * Open the residency's report for this tab, creating it on the spot the first time anyone
   * looks. The roster row already knows the resident, the room and the move date, so the old
   * "New inspection" dialog only asked the manager to retype what the row was showing them.
   */
  const openResidency = (residency: InspectionResidency, kindOverride?: InspectionKind) => run(async () => {
    const useKind = kindOverride ?? kind;
    const value = await inspectionRequest<InspectionDetail>(role, "", {
      method: "POST", body: JSON.stringify({ applicationId: residency.id, kind: useKind }),
    });
    setSelected(new Set());
    if (routeBase) router.push(`${routeBase}/${useKind}/${value.report.id}`);
    else setDetail(value);
  });
  const changeKind = (next: InspectionKind) => {
    setSelected(new Set()); setDetail(null); setKind(next);
    if (routeBase) router.push(`${routeBase}/${next}`);
  };
  // The roster is the account's; the active workspace narrows it to its own houses.
  const residencyById = new Map(data.residencies.map(r => [r.id, r]));
  const visible = data.residencies.filter(
    r => (!applicationId || r.id === applicationId) && workspaceContainsProperty(r.propertyId),
  );
  // A filed report outlives its residency, so it is narrowed by the house its
  // residency names. One whose residency is gone has no house to test and keeps
  // the behavior it had before workspaces existed.
  const visibleReports = data.reports.filter(report => {
    const residency = residencyById.get(report.application_id);
    return workspaceContainsProperty(residency?.propertyId);
  });
  const embeddedScope = embeddedInResident && applicationId;
  const embeddedResidency = embeddedScope ? visible.find(r => r.id === applicationId) : undefined;
  const embeddedPrimaryReport = pickPrimaryInspectionReport(
    embeddedScope ? data.reports.filter(r => r.application_id === applicationId && r.kind === kind) : [],
  );
  const rowsFor = (which: InspectionKind) => buildInspectionRows(which, visible, visibleReports);
  const rows = rowsFor(kind);
  const shownRows = filterInspectionRows(rows, query);

  // Resident-only: a merged move-in + move-out roster, bucketed Upcoming /
  // In progress / Done (captain, 2026-09-25). `embeddedInResident` (the
  // record-page card) and every manager render keep the kind-based `rows`
  // above untouched — this block only runs, and is only READ below, when
  // `residentBucket` was actually routed.
  const isResidentBucketMode = role === "resident" && !embeddedInResident && residentBucket != null;
  const residentTypeKinds: InspectionKind[] =
    residentTypeFilterState === "all" ? ["move-in", "move-out"] : [residentTypeFilterState];
  const residentAllRows: (InspectionRow & { _kind: InspectionKind })[] = isResidentBucketMode
    ? residentTypeKinds.flatMap((k) => rowsFor(k).map((row) => ({ ...row, _kind: k })))
    : [];
  const residentActiveBucket: ResidentInspectionTab = residentBucket ?? "upcoming";
  const residentBucketCounts: Record<ResidentInspectionTab, number> = { upcoming: 0, "in-progress": 0, done: 0 };
  for (const row of residentAllRows) residentBucketCounts[residentInspectionTab(row.report ?? null)] += 1;
  const residentRowsForBucket = residentAllRows.filter(
    (row) => residentInspectionTab(row.report ?? null) === residentActiveBucket,
  );
  const residentShownRows = filterInspectionRows(residentRowsForBucket, query);

  // Every manager render (`isResidentBucketMode` false) takes the `: rows` /
  // `: shownRows` branch — byte-identical to the pre-existing behavior.
  const effectiveRows = isResidentBucketMode ? residentRowsForBucket : rows;
  const effectiveShownRows = isResidentBucketMode ? residentShownRows : shownRows;
  const effectiveSearchHidesEveryRow = effectiveRows.length > 0 && effectiveShownRows.length === 0;
  const effectiveKindForAdd: InspectionKind = isResidentBucketMode ? residentTypeKinds[0]! : kind;

  const selectedRows = effectiveRows.filter(row => selected.has(row.key));
  const selectedReports = selectedRows.filter(row => row.report).map(row => row.report!);
  const openRow = (row: InspectionRow) => {
    const rowKind = (row as InspectionRow & { _kind?: InspectionKind })._kind;
    if (row.report) void open(row.report.id, rowKind);
    else if (row.residency?.canCreate) openResidency(row.residency, rowKind);
  };

  const openEmbeddedInspection = () => {
    if (embeddedPrimaryReport) void open(embeddedPrimaryReport.id);
    else if (embeddedResidency?.canCreate) openResidency(embeddedResidency);
  };
  const embeddedEditDisabled = !embeddedPrimaryReport && !embeddedResidency?.canCreate;

  if (detail) {
    const editor = <InspectionEditor ref={editorRef} embedded={role === "manager" && Boolean(routeBase)} initial={detail} role={role} userId={userId} onChanged={() => { void refresh(true); }} onBack={() => { setDetail(null); setSelected(new Set()); if (routeBase) router.push(`${routeBase}/${kind}`); }} />;
    if (role !== "manager" || !routeBase) return editor;
    const recordTabId = parseServiceRecordTab(recordTab);
    const inspectionBasePath = routeBase.replace(/\/inspections$/, "") || "/portal";
    const sections = recordSections("manager", "inspection", {
      basePath: inspectionBasePath,
      inspectionKind: kind,
    }, recordTabId);
    const onInspectionHeaderAction = (actionId: string) => {
      if (actionId === "download-report") {
        editorRef.current?.downloadReport() ?? void downloadInspection(role, detail.report.id);
        return;
      }
      if (actionId === "add-photos" || actionId === "request-photos") {
        if (recordTabId !== "rooms") {
          router.push(inspectionDetailHref(inspectionBasePath, kind, detail.report.id, "rooms"));
        }
        editorRef.current?.addPhotos();
        return;
      }
      showToast("Coming soon");
    };
    return (
      <PortalRecordDetailPage
        pageTitle="Inspections"
        title={`${kindLabel(detail.report.kind)} · ${detail.report.resident_name || "Inspection"}`}
        subtitle={[detail.report.property_label, inspectionRoomLabel(detail.report.room_label)].filter(Boolean).join(" · ") || undefined}
        avatarName={detail.report.resident_name}
        backHref={`${routeBase}/${kind}`}
        hideBackText
        bareHeader
        dataAttrBack="inspection-detail-back"
        iconTitleActions
        pinScrollBody
      >
        <PortalRecordActions>
          <PortalRecordHeaderIconActions actions={sections.headerActions} onAction={onInspectionHeaderAction} />
        </PortalRecordActions>
        <PortalRecordSectionChrome
          sections={sections}
          recordId={detail.report.id}
          activeId={recordTabId}
          title={kindLabel(detail.report.kind)}
          backHref={`${routeBase}/${kind}`}
          backLabel="All inspections"
          ariaLabel="Inspection sections"
          onHeaderAction={onInspectionHeaderAction}
        >
          <div className={recordTabId === "rooms" ? undefined : "hidden"}>{editor}</div>
          {recordTabId === "rooms" ? null : recordTabId === "payments" ? (
            <PortalRecordRelatedPanel title="Payments" empty="No payment on this inspection." />
          ) : recordTabId === "communication" ? (
            renderRecordSection("communication", {
              role: "manager",
              kind: "inspection",
              kindLabel: "report",
              recordId: detail.report.id,
              recordLabel: kindLabel(detail.report.kind),
            })
          ) : (() => {
            const { done, total, issues } = inspectionRoomStats(detail.report.document);
            const photos = inspectionPhotoCounts(detail.report.document);
            const notStarted = total - done;
            return renderRecordSection("overview", {
              role: "manager",
              kind: "inspection",
              kindLabel: "report",
              recordId: detail.report.id,
              recordLabel: kindLabel(detail.report.kind),
              overviewTiles: [
                { id: "rooms", label: "Rooms", value: `${done} of ${total}`, detail: "done" },
                { id: "issues", label: "Issues", value: String(issues), tone: issues > 0 ? "danger" : "default" },
                { id: "photos", label: "Photos", value: String(photos.total) },
                { id: "status", label: "Status", value: INSPECTION_STATUS_LABEL[detail.report.status] },
              ],
              overviewNeeds: [
                ...(notStarted > 0 ? [{ id: "rooms-remaining", title: `${notStarted} room${notStarted === 1 ? "" : "s"} not started`, detail: "Finish the checklist" }] : []),
                ...(issues > 0 ? [{ id: "issues", title: `${issues} issue${issues === 1 ? "" : "s"} to resolve`, detail: "Charge or note in Rooms" }] : []),
              ],
              overviewCards: [
                {
                  id: "home",
                  title: "Home",
                  rows: [
                    { label: "Property", value: detail.report.property_label },
                    { label: "Unit", value: inspectionRoomLabel(detail.report.room_label) || "—" },
                    { label: "Resident", value: detail.report.resident_name },
                    { label: "Type", value: kindLabel(detail.report.kind) },
                  ],
                },
                {
                  id: "payments",
                  title: "Payments",
                  kind: "rows",
                  rows: [],
                  emptyLabel: "No charges yet",
                },
              ],
            });
          })()}
        </PortalRecordSectionChrome>
      </PortalRecordDetailPage>
    );
  }
  if (reportId) return <div className="space-y-3 p-4">
    {error ? <p role="alert">{error}</p> : <p role="status">Loading inspection…</p>}
    <div className="flex flex-wrap gap-2">
      {error && <Button onClick={() => setDetailRetryToken(t => t + 1)} data-attr="inspection-detail-retry">Retry</Button>}
      <Button variant="outline" onClick={() => router.push(`${routeBase}/${kind}`)} data-attr="inspection-list-back">Back to inspections</Button>
    </div>
  </div>;
  return <div className="min-w-0 space-y-3" data-attr="inspections-panel">
    {embeddedInResident ? (
      <ResidentDetailSubsectionChrome
        className="sticky z-[38] mb-3 shrink-0 space-y-2 bg-background/95 backdrop-blur-md [top:var(--portal-mobile-top-chrome,0px)]"
        bucketItems={(["move-in", "move-out"] as const).map((id) => ({
          id,
          label: kindLabel(id),
          count: data.reports.filter(r => r.application_id === applicationId && r.kind === id).length,
          dataAttr: `inspection-type-${id}`,
        }))}
        activeBucketId={kind}
        onBucketChange={(id) => changeKind(id as InspectionKind)}
        bucketAriaLabel="Inspection type"
        onSettings={
          role === "manager" && !isDemoModeActive()
            ? () => setSettingsOpen(true)
            : undefined
        }
        settingsLabel={inspectionsSettingsEntry.label}
        settingsDataAttr={inspectionsSettingsEntry.dataAttr}
        onEdit={openEmbeddedInspection}
        editDisabled={embeddedEditDisabled}
        editLabel={embeddedPrimaryReport ? "Edit" : "Create inspection"}
      />
    ) : isResidentBucketMode ? (
    <PortalListControlStack variant="command" stickyDestinations destinationAriaLabel="Inspection status" activeDestinationId={residentActiveBucket}
      destinations={RESIDENT_INSPECTION_TAB_ORDER.map((id) => ({
        id,
        label: RESIDENT_INSPECTION_TAB_LABELS[id],
        count: residentBucketCounts[id],
        href: `${routeBase}/${id}`,
        dataAttr: `resident-inspections-tab-${id}`,
      }))}
      search={{ value: query, onChange: setQuery, placeholder: "Search inspections", dataAttr: "inspections-search" }}
      actions={
        <PortalFilterSortSheet
          activeCount={portalFilterActiveCount([residentTypeFilterState !== "all" ? residentTypeFilterState : ""])}
          compactPanel
          commandStripTrigger
          filterFieldCount={1}
          onReset={() => setResidentTypeFilterState("all")}
          dataAttr="resident-inspections-type-filter-open"
        >
          <FieldSingleSelect
            label="Type"
            variant="cell"
            value={residentTypeFilterState}
            onChange={(next) => setResidentTypeFilterState(next as ResidentInspectionTypeFilter)}
            options={[
              { value: "all", label: "All types" },
              { value: "move-in", label: RESIDENT_INSPECTION_TYPE_LABELS["move-in"] },
              { value: "move-out", label: RESIDENT_INSPECTION_TYPE_LABELS["move-out"] },
            ]}
            dataAttr="resident-inspections-type-select"
          />
        </PortalFilterSortSheet>
      }
    />
    ) : (
    <PortalListControlStack variant="command" stickyDestinations destinationAriaLabel="Inspection type" activeDestinationId={kind}
      destinations={routeBase ? (["move-in", "move-out"] as const).map(id => ({ id, label: kindLabel(id), count: rowsFor(id).length, href: `${routeBase}/${id}`, dataAttr: `inspection-type-${id}` })) : undefined}
      destinationRow={!routeBase ? <ManagerPortalStatusPills activeId={kind} mobileSelect={false} onChange={id => changeKind(id as InspectionKind)} tabs={(["move-in", "move-out"] as const).map(id => ({ id, label: kindLabel(id), count: rowsFor(id).length, dataAttr: `inspection-type-${id}` }))} /> : undefined}
      search={{ value: query, onChange: setQuery, placeholder: "Search inspections", dataAttr: "inspections-search" }}
      actions={role === "manager" && !isDemoModeActive()
        ? <PortalIconAction icon={Settings} label={inspectionsSettingsEntry.label} data-attr={inspectionsSettingsEntry.dataAttr} onClick={() => setSettingsOpen(true)} />
        : undefined}
    />
    )}
    {error && <p role="alert" className="rounded-xl border border-border p-3 text-sm">{error}</p>}
    {!error && data.notice && showInspectionLoadNotice(role, data.notice) && (
      <p role="status" className="rounded-xl border border-border p-3 text-sm text-muted">{data.notice}</p>
    )}
    {embeddedScope && !loading && !embeddedPrimaryReport ? (
      <div className="mx-1 flex flex-col items-center gap-4 rounded-2xl border border-dashed border-border bg-card/40 px-6 py-10 text-center" data-attr="inspection-embedded-empty">
        <ClipboardCheck className="h-10 w-10 text-primary" aria-hidden />
        <div className="space-y-2">
          <p className="text-base font-semibold">No {kindLabel(kind).toLowerCase()} photos yet</p>
        </div>
        <Button onClick={openEmbeddedInspection} disabled={busy || embeddedEditDisabled} data-attr="inspection-embedded-create">
          Add {kindLabel(kind).toLowerCase()} photos
        </Button>
      </div>
    ) : null}
    {embeddedScope && !loading && embeddedPrimaryReport ? (
      <div className="mx-1 space-y-4 rounded-2xl border border-border bg-card/50 p-5" data-attr="inspection-embedded-resume">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="space-y-1">
            <p className="text-base font-semibold">{kindLabel(kind)} photos</p>
            <p className="flex flex-wrap items-center gap-2.5 text-sm text-muted">
              <PortalRowFact icon={CalendarDays} srLabel="Tenancy">
                {tenancyDate(embeddedPrimaryReport.inspection_date) || embeddedPrimaryReport.inspection_date}
              </PortalRowFact>
              <PortalRowFact icon={Camera} srLabel="Photos">{photoLine(embeddedPrimaryReport.photos)}</PortalRowFact>
            </p>
          </div>
        </div>
        <Button onClick={openEmbeddedInspection} disabled={busy} data-attr="inspection-embedded-continue">
          {embeddedPrimaryReport.photos.total ? "Open photos" : "Add photos"}
        </Button>
      </div>
    ) : null}
    {loading ? <div role="status" aria-label="Loading inspections" className="space-y-3 p-4"><div className="h-16 animate-pulse rounded-xl bg-foreground/5" /><div className="h-16 animate-pulse rounded-xl bg-foreground/5" /></div> : embeddedScope ? null : <PortalRecordListSurface
      isEmpty={effectiveShownRows.length === 0}
      // No pill: an inspection opens by itself once a resident has a room, so the
      // card is tile + title + the sibling that does have reports. A search that hides
      // every row gets the muted no-match card with Clear search, as Properties does.
      emptyCard={effectiveSearchHidesEveryRow ? {
        title: portalEmptyNoMatchTitle("inspections", query),
        section: "inspections",
        tone: "muted",
        clear: { label: "Clear search", onClick: () => setQuery(""), dataAttr: "inspections-empty-clear-search" },
      } : isResidentBucketMode ? {
        title: `No inspections ${residentActiveBucket === "in-progress" ? "in progress" : residentActiveBucket} yet`,
        section: "inspections",
        sibling: routeBase
          ? portalEmptySibling(
              RESIDENT_INSPECTION_TAB_ORDER.map((id) => ({
                id,
                label: RESIDENT_INSPECTION_TAB_LABELS[id].toLowerCase(),
                count: residentBucketCounts[id],
                href: `${routeBase}/${id}`,
              })),
              residentActiveBucket,
            )
          : null,
      } : {
        title: role === "manager" ? portalEmptyCopy(`inspections.${kind}`).title : kind === "move-in" ? "No move-in inspection yet" : "No move-out inspection yet",
        section: "inspections",
        sibling: routeBase
          ? portalEmptySibling(
              (["move-in", "move-out"] as const).map((id) => ({ id, label: kindLabel(id).toLowerCase(), count: rowsFor(id).length, href: `${routeBase}/${id}` })),
              kind,
            )
          : null,
      }}
      add={{
        ariaLabel: `Add ${effectiveKindForAdd === "move-in" ? "move-in" : "move-out"} inspection`,
        inline: true,
        dataAttr: "inspection-add",
        onClick: () => {
          const next = visible.find((residency) =>
            residency.canCreate && !visibleReports.some((report) => report.application_id === residency.id && report.kind === effectiveKindForAdd),
          );
          if (next) openResidency(next, isResidentBucketMode ? effectiveKindForAdd : undefined);
        },
        disabled: !visible.some((residency) =>
          residency.canCreate && !visibleReports.some((report) => report.application_id === residency.id && report.kind === effectiveKindForAdd),
        ),
      }}
      onBulkClear={() => setSelected(new Set())}
      bulkCount={selected.size}
      bulkActions={<PortalSectionActionRow variant="header">
        <Button variant="outline" disabled={busy || selectedReports.length === 0} onClick={() => run(async () => { for (const report of selectedReports) await downloadInspection(role, report.id); })} data-attr="inspection-bulk-download">Download PDF</Button>
      </PortalSectionActionRow>}
    >{effectiveShownRows.map(row => <PortalApplicantRecordRow key={row.key} name={row.name} address={row.address}
      facts={<>
        {row.tenancy ? <PortalRowFact icon={CalendarDays} srLabel="Tenancy">{row.tenancy}</PortalRowFact> : null}
        <PortalRowFact icon={Camera} srLabel="Photos">{row.photos}</PortalRowFact>
        {row.roomProgress && row.roomProgress.total > 0 ? (
          <PortalRowFact icon={ClipboardCheck} srLabel="Room progress">{roomProgressLine(row.roomProgress)}</PortalRowFact>
        ) : row.required ? (
          <PortalRowFact icon={ClipboardCheck} srLabel="Requirement">Required</PortalRowFact>
        ) : null}
      </>}
      checked={selected.has(row.key)}
      onSelectedChange={checked => setSelected(current => { const next = new Set(current); if (checked) next.add(row.key); else next.delete(row.key); return next; })}
      onOpen={() => openRow(row)}
      dataAttr="inspection-row" />)}</PortalRecordListSurface>}
    {role === "manager" && <ProPortalSettingsModal open={settingsOpen} onClose={() => setSettingsOpen(false)} initialTab="inspections" scoped scopedTitle={settingsDialogTitlePrefix(inspectionsSettingsEntry)} propertyOptions={propertyOptions} />}
  </div>;
}
