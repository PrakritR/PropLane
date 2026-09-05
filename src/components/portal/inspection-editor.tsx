"use client";

import Image from "next/image";
import { useCallback, useEffect, useRef, useState } from "react";
import { Camera, ChevronRight, FileText } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { NativeSelect, Textarea } from "@/components/ui/input";
import { Modal } from "@/components/ui/modal";
import { PortalCollapsibleSection } from "@/components/portal/portal-collapsible-section";
import { PortalPageFooterActions } from "@/components/portal/portal-section-action-row";
import { PortalDetailHeader } from "@/components/portal/portal-list-detail-shell";
import { useNativeCamera, type CapturedPhoto } from "@/lib/native/use-native-camera";
import { inspectionDraftKey, discardInspectionDraft, retainInspectionDraft, peekInspectionDraft, takeInspectionDraft, type InspectionEditorDraft } from "@/lib/inspections/editor-drafts";
import { downloadInspection, inspectionRequest } from "@/lib/inspections/client";
import { downloadBlobFile } from "@/lib/portal-document-download";
import { inspectionRoomLabel, INSPECTION_CONDITIONS, type InspectionDetail, type InspectionItem, type InspectionObservation, type InspectionRole, type InspectionArea } from "@/lib/inspections/model";

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
    {value.condition !== "unchecked" && <Badge tone={value.condition === "damaged" ? "warning" : "neutral"}>{INSPECTION_CONDITIONS[value.condition]}</Badge>}
    {value.notes && <p className="ph-no-capture ph-no-record whitespace-pre-wrap break-words text-sm text-foreground">{value.notes}</p>}
    <PhotoList photos={value.photos} label={label} />
  </div>;
}

function PhotoList({ photos, label, onRemove, disabled }: { photos: InspectionObservation["photos"]; label: string; onRemove?: (id: string) => Promise<void>; disabled?: boolean }) {
  return <div className="flex flex-wrap gap-2">{photos.map(photo => <div key={photo.id} className="w-28 space-y-1">
    {/* Signed evidence URLs are bearer credentials; exclude both href and image from analytics/replay. */}
    {photo.url ? <a href={photo.url} target="_blank" rel="noreferrer" className="ph-no-capture ph-no-record" data-attr="inspection-photo-view" aria-label={`View ${label} photo`}>
      <Image src={photo.url} unoptimized width={112} height={80} alt={`${label} evidence`} className="h-20 w-28 rounded-lg object-cover" />
    </a> : <p className="text-xs text-muted">Photo unavailable.</p>}
    {onRemove && <Button variant="ghost" className="min-h-10 px-2 text-xs" disabled={disabled} data-attr="inspection-photo-remove" onClick={() => onRemove(photo.id)}>Remove photo</Button>}
  </div>)}</div>;
}

