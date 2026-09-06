"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input, Select } from "@/components/ui/input";
import { Modal } from "@/components/ui/modal";
import { PortalRecordListSurface } from "@/components/portal/portal-record-list-surface";
import { PortalPersonRecordRow } from "@/components/portal/portal-record-row";
import { PortalListControlStack } from "@/components/portal/portal-list-control-stack";
import { PortalSectionActionRow } from "@/components/portal/portal-section-action-row";
import { ManagerPortalPageShell, ManagerPortalStatusPills } from "@/components/portal/portal-metrics";
import { InspectionEditor } from "@/components/portal/inspection-editor";
import { usePortalSession } from "@/hooks/use-portal-session";
import { isDemoModeActive } from "@/lib/demo/demo-session";
import { downloadInspection, inspectionRequest, loadInspectionList, INSPECTIONS_CHANGED, type InspectionList } from "@/lib/inspections/client";
import { inspectionRoomLabel, createInspectionSchema, type InspectionDetail, type InspectionKind, type InspectionResidency, type InspectionRole, type InspectionStatus, type InspectionSummary } from "@/lib/inspections/model";

const kindLabel = (kind: InspectionKind) => kind === "move-in" ? "Move-in" : "Move-out";
const statusLabel = (status: InspectionStatus) => status === "submitted" ? "Awaiting review" : status === "completed" ? "Completed" : "Draft";

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
 */
type InspectionRow = {
  key: string;
  name: string;
  subtitle: string;
  preview: string;
  badge: { label: string; tone: "success" | "warning" | "neutral" };
  report?: InspectionSummary;
  residency?: InspectionResidency;
  /** Ascending sort within a tab: the date that tab is about, blanks last. */
  sortKey: string;
};

const occupancyBadge = {
  upcoming: { label: "Moving in", tone: "warning" as const },
  current: { label: "Living here", tone: "success" as const },
  past: { label: "Moved out", tone: "neutral" as const },
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
  const reportBadge = (report: InspectionSummary) => ({
    label: statusLabel(report.status),
    tone: report.status === "completed" ? "success" as const : report.status === "submitted" ? "warning" as const : "neutral" as const,
  });

  // One row per FILED report, so an earlier completed report never becomes unreachable just
  // because a newer one exists — plus one roster row for every resident who has none yet. A
  // report whose residency is gone (withdrawn, reassigned) still gets its row: evidence must
  // not disappear because the application row moved on.
  const rows: InspectionRow[] = forKind.map(report => {
    const residency = byId.get(report.application_id);
    const filed = `${kindLabel(kind)} inspection ${tenancyDate(report.inspection_date) || report.inspection_date}`;
    const tenancy = tenancyLine(residency);
    return {
      key: `report:${report.id}`,
      name: residency?.name || report.resident_name,
      subtitle: `${residency?.property || report.property_label}${(residency?.room || report.room_label) ? ` · ${inspectionRoomLabel(residency?.room || report.room_label)}` : ""}`,
      preview: tenancy ? `${tenancy} · ${filed}` : filed,
      badge: reportBadge(report),
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
      subtitle: `${residency.property}${residency.room ? ` · ${inspectionRoomLabel(residency.room)}` : ""}`,
      preview: `${tenancyLine(residency)} · No ${kindLabel(kind).toLowerCase()} inspection yet`,
      badge: occupancyBadge[residency.occupancy],
      residency,
      sortKey: (kind === "move-in" ? residency.moveInDate : residency.moveOutDate) || "9999-12-31",
    });
  }

  // Tenancy date, then the person, then their reports oldest-first — two reports for one
  // resident read as a history rather than an arbitrary pair.
  return rows.sort((a, b) => a.sortKey.localeCompare(b.sortKey) || a.name.localeCompare(b.name)
    || (a.report?.inspection_date ?? "").localeCompare(b.report?.inspection_date ?? "") || a.key.localeCompare(b.key));
}

export function ManagerInspectionsPage({ kind = "move-in", reportId, basePath = "/portal" }: { kind?: InspectionKind; reportId?: string; basePath?: string }) {
  if (reportId) return <InspectionsPanel role="manager" initialKind={kind} reportId={reportId} routeBase={`${basePath}/inspections`} />;
  return <ManagerPortalPageShell title="Inspections" hideTitleOnMobileNav compactFilterRow><InspectionsPanel role="manager" initialKind={kind} reportId={reportId} routeBase={`${basePath}/inspections`} /></ManagerPortalPageShell>;
}

