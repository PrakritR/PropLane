"use client";

import { PortalIconAction } from "@/components/portal/portal-icon-action";

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
import { InspectionEditor } from "@/components/portal/inspection-editor";
import { PortalRecordDetailPage, PortalRecordActions } from "@/components/portal/portal-record-detail-page";
import { PortalRecordSectionChrome, PortalRecordHeaderIconActions } from "@/components/portal/portal-record-section-chrome";
import { PortalRecordRelatedPanel } from "@/components/portal/portal-record-related-panel";
import { recordSections } from "@/lib/portals/record-sections";
import { renderRecordSection } from "@/components/portal/record-section-renderers";
import { useAppUi } from "@/components/providers/app-ui-provider";
import { parseServiceRecordTab } from "@/lib/portal-detail-routes";
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
import { inspectionRoomLabel, type InspectionDetail, type InspectionKind, type InspectionPhotoCounts, type InspectionResidency, type InspectionRole, type InspectionSummary } from "@/lib/inspections/model";

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
  const rows: InspectionRow[] = forKind.map(report => {
    const residency = byId.get(report.application_id);
    return {
      key: `report:${report.id}`,
      name: residency?.name || report.resident_name,
      address: `${residency?.property || report.property_label}${(residency?.room || report.room_label) ? ` · ${inspectionRoomLabel(residency?.room || report.room_label)}` : ""}`,
      tenancy: tenancyLine(residency),
      photos: photoLine(report.photos),
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
      address: `${residency.property}${residency.room ? ` · ${inspectionRoomLabel(residency.room)}` : ""}`,
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

/** Resident's own Inspections section — move-in / move-out reports for their room. */
export function ResidentInspectionsPage({ kind = "move-in", reportId, basePath = "/resident" }: { kind?: InspectionKind; reportId?: string; basePath?: string }) {
  if (reportId) return <InspectionsPanel role="resident" initialKind={kind} reportId={reportId} routeBase={`${basePath}/inspections`} />;
  return (
    <ManagerPortalPageShell
      title="Inspections"
      hideTitleOnMobileNav
      compactFilterRow
    >
      <InspectionsPanel role="resident" initialKind={kind} reportId={reportId} routeBase={`${basePath}/inspections`} />
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

export function InspectionsPanel({ role, applicationId, initialKind = "move-in", reportId, recordTab, routeBase, embeddedInResident = false }: {
  role: InspectionRole; applicationId?: string; initialKind?: InspectionKind; reportId?: string; recordTab?: string; routeBase?: string; embeddedInResident?: boolean;
}) {
  const { userId, ready } = usePortalSession();
  // Remount state on an account/portal/residency change so another viewer never sees old evidence.
  if (!ready) return <p role="status" className="p-4 text-sm text-muted">Loading inspections…</p>;
  if (!userId && !isDemoModeActive()) return <p className="p-4 text-sm text-muted">Sign in to view your inspections.</p>;
  return <InspectionWorkspace key={`${role}:${userId}:${applicationId ?? ""}:${reportId ?? ""}:${initialKind}`} userId={userId ?? "demo"} role={role} applicationId={applicationId} initialKind={initialKind} reportId={reportId} recordTab={recordTab} routeBase={routeBase} embeddedInResident={embeddedInResident} />;
}

function InspectionWorkspace({ userId, role, applicationId, initialKind, reportId, recordTab, routeBase, embeddedInResident = false }: {
  userId: string; role: InspectionRole; applicationId?: string; initialKind: InspectionKind; reportId?: string; recordTab?: string; routeBase?: string; embeddedInResident?: boolean;
}) {
  const router = useRouter();
  const { showToast } = useAppUi();
  const [kind, setKind] = useState(initialKind);
  const [data, setData] = useState<InspectionList>({ reports: [], residencies: [] });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [detail, setDetail] = useState<InspectionDetail | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [query, setQuery] = useState("");
  const propertyOptions = useMemo(
    () => (role === "manager" ? buildManagerPropertyFilterOptions(userId) : []),
    [role, userId],
  );
  const working = useRef(false);
  const requestVersion = useRef(0);
  const live = useRef(true);
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
    inspectionRequest<InspectionDetail>(role, `/${reportId}`).then(value => {
      if (!cancelled) setDetail(value);
    }).catch(e => { if (!cancelled) setError(e instanceof Error ? e.message : "Could not open this report."); });
    return () => { cancelled = true; };
  }, [reportId, role]);
  const run = async (operation: () => Promise<void>) => {
    if (working.current) return;
    working.current = true; setBusy(true); setError("");
    try { await operation(); }
    catch (e) { if (live.current) setError(e instanceof Error ? e.message : "Could not finish the request."); }
    finally { working.current = false; if (live.current) setBusy(false); }
  };
  const open = (id: string) => run(async () => {
    if (routeBase) { router.push(`${routeBase}/${kind}/${id}`); return; }
    setDetail(await inspectionRequest<InspectionDetail>(role, `/${id}`)); setSelected(new Set());
  });
  /**
   * Open the residency's report for this tab, creating it on the spot the first time anyone
   * looks. The roster row already knows the resident, the room and the move date, so the old
   * "New inspection" dialog only asked the manager to retype what the row was showing them.
   */
  const openResidency = (residency: InspectionResidency) => run(async () => {
    const value = await inspectionRequest<InspectionDetail>(role, "", {
      method: "POST", body: JSON.stringify({ applicationId: residency.id, kind }),
    });
    setSelected(new Set());
    if (routeBase) router.push(`${routeBase}/${kind}/${value.report.id}`);
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
  const searchHidesEveryRow = rows.length > 0 && shownRows.length === 0;
  const selectedRows = rows.filter(row => selected.has(row.key));
  const selectedReports = selectedRows.filter(row => row.report).map(row => row.report!);
  const openRow = (row: InspectionRow) => {
    if (row.report) void open(row.report.id);
    else if (row.residency?.canCreate) openResidency(row.residency);
  };

  const openEmbeddedInspection = () => {
    if (embeddedPrimaryReport) void open(embeddedPrimaryReport.id);
    else if (embeddedResidency?.canCreate) openResidency(embeddedResidency);
  };
  const embeddedEditDisabled = !embeddedPrimaryReport && !embeddedResidency?.canCreate;

  if (detail) {
    const editor = <InspectionEditor initial={detail} role={role} userId={userId} onChanged={() => { void refresh(true); }} onBack={() => { setDetail(null); setSelected(new Set()); if (routeBase) router.push(`${routeBase}/${kind}`); }} />;
    if (role !== "manager" || !routeBase) return editor;
    const recordTabId = parseServiceRecordTab(recordTab);
    const inspectionBasePath = routeBase.replace(/\/inspections$/, "") || "/portal";
    const sections = recordSections("manager", "inspection", {
      basePath: inspectionBasePath,
      inspectionKind: kind,
    });
    const onInspectionHeaderAction = (actionId: string) => {
      if (actionId === "download-report") {
        void downloadInspection(role, detail.report.id);
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
          {recordTabId === "overview" ? editor : recordTabId === "payments" ? (
            <PortalRecordRelatedPanel title="Payments" empty="No payment on this inspection." />
          ) : recordTabId === "vendor" ? (
            <PortalRecordRelatedPanel title="Vendor" empty="No vendor on this inspection." />
          ) : recordTabId === "resident" ? (
            <PortalRecordRelatedPanel
              title="Resident"
              value={detail.report.resident_name}
              empty="No resident on this inspection."
            />
          ) : (
            renderRecordSection(recordTabId, {
              role: "manager",
              kind: "inspection",
              kindLabel: "report",
              recordId: detail.report.id,
              recordLabel: kindLabel(detail.report.kind),
            })
          )}
        </PortalRecordSectionChrome>
      </PortalRecordDetailPage>
    );
  }
  if (reportId) return <div className="space-y-3 p-4">{error ? <p role="alert">{error}</p> : <p role="status">Loading inspection…</p>}<Button variant="outline" onClick={() => router.push(`${routeBase}/${kind}`)} data-attr="inspection-list-back">Back to inspections</Button></div>;
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
          <div>
            <p className="text-base font-semibold">{kindLabel(kind)} photos</p>
            <p className="text-sm text-muted">{tenancyDate(embeddedPrimaryReport.inspection_date) || embeddedPrimaryReport.inspection_date} · {photoLine(embeddedPrimaryReport.photos)}</p>
          </div>
        </div>
        <Button onClick={openEmbeddedInspection} disabled={busy} data-attr="inspection-embedded-continue">
          {embeddedPrimaryReport.photos.total ? "Open photos" : "Add photos"}
        </Button>
      </div>
    ) : null}
    {loading ? <div role="status" aria-label="Loading inspections" className="space-y-3 p-4"><div className="h-16 animate-pulse rounded-xl bg-foreground/5" /><div className="h-16 animate-pulse rounded-xl bg-foreground/5" /></div> : embeddedScope ? null : <PortalRecordListSurface
      isEmpty={shownRows.length === 0}
      // No pill: an inspection opens by itself once a resident has a room, so the
      // card is tile + title + the sibling that does have reports. A search that hides
      // every row gets the muted no-match card with Clear search, as Properties does.
      emptyCard={searchHidesEveryRow ? {
        title: portalEmptyNoMatchTitle("inspections", query),
        section: "inspections",
        tone: "muted",
        clear: { label: "Clear search", onClick: () => setQuery(""), dataAttr: "inspections-empty-clear-search" },
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
        ariaLabel: `Add ${kind === "move-in" ? "move-in" : "move-out"} inspection`,
        inline: true,
        dataAttr: "inspection-add",
        onClick: () => {
          const next = visible.find((residency) =>
            residency.canCreate && !visibleReports.some((report) => report.application_id === residency.id && report.kind === kind),
          );
          if (next) openResidency(next);
        },
        disabled: !visible.some((residency) =>
          residency.canCreate && !visibleReports.some((report) => report.application_id === residency.id && report.kind === kind),
        ),
      }}
      onBulkClear={() => setSelected(new Set())}
      bulkCount={selected.size}
      bulkActions={<PortalSectionActionRow variant="header">
        <Button variant="outline" disabled={busy || selectedReports.length === 0} onClick={() => run(async () => { for (const report of selectedReports) await downloadInspection(role, report.id); })} data-attr="inspection-bulk-download">Download PDF</Button>
      </PortalSectionActionRow>}
    >{shownRows.map(row => <PortalApplicantRecordRow key={row.key} name={row.name} address={row.address}
      facts={<>
        {row.tenancy ? <PortalRowFact icon={CalendarDays} srLabel="Tenancy">{row.tenancy}</PortalRowFact> : null}
        <PortalRowFact icon={Camera} srLabel="Photos">{row.photos}</PortalRowFact>
        {row.required ? <PortalRowFact icon={ClipboardCheck} srLabel="Requirement">Required</PortalRowFact> : null}
      </>}
      checked={selected.has(row.key)}
      onSelectedChange={checked => setSelected(current => { const next = new Set(current); if (checked) next.add(row.key); else next.delete(row.key); return next; })}
      onOpen={() => openRow(row)}
      dataAttr="inspection-row" />)}</PortalRecordListSurface>}
    {role === "manager" && <ProPortalSettingsModal open={settingsOpen} onClose={() => setSettingsOpen(false)} initialTab="inspections" scoped scopedTitle={settingsDialogTitlePrefix(inspectionsSettingsEntry)} propertyOptions={propertyOptions} />}
  </div>;
}