export function InspectionEditor({ initial, role, userId, onBack, onChanged }: {
  initial: InspectionDetail; role: InspectionRole; userId: string; onBack: () => void; onChanged: () => void;
}) {
  const draftKey = inspectionDraftKey(userId, role, initial.report.id);
  const [restored] = useState(() => peekInspectionDraft(draftKey));
  // A report that is no longer an editable draft is frozen: the server copy is the
  // authoritative record, so a recovered local draft is never merged into it. It is
  // kept beside the report as clearly unsent material the person can read or discard.
  const [resumable] = useState(() => Boolean(restored) && initial.canEdit && initial.report.status === "draft");
  const [unsent, setUnsent] = useState(() => (restored && !resumable ? restored : null));
  const [detail, setDetail] = useState(() => {
    if (!restored || !resumable) return initial;
    const previous = new Map(observations(restored.detail, role).map(item => [item.itemId, item]));
    return { ...initial, report: { ...initial.report, revision: restored.detail.report.revision, document: { ...initial.report.document,
      areas: initial.report.document.areas.map(area => ({ ...area, items: area.items.map(item => {
        const local = previous.get(item.id);
        return local ? { ...item, [role]: { ...item[role], notes: local.notes, condition: local.condition } } : item;
      }) })),
    } } };
  });
  const [saved, setSaved] = useState(() => (resumable && restored ? restored.saved : JSON.stringify(observations(initial, role))));
  const [error, setError] = useState(resumable && restored && restored.detail.report.revision !== initial.report.revision ? "Your draft was restored, but the saved report has changed. Review latest before continuing." : "");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [activeAreaId, setActiveAreaId] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [documentOpen, setDocumentOpen] = useState(false);
  const [choosePhoto, setChoosePhoto] = useState(false);
  const [pendingPhoto, setPendingPhoto] = useState<{ itemId: string; photo: CapturedPhoto } | null>((resumable ? restored?.pendingPhoto : null) ?? null);
  const live = useRef(true);
  const draftRef = useRef<{ dirty: boolean; value: InspectionEditorDraft } | null>(null);
  const working = useRef(false);
  const discardConfirmed = useRef(false);
  const leaveHref = useRef<string | null>(null);
  const [confirm, setConfirm] = useState<Action | "leave" | "reload" | null>(null);
  const { capture } = useNativeCamera();
  const { report, baseline, canEdit } = detail;
  const dirty = JSON.stringify(observations(detail, role)) !== saved;
  const editable = canEdit && report.status === "draft";
  const roomAreas = report.document.roomScope ? report.document.areas : report.document.areas.filter(area => area.id === "area-0");
  const activeArea = roomAreas.find(a => a.id === activeAreaId);
  const photoCount = report.document.areas.flatMap(a => a.items).reduce((n, item) => n + item.manager.photos.length + item.resident.photos.length, 0);
  const baselineItems = new Map(baseline?.document.areas.flatMap(a => a.items).map(i => [i.id, i]) ?? []);
  // Baseline evidence with no counterpart in this report — a legacy 15-area move-in,
  // or a room section (furniture, ensuite) the listing has since dropped. It stays
  // visible as read-only history; it never becomes an item of this inspection.
  const retainedBaselineItems = !baseline || !report.document.roomScope
    ? []
    : baseline.document.roomScope
      ? baseline.document.areas.flatMap(a => a.items).filter(item => !report.document.areas.some(area => area.items.some(i => i.id === item.id)))
      : baseline.document.areas.filter(area => area.id === "area-0").flatMap(area => area.items);

  // While frozen there is nothing to resume, so the retained entry stays the unsent
  // material itself rather than the authoritative report the person is only reading.
  useEffect(() => {
    draftRef.current = editable
      ? { dirty, value: { detail, saved, pendingPhoto } }
      : unsent ? { dirty: true, value: unsent } : null;
  }, [dirty, detail, saved, pendingPhoto, editable, unsent]);
  // A refresh mid-session can freeze a report that still holds a captured file or
  // unsaved typing. Hand that material to the recovery panel rather than leaving it
  // in live state, where `draftRef` would drop it on the next navigation.
  useEffect(() => {
    if (editable || unsent) return;
    if (!dirty && !pendingPhoto) return;
    setUnsent({ detail, saved, pendingPhoto });
    if (pendingPhoto) setPendingPhoto(null);
  }, [editable, unsent, dirty, detail, saved, pendingPhoto]);
  useEffect(() => {
    live.current = true; takeInspectionDraft(draftKey);
    return () => {
      live.current = false;
      const draft = draftRef.current;
      if (draft && !discardConfirmed.current && (draft.dirty || draft.value.pendingPhoto)) retainInspectionDraft(draftKey, draft.value);
      else if (draft?.value.pendingPhoto) URL.revokeObjectURL(draft.value.pendingPhoto.photo.previewUrl);
    };
  }, [draftKey]);
  useEffect(() => {
    if (!dirty && !pendingPhoto) return;
    const prevent = (event: BeforeUnloadEvent) => { if (!discardConfirmed.current) { event.preventDefault(); event.returnValue = ""; } };
    const guardLink = (event: MouseEvent) => {
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const link = (event.target as Element | null)?.closest<HTMLAnchorElement>("a[href]");
      if (!link || link.target === "_blank" || link.hasAttribute("download") || link.href === window.location.href || link.getAttribute("href")?.startsWith("#")) return;
      event.preventDefault(); event.stopPropagation(); leaveHref.current = link.href; setConfirm("leave");
    };
    window.addEventListener("beforeunload", prevent); document.addEventListener("click", guardLink, true);
    return () => { window.removeEventListener("beforeunload", prevent); document.removeEventListener("click", guardLink, true); };
  }, [dirty, pendingPhoto]);

  const accept = useCallback((next: InspectionDetail) => { if (!live.current) return; setDetail(next); setSaved(JSON.stringify(observations(next, role))); onChanged(); }, [role, onChanged]);
  const run = useCallback(async (operation: () => Promise<void>) => {
    if (working.current) return;
    working.current = true; setBusy(true); setError(""); setNotice("");
    try { await operation(); }
    catch (e) { setError(e instanceof Error ? e.message : "Could not save the report. Please try again."); }
    finally { working.current = false; setBusy(false); }
  }, []);
  const save = useCallback(async () => {
    // A frozen report never takes a write, so viewing or downloading one cannot
    // turn into a PATCH the server is bound to refuse.
    if (!dirty || !editable) return detail;
    const next = await inspectionRequest<InspectionDetail>(role, `/${report.id}`, { method: "PATCH", body: JSON.stringify({ revision: report.revision, observations: observations(detail, role) }) });
    accept(next); return next;
  }, [dirty, editable, detail, role, report.id, report.revision, accept]);
  // Inputs remain disabled during a write so a returned snapshot cannot overwrite newer typing.
  // Changes wait for a short typing pause, and every upload/transition also flushes the draft.
  useEffect(() => {
    if (!dirty || busy || error || !editable) return;
    const timer = setTimeout(() => { void run(async () => { await save(); setNotice("Saved automatically."); }); }, 650);
    return () => clearTimeout(timer);
  }, [dirty, busy, error, editable, run, save]);

  // Renew private photo links while idle. A read that overlaps typing, a write or
  // navigation is discarded; refreshing must never replace unsaved observations.
  useEffect(() => {
    if (dirty || busy || pendingPhoto || error) return;
    let cancelled = false;
    let fetching = false;
    let lastRead = Date.now();
    const renew = async () => {
      if (document.visibilityState === "hidden" || fetching || working.current || Date.now() - lastRead < 12 * 60_000) return;
      fetching = true;
      try {
        const next = await inspectionRequest<InspectionDetail>(role, `/${report.id}`);
        if (!cancelled && !working.current) { accept(next); lastRead = Date.now(); }
      } catch { /* A transient read failure keeps the saved evidence; retry on the next idle tick. */ }
      finally { fetching = false; }
    };
    const timer = setInterval(() => { void renew(); }, 60_000);
    const visible = () => { void renew(); };
    document.addEventListener("visibilitychange", visible);
    return () => { cancelled = true; clearInterval(timer); document.removeEventListener("visibilitychange", visible); };
  }, [dirty, busy, pendingPhoto, error, role, report.id, accept]);

  const update = (id: string, patch: Partial<Pick<InspectionObservation, "notes" | "condition">>) => {
    setError(""); setNotice("");
    setDetail(current => ({ ...current, report: { ...current.report, document: { ...current.report.document,
      areas: current.report.document.areas.map(a => ({ ...a, items: a.items.map(i => i.id === id ? { ...i, [role]: { ...i[role], ...patch } } : i) })),
    } } }));
  };
  const sendPhoto = async (itemId: string, photo: CapturedPhoto) => {
    const current = await save();
    const form = new FormData(); form.set("file", photo.file); form.set("itemId", itemId); form.set("revision", String(current.report.revision));
    accept(await inspectionRequest<InspectionDetail>(role, `/${report.id}/photos`, { method: "POST", body: form }));
    if (!live.current) return;
    URL.revokeObjectURL(photo.previewUrl); setPendingPhoto(null); setNotice("Photo added. Your document is up to date.");
  };
  const upload = (itemId: string) => run(async () => {
    const photo = await capture(); if (!photo) return;
    if (pendingPhoto) URL.revokeObjectURL(pendingPhoto.photo.previewUrl);
    setPendingPhoto({ itemId, photo }); setChoosePhoto(false);
    await sendPhoto(itemId, photo);
  });
  const startUpload = () => {
    const area = activeArea ?? (selected.size === 1 ? roomAreas.find(a => selected.has(a.id)) : undefined);
    if (area?.items.length === 1) void upload(area.items[0]!.id);
    else setChoosePhoto(true);
  };
  const remove = (photoId: string) => run(async () => {
    const current = await save();
    accept(await inspectionRequest<InspectionDetail>(role, `/${report.id}/photos`, { method: "DELETE", body: JSON.stringify({ photoId, revision: current.report.revision }) }));
    setNotice("Photo removed from the report.");
  });
  const back = () => {
    if (busy) return;
    if (documentOpen) { setDocumentOpen(false); return; }
    if (activeArea) { setActiveAreaId(null); return; }
    if (pendingPhoto) { leaveHref.current = null; setConfirm("leave"); return; }
    void run(async () => { await save(); onBack(); });
  };
  const confirmAction = () => run(async () => {
    if (confirm === "leave") { discardConfirmed.current = true; if (leaveHref.current) window.location.assign(leaveHref.current); else onBack(); return; }
    if (confirm === "reload") { accept(await inspectionRequest<InspectionDetail>(role, `/${report.id}`)); setConfirm(null); return; }
    if (!confirm) return;
    if (pendingPhoto) throw new Error("Finish uploading or remove the pending photo before submitting.");
    const current = await save();
    const next = await inspectionRequest<InspectionDetail>(role, `/${report.id}/status`, { method: "POST", body: JSON.stringify({ revision: current.report.revision, action: confirm }) });
    accept(next);
    // The resident's explicit submit confirmation also acknowledges the same frozen report.
    // If acknowledgment fails, the submitted record remains intact and the normal acknowledge action can retry.
    if (confirm === "submit" && role === "resident") {
      setConfirm(null);
      accept(await inspectionRequest<InspectionDetail>(role, `/${report.id}/status`, { method: "POST", body: JSON.stringify({ revision: next.report.revision, action: "acknowledge" }) }));
    }
    setNotice("Report updated."); setConfirm(null);
  });
  const hasObservation = (value: InspectionObservation) => value.photos.length > 0 || Boolean(value.notes.trim()) || value.condition !== "unchecked";
  const renderItem = (item: InspectionItem) => <div key={item.id} className="space-y-5 py-4">
    {activeArea && activeArea.items.length > 1 && <h3 className="text-base font-semibold">{item.label}</h3>}
    {editable ? <div className="space-y-4">
      {item[role].photos.length ? <PhotoList photos={item[role].photos} label={item.label} disabled={busy} onRemove={item[role].photos.every(p => p.uploadedBy === userId) ? remove : undefined} /> : <div className="grid min-h-40 place-items-center rounded-2xl border border-dashed border-border bg-card/30 p-6 text-center text-sm text-muted"><span><Camera className="mx-auto mb-3 h-7 w-7 text-primary" />No photos added yet. Use Upload photos below.</span></div>}
      <label className="block text-sm font-medium">Note <span className="font-normal text-muted">(optional)</span><Textarea aria-label={`${item.label} notes`} placeholder="For example: a small mark beside the door." value={item[role].notes} maxLength={3000} disabled={busy} className="ph-no-capture ph-no-record mt-2" data-attr="inspection-notes" onChange={e => update(item.id, { notes: e.target.value })} /></label>
      <details className="text-sm"><summary className="cursor-pointer text-muted">Condition (optional)</summary><NativeSelect aria-label={`${item.label} condition`} value={item[role].condition} disabled={busy} className="mt-2" data-attr="inspection-condition" onChange={e => update(item.id, { condition: e.target.value as InspectionObservation["condition"] })}>{Object.entries(INSPECTION_CONDITIONS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</NativeSelect></details>
    </div> : <ReadObservation label={`Your observations (${role})`} value={item[role]} />}
    {hasObservation(item[role === "manager" ? "resident" : "manager"]) && <div className="border-t border-border pt-4"><ReadObservation label={role === "manager" ? "Resident observations" : "Manager observations"} value={item[role === "manager" ? "resident" : "manager"]} /></div>}
    {baselineItems.has(item.id) && <details className="rounded-xl border border-border bg-card/30 p-4"><summary className="cursor-pointer text-sm font-medium">Move-in photos and notes · {baseline?.inspection_date}</summary><div className="mt-4 space-y-5"><ReadObservation label="Move-in / resident" value={baselineItems.get(item.id)!.resident} /><ReadObservation label="Move-in / manager" value={baselineItems.get(item.id)!.manager} /></div></details>}
  </div>;
  const renderDocument = () => <article className="mx-auto max-w-4xl space-y-7 rounded-2xl border border-border bg-card p-5 sm:p-10" data-attr="inspection-document-preview">
    <div className="text-center"><h2 className="font-serif text-2xl font-bold">ROOM CONDITION REPORT</h2><p className="mt-3 text-sm text-muted">{report.kind === "move-in" ? "Move-in" : "Move-out"} · {inspectionRoomLabel(report.room_label)} · {report.inspection_date}</p><p className="mt-2 text-sm text-muted">{report.resident_name} · {report.property_label}</p></div>
    {report.document.areas.map(area => <section key={area.id} className="space-y-4 border-t border-border pt-5"><h3 className="font-serif text-lg font-bold">{area.label}</h3>{area.items.map(item => <div key={item.id} className="space-y-4">{area.items.length > 1 && <h4 className="text-sm font-semibold">{item.label}</h4>}{(["resident", "manager"] as const).map(side => hasObservation(item[side]) ? <ReadObservation key={side} label={side === "resident" ? "Resident" : "Manager"} value={item[side]} /> : null)}{!hasObservation(item.resident) && !hasObservation(item.manager) && <p className="text-sm text-muted">No photos or condition statement recorded.</p>}</div>)}</section>)}
    <p className="border-t border-border pt-5 text-sm text-muted">{report.document.residentAcknowledgment ? `Resident acknowledged on ${new Date(report.document.residentAcknowledgment.at).toLocaleDateString()}.` : "Resident acknowledgment pending."} {report.status === "completed" ? "Manager approved. This completed report is preserved." : "Manager approval pending."}</p>
  </article>;
  const itemLabels = new Map(report.document.areas.flatMap(a => a.items).map(i => [i.id, i.label]));
  // Only what the server never acknowledged. `saved` is the last accepted snapshot,
  // so an observation matching it IS in the report above and must not be relisted
  // as never sent — this panel is read as a statement about an evidence document.
  const unsentNotes = (() => {
    if (!unsent) return [];
    let acknowledged: Map<string, { notes: string; condition: InspectionObservation["condition"] }>;
    try {
      acknowledged = new Map(
        (JSON.parse(unsent.saved) as ReturnType<typeof observations>).map(entry => [entry.itemId, entry]),
      );
    } catch {
      acknowledged = new Map();
    }
    return observations(unsent.detail, role).filter(entry => {
      if (!entry.notes.trim() && entry.condition === "unchecked") return false;
      const prior = acknowledged.get(entry.itemId);
      return !prior || prior.notes !== entry.notes || prior.condition !== entry.condition;
    });
  })();
  const discardUnsent = () => {
    if (unsent?.pendingPhoto) URL.revokeObjectURL(unsent.pendingPhoto.photo.previewUrl);
    setUnsent(null);
    discardInspectionDraft(draftKey);
  };
  const saveUnsentPhoto = async () => {
    const photo = unsent?.pendingPhoto?.photo;
    if (!photo) return;
    const result = await downloadBlobFile({
      fileName: photo.file.name || "inspection-photo.jpg",
      mimeType: photo.file.type || "image/jpeg",
      blob: photo.file,
      title: "Inspection photo",
    });
    setNotice(result === "failed" ? "" : "Photo saved to your device.");
    if (result === "failed") setError("Could not save the photo to your device.");
  };
  const frozenReason = report.status === "completed"
    ? "completed"
    : report.status === "submitted"
      ? "submitted for review"
      : "no longer editable";
  const areaCount = (area: InspectionArea) => area.items.reduce((n, item) => n + item.manager.photos.length + item.resident.photos.length, 0);
  const backLabel = documentOpen || activeArea ? "Back to room sections" : "Back to inspections";
  const status = report.status === "completed" ? "Completed" : report.status === "submitted" ? "Awaiting review" : "Draft";
  return <div className="min-w-0 space-y-5" data-attr="inspection-editor">
    <PortalDetailHeader bare hideBackText title={documentOpen ? "Inspection document" : activeArea?.label ?? report.resident_name} subtitle={`${inspectionRoomLabel(report.room_label) || "Assigned room"} · ${report.property_label}`} avatarName={!activeArea && !documentOpen ? report.resident_name : undefined} onBack={back} backLabel={backLabel} dataAttrBack="inspection-back" />
    <div className="flex flex-wrap items-center gap-3 px-2 text-sm text-muted"><span>{report.kind === "move-in" ? "Move-in" : "Move-out"} · {report.inspection_date}</span><Badge tone={report.status === "completed" ? "success" : report.status === "submitted" ? "warning" : "neutral"}>{status}</Badge><span role="status" className="ml-auto">{busy ? "Saving…" : dirty ? "Changes waiting to save" : `${photoCount} photo${photoCount === 1 ? "" : "s"} in report`}</span></div>
    {error && <p role="alert" className="rounded-xl border border-border p-3 text-sm">{error} {dirty ? "Your unsaved notes remain here." : ""}</p>}
    {notice && <p role="status" className="px-2 text-sm text-muted">{notice}</p>}
    {pendingPhoto && <div className="flex items-center gap-4 rounded-xl border border-border p-3"><Image src={pendingPhoto.photo.previewUrl} unoptimized width={96} height={72} alt="Photo waiting to upload" className="ph-no-capture ph-no-record h-18 w-24 rounded-lg object-cover" /><p className="text-sm text-muted">{busy ? "Uploading photo…" : editable ? "This photo has not uploaded. Use Retry upload below." : "This photo has not uploaded and this report can no longer be edited."}</p></div>}
    {documentOpen ? renderDocument() : activeArea ? <div className="space-y-4 px-2">{activeArea.items.map(renderItem)}</div> : <div>
      <p className="px-2 pb-4 text-sm text-muted">Open a section to add photos of the assigned room. Photos and notes update the document automatically.</p>
      {roomAreas.map(area => <div key={area.id} className={`flex min-h-24 items-center gap-4 border-b border-l-2 border-b-border px-3 py-5 ${selected.has(area.id) ? "border-l-primary bg-primary/5" : "border-l-transparent"}`} data-attr="inspection-section-row"><input type="checkbox" className="h-4 w-4 shrink-0 accent-primary" aria-label={`Select ${area.label}`} checked={selected.has(area.id)} onChange={e => setSelected(current => { const next = new Set(current); if (e.target.checked) next.add(area.id); else next.delete(area.id); return next; })} /><button className="min-w-0 flex-1 text-left" onClick={() => setActiveAreaId(area.id)} data-attr="inspection-area-open"><span className="flex items-center gap-2 text-base font-semibold">{area.label}<ChevronRight className="h-4 w-4 text-muted" /></span><span className="mt-1 block text-sm text-muted">{areaCount(area) ? `${areaCount(area)} photo${areaCount(area) === 1 ? "" : "s"} added` : "Photos and optional notes"}</span></button></div>)}
    </div>}
    {report.status === "submitted" && !report.document.residentAcknowledgment && <p className="px-2 text-sm text-muted">The resident needs to confirm review before the manager can approve.</p>}
    {unsent && (unsentNotes.length > 0 || unsent.pendingPhoto) && <PortalCollapsibleSection title="Unsent notes and photos from this device" defaultExpanded={false}>
      <p className="pb-3 text-sm text-muted">This report became {frozenReason} before these reached the server, so they are <strong>not part of the report</strong> above and were never sent. Keep anything you still need, then discard them.</p>
      {unsentNotes.map(entry => <div key={entry.itemId} className="space-y-1 border-t border-border py-3">
        <p className="text-sm font-semibold">{itemLabels.get(entry.itemId) ?? entry.itemId}</p>
        {entry.condition !== "unchecked" && <p className="text-xs text-muted">{INSPECTION_CONDITIONS[entry.condition]}</p>}
        {entry.notes.trim() && <p className="ph-no-capture ph-no-record whitespace-pre-wrap break-words text-sm">{entry.notes}</p>}
      </div>)}
      {unsent.pendingPhoto && <div className="flex flex-wrap items-center gap-4 border-t border-border py-3">
        <Image src={unsent.pendingPhoto.photo.previewUrl} unoptimized width={96} height={72} alt="Photo that was never uploaded" className="ph-no-capture ph-no-record h-18 w-24 rounded-lg object-cover" />
        <p className="min-w-0 flex-1 text-sm text-muted">This photo never uploaded and cannot be added to a locked report. Save it to your device if you still need it.</p>
        <Button variant="outline" onClick={() => saveUnsentPhoto()} data-attr="inspection-unsent-photo-save">Save photo to device</Button>
      </div>}
      <Button variant="ghost" className="mt-2" onClick={discardUnsent} data-attr="inspection-unsent-discard">Discard unsent notes</Button>
    </PortalCollapsibleSection>}
    {retainedBaselineItems.length > 0 && <PortalCollapsibleSection title={baseline?.document.roomScope ? "Move-in sections not in this report" : "Original move-in room photos"} defaultExpanded={false}>
      <p className="pb-3 text-sm text-muted">{baseline?.document.roomScope
        ? "Room observations preserved from the move-in report for sections the listing no longer includes. Read-only history — they are not part of this inspection."
        : "Room observations preserved from the original move-in report."}</p>
      {retainedBaselineItems.map(item => <div key={item.id} className="space-y-3 border-t border-border py-4"><h3 className="text-sm font-semibold">{item.label}</h3><ReadObservation label="Move-in / resident" value={item.resident} /><ReadObservation label="Move-in / manager" value={item.manager} /></div>)}
    </PortalCollapsibleSection>}
    <PortalCollapsibleSection title="Record history" defaultExpanded={false}>{report.document.history.map((event, i) => <p key={i} className="py-1 text-xs text-muted">{new Date(event.at).toLocaleString()} · {event.role} · {event.action}</p>)}</PortalCollapsibleSection>
    <PortalPageFooterActions pinned rowVariant="header">
      <Button variant="outline" aria-label={documentOpen ? "Download document" : "View document"} disabled={busy} onClick={() => documentOpen ? run(async () => { await save(); await downloadInspection(role, report.id); }) : setDocumentOpen(true)} data-attr="inspection-download"><FileText className="h-4 w-4" /><span className="hidden sm:inline">{documentOpen ? "Download document" : "View document"}</span></Button>
      {editable && !pendingPhoto && <Button variant="outline" disabled={busy} aria-label="Upload photos" onClick={startUpload} data-attr="inspection-photo-add"><Camera className="h-4 w-4" /><span className="sm:hidden">Photos</span><span className="hidden sm:inline">Upload photos</span></Button>}
      {pendingPhoto && <>{editable && <Button variant="outline" disabled={busy} onClick={() => run(() => sendPhoto(pendingPhoto.itemId, pendingPhoto.photo))} data-attr="inspection-photo-retry">Retry upload</Button>}<Button variant="ghost" disabled={busy} onClick={() => { URL.revokeObjectURL(pendingPhoto.photo.previewUrl); setPendingPhoto(null); }} data-attr="inspection-photo-discard">Remove</Button></>}
      {error && dirty && editable && !pendingPhoto && <Button variant="outline" disabled={busy} onClick={() => run(async () => { await save(); })} data-attr="inspection-save-retry">Retry save</Button>}
      {error && <Button variant="ghost" disabled={busy} onClick={() => setConfirm("reload")} data-attr="inspection-conflict-review">Review latest</Button>}
      {canEdit && editable && !pendingPhoto && <Button className="ml-auto" disabled={busy} onClick={() => setConfirm("submit")} aria-label="Submit for review" data-attr="inspection-submit"><span className="sm:hidden">Submit</span><span className="hidden sm:inline">Submit for review</span></Button>}
      {canEdit && report.status === "submitted" && role === "resident" && !report.document.residentAcknowledgment && <Button className="ml-auto" disabled={busy} onClick={() => setConfirm("acknowledge")} data-attr="inspection-acknowledge">Confirm review</Button>}
      {canEdit && report.status === "submitted" && role === "manager" && <><Button variant="outline" disabled={busy} onClick={() => setConfirm("reopen")} data-attr="inspection-reopen">Request changes</Button><Button className="ml-auto" disabled={busy || !report.document.residentAcknowledgment} onClick={() => setConfirm("complete")} aria-label="Approve inspection" data-attr="inspection-complete"><span className="sm:hidden">Approve</span><span className="hidden sm:inline">Approve inspection</span></Button></>}
    </PortalPageFooterActions>
    <Modal open={choosePhoto} onClose={() => { if (!busy) setChoosePhoto(false); }} dismissBlocked={busy} title="Add photos to a section" assistantStrip={false}><div className="space-y-2">{(activeArea ? [activeArea] : selected.size ? roomAreas.filter(area => selected.has(area.id)) : roomAreas).map(area => <div key={area.id}><h3 className="py-2 text-sm font-semibold">{area.label}</h3>{area.items.map(item => <Button key={item.id} variant="outline" className="mb-2 w-full justify-between" disabled={busy} onClick={() => upload(item.id)} data-attr="inspection-upload-section">{item.label}<Camera className="h-4 w-4" /></Button>)}</div>)}</div></Modal>
    <Modal open={confirm !== null} onClose={() => { if (!busy) setConfirm(null); }} dismissBlocked={busy} title={confirm === "leave" ? "Leave without saving?" : confirm === "reload" ? "Review the latest saved report?" : confirm === "complete" ? "Approve inspection" : confirm ? actions[confirm].label : "Review report"} assistantStrip={false} footer={<Button disabled={busy} onClick={confirmAction} data-attr="inspection-confirm">{confirm === "leave" ? "Discard and leave" : confirm === "reload" ? "Review latest" : confirm === "complete" ? "Approve inspection" : confirm ? actions[confirm].label : "Confirm"}</Button>}>
      <p className="text-sm text-muted">{confirm === "leave" ? "Unsaved notes and pending uploads will be discarded. Saved photos and observations remain." : confirm === "reload" ? "Unsaved notes will be discarded. Your pending photo is kept so you can retry its upload against the latest report." : confirm === "submit" && role === "resident" ? "I have reviewed the report, including both parties' notes and photos. Submit and acknowledge this saved report for manager review. This does not mean agreeing to charges or responsibility for damage." : confirm ? actions[confirm].explanation : ""}</p>
      {error && <p role="alert" className="mt-3 text-sm">{error}</p>}
    </Modal>
  </div>;
}