export function InspectionsPanel({ role, applicationId, initialKind = "move-in", reportId, routeBase }: {
  role: InspectionRole; applicationId?: string; initialKind?: InspectionKind; reportId?: string; routeBase?: string;
}) {
  const { userId, ready } = usePortalSession();
  // Remount state on an account/portal/residency change so another viewer never sees old evidence.
  if (!ready) return <p role="status" className="p-4 text-sm text-muted">Loading inspections…</p>;
  if (!userId && !isDemoModeActive()) return <p className="p-4 text-sm text-muted">Sign in to view your inspections.</p>;
  return <InspectionWorkspace key={`${role}:${userId}:${applicationId ?? ""}:${reportId ?? ""}:${initialKind}`} userId={userId ?? "demo"} role={role} applicationId={applicationId} initialKind={initialKind} reportId={reportId} routeBase={routeBase} />;
}

function InspectionWorkspace({ userId, role, applicationId, initialKind, reportId, routeBase }: {
  userId: string; role: InspectionRole; applicationId?: string; initialKind: InspectionKind; reportId?: string; routeBase?: string;
}) {
  const router = useRouter();
  const [kind, setKind] = useState(initialKind);
  const [data, setData] = useState<InspectionList>({ reports: [], residencies: [] });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [detail, setDetail] = useState<InspectionDetail | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [createOpen, setCreateOpen] = useState(false);
  const [application, setApplication] = useState(applicationId ?? "");
  const [date, setDate] = useState(() => { const now = new Date(); return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`; });
  const [baseline, setBaseline] = useState("");
  const [busy, setBusy] = useState(false);
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
  const changeKind = (next: InspectionKind) => {
    setSelected(new Set()); setKind(next); setBaseline("");
    if (routeBase) router.push(`${routeBase}/${next}`);
  };
  const residencies = data.residencies.filter(r => (!applicationId || r.id === applicationId) && r.canCreate);
  const candidates = data.reports.filter(r => r.application_id === application && r.kind === "move-in" && r.status === "completed" && r.inspection_date <= date);
  const visible = data.residencies.filter(r => !applicationId || r.id === applicationId);
  const rowsFor = (which: InspectionKind) => buildInspectionRows(which, visible, data.reports);
  const rows = rowsFor(kind);
  const startInspection = (residency: InspectionResidency) => {
    setApplication(residency.id); setBaseline(""); setCreateOpen(true);
  };
  const create = () => run(async () => {
    const parsed = createInspectionSchema.safeParse({ applicationId: application, kind, inspectionDate: date, baselineId: kind === "move-out" && baseline ? baseline : null });
    if (!parsed.success) throw new Error(parsed.error.issues[0]?.message || "Check the inspection details.");
    const value = await inspectionRequest<InspectionDetail>(role, "", { method: "POST", body: JSON.stringify(parsed.data) });
    setCreateOpen(false); setSelected(new Set());
    if (routeBase) router.push(`${routeBase}/${kind}/${value.report.id}`);
    else setDetail(value);
  });

  if (detail) return <InspectionEditor initial={detail} role={role} userId={userId} onChanged={() => { /* API mutations invalidate the shared list. */ }} onBack={() => { setDetail(null); setSelected(new Set()); if (routeBase) router.push(`${routeBase}/${kind}`); }} />;
  if (reportId) return <div className="space-y-3 p-4">{error ? <p role="alert">{error}</p> : <p role="status">Loading inspection…</p>}<Button variant="outline" onClick={() => router.push(`${routeBase}/${kind}`)} data-attr="inspection-list-back">Back to inspections</Button></div>;
  return <div className="min-w-0 space-y-3" data-attr="inspections-panel">
    <PortalListControlStack variant="command" stickyDestinations={false} destinationAriaLabel="Inspection type" activeDestinationId={kind}
      destinations={routeBase ? (["move-in", "move-out"] as const).map(id => ({ id, label: kindLabel(id), count: rowsFor(id).length, href: `${routeBase}/${id}`, dataAttr: `inspection-type-${id}` })) : undefined}
      destinationRow={!routeBase ? <ManagerPortalStatusPills activeId={kind} mobileSelect={false} onChange={id => changeKind(id as InspectionKind)} tabs={(["move-in", "move-out"] as const).map(id => ({ id, label: kindLabel(id), count: rowsFor(id).length, dataAttr: `inspection-type-${id}` }))} /> : undefined}
    />
    {error && <p role="alert" className="rounded-xl border border-border p-3 text-sm">{error}</p>}
    {!error && data.notice && <p role="status" className="rounded-xl border border-border p-3 text-sm text-muted">{data.notice}</p>}
    {loading ? <div role="status" aria-label="Loading inspections" className="space-y-3 p-4"><div className="h-16 animate-pulse rounded-xl bg-foreground/5" /><div className="h-16 animate-pulse rounded-xl bg-foreground/5" /></div> : <PortalRecordListSurface
      isEmpty={rows.length === 0}
      empty={<p className="p-5 text-sm text-muted">{isDemoModeActive() ? "Open your signed-in portal to create and review residency inspections." : kind === "move-in" ? "No one is moving in or living here yet. Approve an application and give it a property placement to start." : "No one is living here or has moved out yet."}</p>}
      add={residencies.length ? { ariaLabel: `Add ${kindLabel(kind).toLowerCase()} inspection`, onClick: () => { setApplication(applicationId ?? residencies[0]?.id ?? ""); setBaseline(""); setCreateOpen(true); }, dataAttr: "inspection-add" } : undefined}
      bulkCount={selected.size}
      bulkActions={<PortalSectionActionRow variant="header"><Button variant="outline" disabled={busy} onClick={() => run(async () => { for (const id of selected) await downloadInspection(role, id); })} data-attr="inspection-bulk-download">Download PDF{selected.size > 1 ? "s" : ""}</Button>{selected.size === 1 && <Button disabled={busy} onClick={() => open([...selected][0]!)} data-attr="inspection-bulk-open">View inspection</Button>}</PortalSectionActionRow>}
    >{rows.map(row => <PortalPersonRecordRow key={row.key} name={row.name} subtitle={row.subtitle} preview={row.preview} trailing={<Badge tone={row.badge.tone}>{row.badge.label}</Badge>}
      // Only a filed report can be selected: the bulk actions download and open PDFs.
      checked={row.report ? selected.has(row.report.id) : undefined}
      onSelectedChange={row.report ? (checked => setSelected(current => { const next = new Set(current); const id = row.report!.id; if (checked) next.add(id); else next.delete(id); return next; })) : undefined}
      onOpen={() => { if (row.report) { void open(row.report.id); } else if (row.residency?.canCreate) startInspection(row.residency); }}
      dataAttr="inspection-row" />)}</PortalRecordListSurface>}
    <Modal open={createOpen} onClose={() => { if (!busy) setCreateOpen(false); }} dismissBlocked={busy} title={`New ${kindLabel(kind).toLowerCase()} inspection`} assistantStrip={false} footer={<Button onClick={create} disabled={busy || !application || !date} data-attr="inspection-create">Create inspection</Button>}>
      <div className="space-y-4">
        <label className="block space-y-1 text-sm">Resident and placement<Select aria-label="Resident and placement" value={application} disabled={Boolean(applicationId)} onChange={e => { setApplication(e.target.value); setBaseline(""); }} data-attr="inspection-residency">{residencies.map(r => <option key={r.id} value={r.id}>{r.name} · {r.property}{r.room ? ` · ${inspectionRoomLabel(r.room)}` : ""}</option>)}</Select></label>
        <label className="block space-y-1 text-sm">Inspection date<Input aria-label="Inspection date" type="date" value={date} onChange={e => { setDate(e.target.value); setBaseline(""); }} data-attr="inspection-date" /></label>
        {kind === "move-out" && <label className="block space-y-1 text-sm">Move-in baseline<Select aria-label="Move-in baseline" value={baseline} onChange={e => setBaseline(e.target.value)} data-attr="inspection-baseline"><option value="">No baseline</option>{candidates.map(r => <option key={r.id} value={r.id}>{r.inspection_date} · {r.property_label} · {inspectionRoomLabel(r.room_label) || "Property"}</option>)}</Select><span className="block text-xs text-muted">Only completed move-in reports from this residency can be used as a baseline.</span></label>}
        {error && <p role="alert" className="text-sm">{error}</p>}
      </div>
    </Modal>
  </div>;
}
