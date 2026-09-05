"use client";

import Image from "next/image";
import { useEffect, useRef, useState } from "react";
import { Camera, Download, Save } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { NativeSelect, Textarea } from "@/components/ui/input";
import { Modal } from "@/components/ui/modal";
import { PortalCollapsibleSection } from "@/components/portal/portal-collapsible-section";
import { PortalSectionActionRow } from "@/components/portal/portal-section-action-row";
import { useNativeCamera } from "@/lib/native/use-native-camera";
import { downloadInspection, inspectionRequest } from "@/lib/inspections/client";
import { inspectionRoomLabel, INSPECTION_CONDITIONS, type InspectionDetail, type InspectionItem, type InspectionObservation, type InspectionRole } from "@/lib/inspections/model";

const observations = (detail: InspectionDetail, role: InspectionRole) => detail.report.document.areas.flatMap(a => a.items).map(i => ({ itemId: i.id, condition: i[role].condition, notes: i[role].notes }));
type Action = "submit" | "acknowledge" | "complete" | "reopen";
const actions: Record<Action, { label: string; explanation: string }> = {
  submit: { label: "Submit for review", explanation: "This saves your observations and locks both sets of observations for review. The resident can acknowledge the saved report; the manager can reopen it if changes are needed." },
  acknowledge: { label: "Acknowledge review", explanation: "I have reviewed the manager and resident observations and photos in this report. This confirms review, not agreement with charges or responsibility for damage." },
  complete: { label: "Complete inspection", explanation: "This permanently locks the acknowledged report and its photos. A completed move-in report can be used as the baseline for move-out." },
  reopen: { label: "Reopen for changes", explanation: "Both parties can edit their observations again. The resident will need to review and acknowledge the revised report." },
};

function ReadObservation({ label, value }: { label: string; value: InspectionObservation }) {
  return <div className="min-w-0 space-y-2">
    <p className="text-xs font-semibold text-muted">{label}</p>
    <Badge tone={value.condition === "damaged" ? "warning" : "neutral"}>{INSPECTION_CONDITIONS[value.condition]}</Badge>
    {value.notes && <p className="ph-no-capture ph-no-record whitespace-pre-wrap break-words text-sm text-foreground">{value.notes}</p>}
    <PhotoList photos={value.photos} label={label} />
  </div>;
}

function PhotoList({ photos, label, onRemove, disabled }: { photos: InspectionObservation["photos"]; label: string; onRemove?: (id: string) => Promise<void>; disabled?: boolean }) {
  return <div className="flex flex-wrap gap-2">{photos.map(photo => <div key={photo.id} className="w-28 space-y-1">
    {/* Signed evidence URLs are bearer credentials; exclude both href and image from analytics/replay. */}
    {photo.url ? <a href={photo.url} target="_blank" rel="noreferrer" className="ph-no-capture ph-no-record" data-attr="inspection-photo-view" aria-label={`View ${label} photo`}>
      <Image src={photo.url} unoptimized width={112} height={84} alt={`${label} evidence`} className="h-20 w-28 rounded-lg object-cover" />
    </a> : <p className="text-xs text-muted">Photo unavailable. Reload to retry.</p>}
    {onRemove && <Button variant="ghost" className="min-h-10 px-2 text-xs" disabled={disabled} data-attr="inspection-photo-remove" onClick={() => onRemove(photo.id)}>Remove photo</Button>}
  </div>)}</div>;
}

