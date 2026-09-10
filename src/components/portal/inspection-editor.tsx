"use client";

import Image from "next/image";
import { useCallback, useEffect, useRef, useState } from "react";
import { Camera, ChevronRight, FileText } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { NativeSelect, Textarea } from "@/components/ui/input";
import { Modal } from "@/components/ui/modal";
import { PortalCollapsibleSection } from "@/components/portal/portal-collapsible-section";
import { PortalPageFooterActions, PortalSectionActionRow } from "@/components/portal/portal-section-action-row";
import { PortalDetailHeader } from "@/components/portal/portal-list-detail-shell";
import { useNativeCamera, type CapturedPhoto, type PhotoCaptureSource } from "@/lib/native/use-native-camera";
import { inspectionDraftKey, appendUnsentRecovery, discardInspectionDraft, retainInspectionDraft, peekInspectionDraft, takeInspectionDraft, type InspectionEditorDraft, type InspectionEditorSnapshot } from "@/lib/inspections/editor-drafts";
import { downloadInspection, inspectionRequest } from "@/lib/inspections/client";
import { downloadBlobFile } from "@/lib/portal-document-download";
import { inspectionRoomLabel, INSPECTION_CONDITIONS, type InspectionDetail, type InspectionItem, type InspectionObservation, type InspectionRole, type InspectionArea } from "@/lib/inspections/model";

const observations = (detail: InspectionDetail, role: InspectionRole) => detail.report.document.areas.flatMap(a => a.items).map(i => ({ itemId: i.id, condition: i[role].condition, notes: i[role].notes }));

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
  const [resumable] = useState(() => Boolean(restored?.active) && initial.canEdit);
  const [unsent, setUnsent] = useState<InspectionEditorSnapshot[]>(() => {
    const buckets = restored?.unsent ?? [];
    return restored?.active && !resumable ? appendUnsentRecovery(buckets, restored.active) : buckets;
  });
  const [detail, setDetail] = useState(() => {
    if (!restored?.active || !resumable) return initial;
    const previous = new Map(observations(restored.active.detail, role).map(item => [item.itemId, item]));
    return { ...initial, report: { ...initial.report, revision: restored.active!.detail.report.revision, document: { ...initial.report.document,
      areas: initial.report.document.areas.map(area => ({ ...area, items: area.items.map(item => {
        const local = previous.get(item.id);
        return local ? { ...item, [role]: { ...item[role], notes: local.notes, condition: local.condition } } : item;
      }) })),
    } } };
  });
  const [saved, setSaved] = useState(() => (resumable && restored?.active ? restored.active.saved : JSON.stringify(observations(initial, role))));
  const [error, setError] = useState(resumable && restored?.active && restored.active.detail.report.revision !== initial.report.revision ? "Your draft was restored, but the saved report has changed. Review latest before continuing." : "");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [activeAreaId, setActiveAreaId] = useState<string | null>(null);
  /** Which section the source sheet is shooting into. Null only for a legacy multi-item form. */
  const [uploadArea, setUploadArea] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [uploadSourceOpen, setUploadSourceOpen] = useState(false);
  const [choosePhoto, setChoosePhoto] = useState(false);
  const [photoSource, setPhotoSource] = useState<PhotoCaptureSource | null>(null);
  const [pendingPhoto, setPendingPhoto] = useState<{ itemId: string; photo: CapturedPhoto } | null>((resumable ? restored?.active?.pendingPhoto : null) ?? null);
  const live = useRef(true);
  const draftRef = useRef<InspectionEditorDraft | null>(null);
  const handedOff = useRef(false);
  const working = useRef(false);
  const discardConfirmed = useRef(false);
  const leaveHref = useRef<string | null>(null);
  const [confirm, setConfirm] = useState<"leave" | "reload" | null>(null);
  const { capture } = useNativeCamera();
  const { report, baseline, canEdit } = detail;
  const dirty = JSON.stringify(observations(detail, role)) !== saved;
  // The manager's side is always open. The resident's closes when they submit, and only a
  // manager reopens it — read-only otherwise means the VIEWER cannot edit at all (a
  // co-manager holding a read grant).
  const submission = report.document.residentSubmission ?? null;
  const submittedByResident = Boolean(submission);
  const editable = canEdit && !(role === "resident" && submittedByResident);
  const roomAreas = report.document.roomScope ? report.document.areas : report.document.areas.filter(area => area.id === "area-0");
  const activeArea = roomAreas.find(a => a.id === activeAreaId);
  const photoCount = report.document.areas.flatMap(a => a.items).reduce((n, item) => n + item.manager.photos.length + item.resident.photos.length, 0);
  /** Submitting hands over YOUR photos, so the manager's do not enable the button. */
  const ownPhotoCount = report.document.areas.flatMap(a => a.items).reduce((n, item) => n + item[role].photos.length, 0);
  const baselineItems = new Map(baseline?.document.areas.flatMap(a => a.items).map(i => [i.id, i]) ?? []);
  // Baseline evidence with no counterpart in this report — a legacy 15-area move-in,
  // or a room section (furniture, ensuite) the listing has since dropped. It stays
  // visible as read-only history; it never becomes an item of this inspection.
  const retainedBaselineItems = !baseline || !report.document.roomScope
    ? []
    : baseline.document.roomScope
      ? baseline.document.areas.flatMap(a => a.items).filter(item => !report.document.areas.some(area => area.items.some(i => i.id === item.id)))
      : baseline.document.areas.filter(area => area.id === "area-0").flatMap(area => area.items);

  // The two buckets are tracked independently. A reopened report can carry a fresh
  // draft AND frozen-out recovery material at the same time, and neither may evict
  // the other on the way out.
  useEffect(() => {
    const active = editable && (dirty || pendingPhoto) ? { detail, saved, pendingPhoto } : null;
    draftRef.current = active || unsent.length > 0 ? { active, unsent } : null;
  }, [dirty, detail, saved, pendingPhoto, editable, unsent]);
  // A refresh mid-session can freeze a report that still holds a captured file or
  // unsaved typing. Hand that material to the recovery bucket rather than leaving it
  // in live state, where the active slot would drop it on the next navigation. The
  // latch resets when a report reopens, so a second freeze is captured too.
  useEffect(() => {
    if (editable) { handedOff.current = false; return; }
    if (handedOff.current || (!dirty && !pendingPhoto)) return;
    handedOff.current = true;
    setUnsent(current => appendUnsentRecovery(current, { detail, saved, pendingPhoto }));
    if (pendingPhoto) setPendingPhoto(null);
  }, [editable, dirty, detail, saved, pendingPhoto]);
  useEffect(() => {
    live.current = true; takeInspectionDraft(draftKey);
    return () => {
      live.current = false;
      const draft = draftRef.current;
      if (!draft) return;
      // "Discard and leave" discards the ACTIVE draft only. Recovery material has its
      // own explicit discard, so leaving must never take it silently.
      const active = discardConfirmed.current ? null : draft.active;
      if (!active && draft.active?.pendingPhoto) URL.revokeObjectURL(draft.active.pendingPhoto.photo.previewUrl);
      if (active || draft.unsent.length > 0) retainInspectionDraft(draftKey, { active, unsent: draft.unsent });
    };
  }, [draftKey]);
  useEffect(() => {
    if (!dirty && !pendingPhoto && unsent.length === 0) return;
    const prevent = (event: BeforeUnloadEvent) => { if (!discardConfirmed.current) { event.preventDefault(); event.returnValue = ""; } };
    const guardLink = (event: MouseEvent) => {
      if (!dirty && !pendingPhoto) return;
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const link = (event.target as Element | null)?.closest<HTMLAnchorElement>("a[href]");
      if (!link || link.target === "_blank" || link.hasAttribute("download") || link.href === window.location.href || link.getAttribute("href")?.startsWith("#")) return;
      event.preventDefault(); event.stopPropagation(); leaveHref.current = link.href; setConfirm("leave");
    };
    window.addEventListener("beforeunload", prevent); document.addEventListener("click", guardLink, true);
    return () => { window.removeEventListener("beforeunload", prevent); document.removeEventListener("click", guardLink, true); };
  }, [dirty, pendingPhoto, unsent]);

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
  const upload = (itemId: string, source: PhotoCaptureSource) => run(async () => {
    const photo = await capture(source); if (!photo) return;
    if (pendingPhoto) URL.revokeObjectURL(pendingPhoto.photo.previewUrl);
    setPendingPhoto({ itemId, photo }); setChoosePhoto(false); setPhotoSource(null);
    await sendPhoto(itemId, photo);
  });
  /**
   * The camera opens for the section it was tapped on. Choosing a source and then choosing a
   * section was two dialogs in front of every photo; the section is already the thing the
   * person pointed at, so only the source is still a question.
   */
  const startUpload = (areaId?: string) => { setUploadArea(areaId ?? activeArea?.id ?? null); setUploadSourceOpen(true); };
  const pickUploadSource = (source: PhotoCaptureSource) => {
    setUploadSourceOpen(false);
    const area = roomAreas.find(a => a.id === uploadArea) ?? activeArea;
    if (area?.items.length === 1) void upload(area.items[0]!.id, source);
    else { setPhotoSource(source); setChoosePhoto(true); }
  };
  const remove = (photoId: string) => run(async () => {
    const current = await save();
    accept(await inspectionRequest<InspectionDetail>(role, `/${report.id}/photos`, { method: "DELETE", body: JSON.stringify({ photoId, revision: current.report.revision }) }));
    setNotice("Photo removed from the report.");
  });
  const back = () => {
    if (busy) return;
    if (activeArea) { setActiveAreaId(null); return; }
    if (pendingPhoto) { leaveHref.current = null; setConfirm("leave"); return; }
    void run(async () => { await save(); onBack(); });
  };
  const changeSubmission = (action: "submit" | "reopen") => run(async () => {
    const current = await save();
    accept(await inspectionRequest<InspectionDetail>(role, `/${report.id}/submission`, {
      method: "POST", body: JSON.stringify({ revision: current.report.revision, action }),
    }));
    setSelected(new Set());
    // Submitting already has a standing line of its own; only the reopen needs announcing.
    setNotice(action === "submit" ? "" : "Reopened. The resident can add photos again.");
  });
  const confirmAction = () => run(async () => {
    if (confirm === "leave") { discardConfirmed.current = true; if (leaveHref.current) window.location.assign(leaveHref.current); else onBack(); return; }
    if (confirm === "reload") { accept(await inspectionRequest<InspectionDetail>(role, `/${report.id}`)); setConfirm(null); return; }
  });
  const hasObservation = (value: InspectionObservation) => value.photos.length > 0 || Boolean(value.notes.trim()) || value.condition !== "unchecked";
  const renderItem = (item: InspectionItem) => <div key={item.id} className="space-y-5 py-4">
    {activeArea && activeArea.items.length > 1 && <h3 className="text-base font-semibold">{item.label}</h3>}
    {editable ? <div className="space-y-4">
      {item[role].photos.length ? <PhotoList photos={item[role].photos} label={item.label} disabled={busy} onRemove={item[role].photos.every(p => p.uploadedBy === userId) ? remove : undefined} /> : <div className="grid min-h-40 place-items-center rounded-2xl border border-dashed border-border bg-card/30 p-6 text-center text-sm text-muted"><span><Camera className="mx-auto mb-3 h-7 w-7 text-primary" />No photos in this section yet. Use Add photos below.</span></div>}
      <label className="block text-sm font-medium">Note <span className="font-normal text-muted">(optional)</span><Textarea aria-label={`${item.label} notes`} placeholder="For example: a small mark beside the door." value={item[role].notes} maxLength={3000} disabled={busy} className="ph-no-capture ph-no-record mt-2" data-attr="inspection-notes" onChange={e => update(item.id, { notes: e.target.value })} /></label>
    </div> : <ReadObservation label={`Your observations (${role})`} value={item[role]} />}
    {hasObservation(item[role === "manager" ? "resident" : "manager"]) && <div className="border-t border-border pt-4"><ReadObservation label={role === "manager" ? "Resident observations" : "Manager observations"} value={item[role === "manager" ? "resident" : "manager"]} /></div>}
    {baselineItems.has(item.id) && <details className="rounded-xl border border-border bg-card/30 p-4"><summary className="cursor-pointer text-sm font-medium">Move-in photos and notes · {baseline?.inspection_date}</summary><div className="mt-4 space-y-5"><ReadObservation label="Move-in / resident" value={baselineItems.get(item.id)!.resident} /><ReadObservation label="Move-in / manager" value={baselineItems.get(item.id)!.manager} /></div></details>}
  </div>;
  const itemLabels = new Map(report.document.areas.flatMap(a => a.items).map(i => [i.id, i.label]));
  // Only what the server never acknowledged. Each bucket carries the snapshot the
  // server had accepted at the time, so an observation matching it IS in the report
  // above and must not be relisted as never sent — this panel is read as a statement
  // about an evidence document. Later buckets win for the same item.
  const unsentNotes = (() => {
    const byItem = new Map<string, { itemId: string; notes: string; condition: InspectionObservation["condition"] }>();
    for (const bucket of unsent) {
      let acknowledged: Map<string, { notes: string; condition: InspectionObservation["condition"] }>;
      try {
        acknowledged = new Map(
          (JSON.parse(bucket.saved) as ReturnType<typeof observations>).map(entry => [entry.itemId, entry]),
        );
      } catch {
        acknowledged = new Map();
      }
      for (const entry of observations(bucket.detail, role)) {
        if (!entry.notes.trim() && entry.condition === "unchecked") continue;
        const prior = acknowledged.get(entry.itemId);
        if (prior && prior.notes === entry.notes && prior.condition === entry.condition) continue;
        byItem.set(entry.itemId, entry);
      }
    }
    return [...byItem.values()];
  })();
  const unsentPhotos = unsent.flatMap(bucket => (bucket.pendingPhoto ? [bucket.pendingPhoto] : []));
  const discardUnsent = () => {
    for (const pending of unsentPhotos) URL.revokeObjectURL(pending.photo.previewUrl);
    setUnsent([]);
    discardInspectionDraft(draftKey);
  };
  const saveUnsentPhoto = async (photo: CapturedPhoto) => {
    const result = await downloadBlobFile({
      fileName: photo.file.name || "inspection-photo.jpg",
      mimeType: photo.file.type || "image/jpeg",
      blob: photo.file,
      title: "Inspection photo",
    });
    setNotice(result === "failed" ? "" : "Photo saved to your device.");
    if (result === "failed") setError("Could not save the photo to your device.");
  };
  // The handoff removes the pending-photo thumbnail, so without a standing line the
  // freeze reads as the capture being thrown away. This stays put rather than using
  // the transient `notice`, which the next operation clears. It describes what
  // happened to the MATERIAL, because a reopened report is editable again while its
  // recovery bucket still holds work the server never saw.
  const hasUnsentMaterial = unsentNotes.length > 0 || unsentPhotos.length > 0;
  const unsentLead = editable
    ? "Earlier work on this device never reached the server, so it is not part of the report."
    : "You have read-only access to this report, so work on this device never reached the server.";
  const unsentRecoveryMessage = !hasUnsentMaterial
    ? ""
    : unsentPhotos.length > 0
      ? `${unsentLead} It is kept below under "Unsent notes and photos from this device" — save any photo to your device before discarding it.`
      : `${unsentLead} It is kept below under "Unsent notes and photos from this device".`;
  // Two different read-only reasons, and telling them apart matters: a resident who
  // submitted can get their side back by asking, while a co-manager on a read grant cannot.
  const readOnlyNotice = role === "resident" && submittedByResident
    ? "You submitted these photos. Ask your manager to reopen the report to add more."
    : "You have read-only access to this report.";
  const areaCount = (area: InspectionArea) => area.items.reduce((n, item) => n + item.manager.photos.length + item.resident.photos.length, 0);
  const backLabel = activeArea ? "Back to room sections" : "Back to inspections";
  const selectedAreas = roomAreas.filter(area => selected.has(area.id));
  return <div className="min-w-0 space-y-5" data-attr="inspection-editor">
    {/* The type, the date and the room say everything the old meta row and its paragraph of
        instructions said, in the place a person already reads. */}
    <PortalDetailHeader bare hideBackText title={activeArea?.label ?? report.resident_name} subtitle={`${report.kind === "move-in" ? "Move-in" : "Move-out"} · ${inspectionRoomLabel(report.room_label) || "Assigned room"} · ${report.property_label}`} avatarName={!activeArea ? report.resident_name : undefined} onBack={back} backLabel={backLabel} dataAttrBack="inspection-back" />
    {(busy || dirty || submittedByResident) && <p role="status" className="px-2 text-sm text-muted">{busy ? "Saving…" : dirty ? "Changes waiting to save" : role === "resident" ? "Submitted. Ask your manager to reopen this to add more." : `Resident submitted ${new Date(submission!.at).toLocaleDateString()}.`}</p>}
    {error && <p role="alert" className="rounded-xl border border-border p-3 text-sm">{error} {dirty ? "Your unsaved notes remain here." : ""}</p>}
    {notice && <p role="status" className="px-2 text-sm text-muted">{notice}</p>}
    {unsentRecoveryMessage && <p role="status" className="rounded-xl border border-border p-3 text-sm" data-attr="inspection-unsent-notice">{unsentRecoveryMessage}</p>}
    {pendingPhoto && <div className="flex items-center gap-4 rounded-xl border border-border p-3"><Image src={pendingPhoto.photo.previewUrl} unoptimized width={96} height={72} alt="Photo waiting to upload" className="ph-no-capture ph-no-record h-18 w-24 rounded-lg object-cover" /><p className="text-sm text-muted">{busy ? "Uploading photo…" : editable ? "This photo has not uploaded. Use Retry upload below." : "This photo has not uploaded and this report can no longer be edited."}</p></div>}
    {activeArea ? <div className="space-y-4 px-2">{activeArea.items.map(renderItem)}</div> : <div>
      {!editable && <p className="px-2 pb-4 text-sm text-muted">Open a section to read its photos and notes. {readOnlyNotice}</p>}
      {roomAreas.map(area => <div key={area.id} className={`flex min-h-24 items-center gap-3 border-b border-l-2 border-b-border px-3 py-5 ${selected.has(area.id) ? "border-l-primary bg-primary/5" : "border-l-transparent"}`} data-attr="inspection-section-row">
        {editable && <input type="checkbox" className="h-4 w-4 shrink-0 accent-primary" aria-label={`Select ${area.label}`} checked={selected.has(area.id)} onChange={e => setSelected(current => { const next = new Set(current); if (e.target.checked) next.add(area.id); else next.delete(area.id); return next; })} />}
        <button className="min-w-0 flex-1 text-left" onClick={() => setActiveAreaId(area.id)} data-attr="inspection-area-open"><span className="flex items-center gap-2 text-base font-semibold">{area.label}<ChevronRight className="h-4 w-4 text-muted" /></span><span className="mt-1 block text-sm text-muted">{areaCount(area) ? `${areaCount(area)} photo${areaCount(area) === 1 ? "" : "s"}` : "No photos yet"}</span></button>
        {/* The camera belongs on the section, not behind a section picker: this row IS the
            answer to "which section", so tapping it only leaves the source to choose. */}
        {editable && <Button variant="outline" className="shrink-0" disabled={busy} aria-label={`Add photos to ${area.label}`} onClick={() => startUpload(area.id)} data-attr="inspection-section-photo-add"><Camera className="h-4 w-4" /></Button>}
      </div>)}
      {selectedAreas.length > 0 && <PortalSectionActionRow variant="header">
        <Button disabled={busy} onClick={() => startUpload(selectedAreas.length === 1 ? selectedAreas[0]!.id : undefined)} data-attr="inspection-bulk-photo-add"><Camera className="h-4 w-4" />Add photos to {selectedAreas.length} section{selectedAreas.length === 1 ? "" : "s"}</Button>
        <Button variant="outline" disabled={busy || selectedAreas.length !== 1} onClick={() => setActiveAreaId(selectedAreas[0]!.id)} data-attr="inspection-bulk-open">Open</Button>
        <Button variant="ghost" disabled={busy} onClick={() => setSelected(new Set())} data-attr="inspection-bulk-clear">Clear</Button>
      </PortalSectionActionRow>}
    </div>}
    {hasUnsentMaterial && <PortalCollapsibleSection title="Unsent notes and photos from this device" defaultExpanded={unsentPhotos.length > 0}>
      <p className="pb-3 text-sm text-muted">These never reached the server, so they are <strong>not part of the report</strong> above.{editable ? " Reopening the report did not add them — retype anything you still want recorded." : ""} Keep anything you still need, then discard them.</p>
      {unsentNotes.map(entry => <div key={entry.itemId} className="space-y-1 border-t border-border py-3">
        <p className="text-sm font-semibold">{itemLabels.get(entry.itemId) ?? entry.itemId}</p>
        {entry.condition !== "unchecked" && <p className="text-xs text-muted">{INSPECTION_CONDITIONS[entry.condition]}</p>}
        {entry.notes.trim() && <p className="ph-no-capture ph-no-record whitespace-pre-wrap break-words text-sm">{entry.notes}</p>}
      </div>)}
      {unsentPhotos.map((pending, index) => <div key={`${pending.itemId}-${index}`} className="flex flex-wrap items-center gap-4 border-t border-border py-3">
        <Image src={pending.photo.previewUrl} unoptimized width={96} height={72} alt="Photo that was never uploaded" className="ph-no-capture ph-no-record h-18 w-24 rounded-lg object-cover" />
        <p className="min-w-0 flex-1 text-sm text-muted">This photo never uploaded and is not part of the report. Save it to your device if you still need it.</p>
        <Button variant="outline" onClick={() => saveUnsentPhoto(pending.photo)} data-attr="inspection-unsent-photo-save">Save photo to device</Button>
      </div>)}
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
      <Button variant="outline" aria-label="Download PDF" disabled={busy} onClick={() => run(async () => { await save(); await downloadInspection(role, report.id); })} data-attr="inspection-download"><FileText className="h-4 w-4" /><span className="hidden sm:inline">Download PDF</span></Button>
      {editable && !pendingPhoto && <Button disabled={busy} aria-label="Add photos" onClick={() => startUpload()} data-attr="inspection-photo-add"><Camera className="h-4 w-4" /><span>Add photos</span></Button>}
      {pendingPhoto && <>{editable && <Button variant="outline" disabled={busy} onClick={() => run(() => sendPhoto(pendingPhoto.itemId, pendingPhoto.photo))} data-attr="inspection-photo-retry">Retry upload</Button>}<Button variant="ghost" disabled={busy} onClick={() => { URL.revokeObjectURL(pendingPhoto.photo.previewUrl); setPendingPhoto(null); }} data-attr="inspection-photo-discard">Remove</Button></>}
      {error && dirty && editable && !pendingPhoto && <Button variant="outline" disabled={busy} onClick={() => run(async () => { await save(); })} data-attr="inspection-save-retry">Retry save</Button>}
      {error && <Button variant="ghost" disabled={busy} onClick={() => setConfirm("reload")} data-attr="inspection-conflict-review">Review latest</Button>}
      {role === "resident" && canEdit && !submittedByResident && !pendingPhoto && <Button disabled={busy || ownPhotoCount === 0} onClick={() => changeSubmission("submit")} data-attr="inspection-resident-submit">Submit photos</Button>}
      {role === "manager" && canEdit && submittedByResident && <Button disabled={busy} onClick={() => changeSubmission("reopen")} data-attr="inspection-resident-reopen">Allow changes</Button>}
    </PortalPageFooterActions>
    <Modal open={uploadSourceOpen} onClose={() => { if (!busy) setUploadSourceOpen(false); }} dismissBlocked={busy} title="Add photos" assistantStrip={false}>
      <div className="grid gap-2 sm:grid-cols-2">
        <Button variant="outline" className="h-auto min-h-12 justify-start px-4 py-3 text-left" disabled={busy} onClick={() => pickUploadSource("files")} data-attr="inspection-upload-files">Choose from files</Button>
        <Button variant="outline" className="h-auto min-h-12 justify-start px-4 py-3 text-left" disabled={busy} onClick={() => pickUploadSource("camera")} data-attr="inspection-upload-camera">Use camera</Button>
      </div>
    </Modal>
    <Modal open={choosePhoto} onClose={() => { if (!busy) { setChoosePhoto(false); setPhotoSource(null); } }} dismissBlocked={busy} title="Add photos to a section" assistantStrip={false}><div className="space-y-2">{(roomAreas.filter(area => area.id === uploadArea).length ? roomAreas.filter(area => area.id === uploadArea) : activeArea ? [activeArea] : selectedAreas.length ? selectedAreas : roomAreas).map(area => <div key={area.id}><h3 className="py-2 text-sm font-semibold">{area.label}</h3>{area.items.map(item => <Button key={item.id} variant="outline" className="mb-2 w-full justify-between" disabled={busy || !photoSource} onClick={() => photoSource && upload(item.id, photoSource)} data-attr="inspection-upload-section">{item.label}<Camera className="h-4 w-4" /></Button>)}</div>)}</div></Modal>
    <Modal open={confirm !== null} onClose={() => { if (!busy) setConfirm(null); }} dismissBlocked={busy} title={confirm === "leave" ? "Leave without saving?" : "Review the latest saved report?"} assistantStrip={false} footer={<Button disabled={busy} onClick={confirmAction} data-attr="inspection-confirm">{confirm === "leave" ? "Discard and leave" : "Review latest"}</Button>}>
      <p className="text-sm text-muted">{confirm === "leave" ? "Unsaved notes and pending uploads will be discarded. Saved photos and notes remain." : "Unsaved notes will be discarded. Your pending photo is kept — retry its upload once the latest report has loaded."}</p>
      {error && <p role="alert" className="mt-3 text-sm">{error}</p>}
    </Modal>
  </div>;
}