export function InspectionEditor({ initial, role, userId, onBack, onChanged }: {
  initial: InspectionDetail; role: InspectionRole; userId: string; onBack: () => void; onChanged: () => void;
}) {
  const [detail, setDetail] = useState(initial);
  const [saved, setSaved] = useState(() => JSON.stringify(observations(initial, role)));
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const working = useRef(false);
  const discardConfirmed = useRef(false);
  const leaveHref = useRef<string | null>(null);
  const [confirm, setConfirm] = useState<Action | "leave" | "reload" | null>(null);
  const { capture } = useNativeCamera();
  const { report, baseline, canEdit } = detail;
  const dirty = JSON.stringify(observations(detail, role)) !== saved;
  const editable = canEdit && report.status === "draft";
  const items = report.document.areas.flatMap(a => a.items);
  const checked = items.filter(i => i[role].condition !== "unchecked").length;
  const baselineItems = new Map(baseline?.document.areas.flatMap(a => a.items).map(i => [i.id, i]) ?? []);

  useEffect(() => {
    if (!dirty) return;
    const prevent = (event: BeforeUnloadEvent) => { if (!discardConfirmed.current) { event.preventDefault(); event.returnValue = ""; } };
    const guardLink = (event: MouseEvent) => {
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const link = (event.target as Element | null)?.closest<HTMLAnchorElement>("a[href]");
      if (!link || link.target === "_blank" || link.hasAttribute("download") || link.href === window.location.href || link.getAttribute("href")?.startsWith("#")) return;
      event.preventDefault(); event.stopPropagation();
      leaveHref.current = link.href; setConfirm("leave");
    };
    window.addEventListener("beforeunload", prevent);
    document.addEventListener("click", guardLink, true);
    return () => { window.removeEventListener("beforeunload", prevent); document.removeEventListener("click", guardLink, true); };
  }, [dirty]);

  const accept = (next: InspectionDetail) => {
    setDetail(next); setSaved(JSON.stringify(observations(next, role))); onChanged();
  };
  const run = async (operation: () => Promise<void>) => {
    if (working.current) return;
    working.current = true; setBusy(true); setError(""); setNotice("");
    try { await operation(); }
    catch (e) { setError(e instanceof Error ? e.message : "Could not save the report. Please try again."); }
    finally { working.current = false; setBusy(false); }
  };
  const save = async () => {
    if (!dirty) return detail;
    const next = await inspectionRequest<InspectionDetail>(role, `/${report.id}`, { method: "PATCH", body: JSON.stringify({ revision: report.revision, observations: observations(detail, role) }) });
    accept(next); return next;
  };
  const update = (id: string, patch: Partial<Pick<InspectionObservation, "notes" | "condition">>) => {
    setDetail(current => ({ ...current, report: { ...current.report, document: { ...current.report.document,
      areas: current.report.document.areas.map(a => ({ ...a, items: a.items.map(i => i.id === id ? { ...i, [role]: { ...i[role], ...patch } } : i) })),
    } } }));
  };
  const upload = (itemId: string) => run(async () => {
    const photo = await capture();
    if (!photo) return;
    try {
      const current = await save();
      const form = new FormData(); form.set("file", photo.file); form.set("itemId", itemId); form.set("revision", String(current.report.revision));
      accept(await inspectionRequest<InspectionDetail>(role, `/${report.id}/photos`, { method: "POST", body: form }));
      setNotice("Photo added.");
    } finally { URL.revokeObjectURL(photo.previewUrl); }
  });
  const remove = (photoId: string) => run(async () => {
    const current = await save();
    accept(await inspectionRequest<InspectionDetail>(role, `/${report.id}/photos`, { method: "DELETE", body: JSON.stringify({ photoId, revision: current.report.revision }) }));
    setNotice("Photo removed from the report.");
  });
  const confirmAction = () => run(async () => {
    if (confirm === "leave") { discardConfirmed.current = true; if (leaveHref.current) { setSaved(JSON.stringify(observations(detail, role))); window.location.assign(leaveHref.current); } else onBack(); return; }
    if (confirm === "reload") {
      accept(await inspectionRequest<InspectionDetail>(role, `/${report.id}`)); setConfirm(null); return;
    }
    if (!confirm) return;
    const current = await save();
    accept(await inspectionRequest<InspectionDetail>(role, `/${report.id}/status`, { method: "POST", body: JSON.stringify({ revision: current.report.revision, action: confirm }) }));
    setNotice("Report updated."); setConfirm(null);
  });

  const renderItem = (item: InspectionItem) => <div key={item.id} className="space-y-3 border-b border-border py-4 last:border-0">
    <h3 className="text-sm font-semibold text-foreground">{item.label}</h3>
    <div className="grid gap-4 md:grid-cols-2">
      {editable ? <div className="min-w-0 space-y-2">
        <label className="block text-xs font-semibold text-muted" htmlFor={`${item.id}-condition`}>Your observations ({role})</label>
        <NativeSelect id={`${item.id}-condition`} aria-label={`${item.label} condition`} value={item[role].condition} disabled={busy} data-attr="inspection-condition" onChange={e => update(item.id, { condition: e.target.value as InspectionObservation["condition"] })}>
          {Object.entries(INSPECTION_CONDITIONS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </NativeSelect>
        <Textarea aria-label={`${item.label} notes`} placeholder="Describe condition or damage…" value={item[role].notes} maxLength={3000} disabled={busy} className="ph-no-capture ph-no-record" data-attr="inspection-notes" onChange={e => update(item.id, { notes: e.target.value })} />
        <PhotoList photos={item[role].photos} label={item.label} disabled={busy} onRemove={item[role].photos.every(p => p.uploadedBy === userId) ? remove : undefined} />
        <Button variant="outline" className="min-h-10 px-3 text-xs" disabled={busy} data-attr="inspection-photo-add" onClick={() => upload(item.id)}><Camera className="h-4 w-4" /> Add photo</Button>
      </div> : <ReadObservation label={`Your observations (${role})`} value={item[role]} />}
      <ReadObservation label={role === "manager" ? "Resident observations" : "Manager observations"} value={item[role === "manager" ? "resident" : "manager"]} />
    </div>
    {baselineItems.has(item.id) && <details className="rounded-xl bg-foreground/5 p-3">
      <summary className="cursor-pointer text-xs font-semibold text-muted">Move-in baseline · {baseline?.inspection_date}</summary>
      <div className="mt-3 grid gap-4 md:grid-cols-2"><ReadObservation label="Move-in / manager" value={baselineItems.get(item.id)!.manager} /><ReadObservation label="Move-in / resident" value={baselineItems.get(item.id)!.resident} /></div>
    </details>}
  </div>;

  return <div className="min-w-0 space-y-4" data-attr="inspection-editor">
    <PortalSectionActionRow variant="header" className="flex-wrap">
      <Button variant="outline" disabled={busy} onClick={() => { leaveHref.current = null; if (dirty) setConfirm("leave"); else onBack(); }} data-attr="inspection-back">Back to inspections</Button>
      <Button variant="outline" disabled={busy} onClick={() => dirty ? setConfirm("reload") : run(async () => { accept(await inspectionRequest<InspectionDetail>(role, `/${report.id}`)); })} data-attr="inspection-reload">Reload</Button>
      <Button variant="outline" disabled={busy || dirty} onClick={() => run(() => downloadInspection(role, report.id))} data-attr="inspection-download"><Download className="h-4 w-4" /> Download PDF</Button>
      {editable && <Button disabled={busy || !dirty} onClick={() => run(async () => { await save(); setNotice("Observations saved."); })} data-attr="inspection-save"><Save className="h-4 w-4" /> Save changes</Button>}
    </PortalSectionActionRow>
    <div className="space-y-2 rounded-2xl border border-border bg-card p-4">
      <div className="flex flex-wrap items-center gap-2"><h2 className="text-lg font-semibold text-foreground">{report.kind === "move-in" ? "Move-in" : "Move-out"} inspection</h2><Badge tone={report.status === "completed" ? "success" : report.status === "submitted" ? "warning" : "neutral"}>{report.status === "submitted" ? "Awaiting review" : report.status === "completed" ? "Completed" : "Draft"}</Badge></div>
      <p className="text-sm text-muted">{report.resident_name} · {report.property_label}{report.room_label ? ` · ${inspectionRoomLabel(report.room_label)}` : ""}</p>
      <p className="text-xs text-muted">{report.inspection_date} · {checked} of {items.length} items checked by you · {dirty ? "Unsaved changes" : "Saved"}</p>
      <p className="text-xs text-muted">Record each area’s condition and attach photos. Use Not applicable for areas outside this residency. Manager and resident observations remain separate.</p>
      {report.kind === "move-out" && !baseline && <p className="text-sm text-muted">No completed move-in baseline is attached. These observations do not establish when damage occurred.</p>}
      {report.status === "completed" && <p className="text-sm text-muted">This completed report is locked permanently.</p>}
      {report.document.residentAcknowledgment && <p className="text-sm text-muted">Resident reviewed this report on {new Date(report.document.residentAcknowledgment.at).toLocaleDateString()}.</p>}
    </div>
    {error && <p role="alert" className="rounded-xl border border-border p-3 text-sm text-foreground">{error} Your unsaved observations remain here.</p>}
    {notice && <p role="status" className="text-sm text-muted">{notice}</p>}
    {report.document.areas.map((area, index) => <PortalCollapsibleSection key={area.id} title={area.label} defaultExpanded={index === 0} subtitle={`${area.items.filter(i => i[role].condition !== "unchecked").length} of ${area.items.length} checked`} toggleDataAttr="inspection-area-toggle">{area.items.map(renderItem)}</PortalCollapsibleSection>)}
    {canEdit && <PortalSectionActionRow variant="header" className="flex-wrap">
      {editable && <Button disabled={busy} onClick={() => setConfirm("submit")} data-attr="inspection-submit">Submit for review</Button>}
      {report.status === "submitted" && role === "resident" && !report.document.residentAcknowledgment && <Button disabled={busy} onClick={() => setConfirm("acknowledge")} data-attr="inspection-acknowledge">Acknowledge review</Button>}
      {report.status === "submitted" && role === "manager" && <><Button variant="outline" disabled={busy} onClick={() => setConfirm("reopen")} data-attr="inspection-reopen">Reopen for changes</Button><Button disabled={busy || !report.document.residentAcknowledgment} onClick={() => setConfirm("complete")} data-attr="inspection-complete">Complete inspection</Button></>}
    </PortalSectionActionRow>}
    {report.status === "submitted" && !report.document.residentAcknowledgment && <p className="text-sm text-muted">Waiting for the resident to review and acknowledge this report before completion.</p>}
    <PortalCollapsibleSection title="Record history" defaultExpanded={false}>{report.document.history.map((event, i) => <p key={i} className="py-1 text-xs text-muted">{new Date(event.at).toLocaleString()} · {event.role} · {event.action}</p>)}</PortalCollapsibleSection>
    <Modal open={confirm !== null} onClose={() => { if (!busy) setConfirm(null); }} dismissBlocked={busy} title={confirm === "leave" ? "Discard unsaved changes?" : confirm === "reload" ? "Reload saved report?" : confirm ? actions[confirm].label : "Review report"} assistantStrip={false} footer={<Button disabled={busy} onClick={confirmAction} data-attr="inspection-confirm">{confirm === "leave" ? "Discard and leave" : confirm === "reload" ? "Reload saved report" : confirm ? actions[confirm].label : "Confirm"}</Button>}>
      <p className="text-sm text-muted">{confirm === "leave" || confirm === "reload" ? "Your unsaved condition and note changes will be discarded. Saved observations and photos will remain." : confirm ? actions[confirm].explanation : ""}</p>
      {error && <p role="alert" className="mt-3 text-sm">{error}</p>}
    </Modal>
  </div>;
}
