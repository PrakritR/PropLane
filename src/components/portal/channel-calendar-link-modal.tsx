"use client";

import { useEffect, useMemo, useState } from "react";
import { CheckCircle, CircleDashed, AlertCircle, Eye } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input, Select } from "@/components/ui/input";
import { Modal } from "@/components/ui/modal";
import { WizardShell } from "@/components/ui/wizard-shell";
import { PortalDialog } from "@/components/portal/portal-dialog";
import { CopyIconAction, PortalIconAction } from "@/components/portal/portal-icon-action";
import { RecordActionContext } from "@/components/ui/record-action-context";
import { RecordActionMenu } from "@/components/ui/record-action-menu";
import { deleteChannelCalendarConnection, fetchChannelCalendarConnections, fetchRoomExportCalendarUrl, saveChannelCalendarConnection, syncChannelCalendarConnection } from "@/lib/channel-calendar/client";
import type { ChannelCalendarConnectionPublic, ChannelCalendarProvider } from "@/lib/channel-calendar/types";
import { isValidChannelImportUrl, channelCalendarProviderLabel } from "@/lib/channel-calendar/airbnb-url";
import { getRoomOptionsForProperty, parseRoomChoiceValue } from "@/lib/rental-application/data";
import type { ManagerPropertyFilterOption } from "@/lib/manager-portfolio-access";
import { parseIcsCalendar } from "@/lib/ical/parse";

type Props = {
  active: boolean;
  propertyIds: string[];
  propertyOptions: ManagerPropertyFilterOption[];
  initialPropertyId?: string;
  showToast: (message: string) => void;
  onChanged?: () => void;
};

export function ChannelCalendarLinkFields({ active, propertyOptions, initialPropertyId, showToast, onChanged }: Props) {
  const [propertyId, setPropertyId] = useState(initialPropertyId ?? propertyOptions[0]?.id ?? "");
  const [provider, setProvider] = useState<ChannelCalendarProvider>("airbnb");
  const [step, setStep] = useState(0);
  const [connections, setConnections] = useState<ChannelCalendarConnectionPublic[]>([]);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [exports, setExports] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [preview, setPreview] = useState<{ room: string; events: ReturnType<typeof parseIcsCalendar> } | null>(null);
  const [disconnect, setDisconnect] = useState<ChannelCalendarConnectionPublic | null>(null);
  const rooms = useMemo(() => getRoomOptionsForProperty(propertyId, { includeUnavailable: true }).map((r) => ({ id: parseRoomChoiceValue(r.value).listingRoomId, label: r.label })).filter((r) => r.id), [propertyId]);
  const name = channelCalendarProviderLabel(provider);
  useEffect(() => {
    if (!active || !propertyId) return;
    let stopped = false;
    setLoading(true);
    setError("");
    setConnections([]);
    setExports({});
    setDrafts({});
    fetchChannelCalendarConnections(propertyId).then((rows) => { if (!stopped) setConnections(rows); }).catch((e: unknown) => { if (!stopped) setError(e instanceof Error ? e.message : "Could not load calendars."); }).finally(() => { if (!stopped) setLoading(false); });
    return () => { stopped = true; };
  }, [active, propertyId]);
  const refresh = async () => { setConnections(await fetchChannelCalendarConnections(propertyId)); onChanged?.(); };
  const run = async (action: () => Promise<void>) => {
    setBusy(true); setError("");
    try { await action(); } catch (e) { setError(e instanceof Error ? e.message : "Calendar action failed."); }
    finally { setBusy(false); }
  };
  const exportFor = async (id: string, label: string) => {
    const url = exports[id] || connections.find((c) => c.roomId === id)?.exportUrl || await fetchRoomExportCalendarUrl({ propertyId, roomId: id, roomLabel: label });
    setExports((old) => ({ ...old, [id]: url }));
    return url;
  };
  const openPreview = async (id: string, label: string) => {
    const response = await fetch(await exportFor(id, label), { credentials: "omit", cache: "no-store" });
    if (!response.ok) throw new Error("Could not load feed preview.");
    setPreview({ room: label, events: parseIcsCalendar(await response.text()) });
  };
  const copy = async (id: string, label: string) => { await navigator.clipboard.writeText(await exportFor(id, label)); showToast("PropLane calendar link copied."); };
  const invalid = rooms.some((room) => Boolean(drafts[room.id!]?.trim()) && !isValidChannelImportUrl(provider, drafts[room.id!]!.trim()));
  const pending = rooms.filter((r) => drafts[r.id!]?.trim());
  const save = () => run(async () => {
    const failures: string[] = [];
    for (const room of rooms) {
      const id = room.id!;
      const draft = drafts[id]?.trim();
      let connection = connections.find((c) => c.roomId === id && c.provider === provider);
      if (draft) connection = await saveChannelCalendarConnection({ propertyId, roomId: id, provider, label: room.label, importUrl: draft });
      if (connection?.hasImportUrl) {
        try { await syncChannelCalendarConnection(connection.id); }
        catch (e) { failures.push(`${room.label}: ${e instanceof Error ? e.message : "Sync failed"}`); }
      }
    }
    await refresh();
    setDrafts({});
    if (failures.length) { setError(failures.join(" · ")); setStep(1); }
    else showToast("Calendars saved and synced.");
  });
  return <>
    <WizardShell steps={[{ id: "house", label: "House" }, { id: "rooms", label: "Rooms" }, { id: "review", label: "Review" }]} currentStepIndex={step} footer={<div className="flex gap-2"><Button variant="ghost" disabled={busy || step === 0} onClick={() => setStep(step - 1)}>Back</Button><Button disabled={busy || loading || !propertyId || invalid || rooms.length === 0} onClick={step === 2 ? save : () => setStep(step + 1)}>{step === 2 ? "Save & sync" : "Continue"}</Button></div>}>
      <div className="mx-auto w-full max-w-4xl space-y-5">
        {error ? <p role="alert" className="text-sm text-danger">{error}</p> : null}
        {step === 0 ? <>
          <label className="block space-y-2"><span>House</span><Select aria-label="House" data-attr="channel-calendar-link-property" value={propertyId} disabled={busy} onChange={(e) => setPropertyId(e.target.value)}><option value="">Select a house…</option>{propertyOptions.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}</Select></label>
          <label className="block space-y-2"><span>Channel</span><Select aria-label="Channel" data-attr="channel-calendar-link-provider" value={provider} onChange={(e) => { setProvider(e.target.value as ChannelCalendarProvider); setDrafts({}); }}><option value="airbnb">Airbnb</option><option value="booking_com">Booking.com</option></Select></label>
        </> : null}
        {loading ? <p role="status">Loading linked rooms…</p> : rooms.length === 0 ? <p>No rooms on this listing.</p> : step === 1 ? rooms.map((room) => {
          const id = room.id!;
          const connection = connections.find((c) => c.roomId === id && c.provider === provider);
          const StatusIcon = connection?.lastError ? AlertCircle : connection?.lastSyncedAt ? CheckCircle : CircleDashed;
          const url = exports[id] || connections.find((c) => c.roomId === id)?.exportUrl;
          const bad = Boolean(drafts[id]?.trim()) && !isValidChannelImportUrl(provider, drafts[id]!.trim());
          return <RecordActionContext.Provider key={id} value={{ scope: id, clear: () => {}, actions: <>
            <Button disabled={busy || !connection?.hasImportUrl} data-record-action-id="sync" onClick={() => run(async () => { try { await syncChannelCalendarConnection(connection!.id); } finally { await refresh(); } })}>Sync now</Button>
            <Button data-record-action-id="edit" onClick={() => document.getElementById(`channel-import-${id}`)?.focus()}>Edit link</Button>
            <Button data-record-action-id="preview" onClick={() => run(() => openPreview(id, room.label))}>Feed preview</Button>
            <Button data-record-action-id="copy" onClick={() => run(() => copy(id, room.label))}>Copy PropLane link</Button>
            <Button variant="danger" disabled={!connection || busy} data-record-action-id="delete" onClick={() => setDisconnect(connection ?? null)}>Disconnect</Button>
          </> }}><section className="rounded-2xl border border-border bg-card p-5" data-attr="channel-calendar-room-card">
            <div className="mb-4 flex items-center justify-between"><h3 className="font-semibold">{room.label}</h3><RecordActionMenu label={room.label} activate={() => {}} /></div>
            <div className="grid gap-6 md:grid-cols-2">
              <div className="space-y-3"><h4 className="text-sm font-medium">{name} → PropLane</h4><div className="flex items-center gap-2 text-sm"><StatusIcon className="size-4" />{connection?.lastError ? "Sync failed" : connection?.lastSyncedAt ? "Connected" : "Not connected"}</div>
                {connection?.lastSyncedAt ? <div className="text-sm">{new Date(connection.lastSyncedAt).toLocaleString()} · {connection.importedRangeCount} stays</div> : null}
                {connection?.lastError ? <p role="alert" className="text-sm text-danger">{connection.lastError}</p> : null}
                <Input id={`channel-import-${id}`} type="url" aria-label={`${room.label} ${name} calendar link`} aria-invalid={bad} value={drafts[id] ?? ""} disabled={busy} placeholder={connection?.hasImportUrl ? "Paste a replacement calendar link" : `Paste ${name} calendar link`} onChange={(e) => setDrafts({ ...drafts, [id]: e.target.value })} data-attr="channel-calendar-link-import-url" />
                {bad ? <p role="alert" className="text-sm text-danger">Enter a valid {name} calendar link.</p> : null}
              </div>
              <div className="space-y-3"><h4 className="text-sm font-medium">PropLane → {name}</h4><div className="flex items-center gap-2 text-sm"><CircleDashed className="size-4" />{url ? "Feed ready" : "Not set up"}</div><div className="flex items-center gap-2"><Input readOnly aria-label={`${room.label} PropLane export link`} value={url ?? ""} placeholder="Copy to create the export link" /><CopyIconAction label="Copy PropLane calendar link" onCopy={() => run(() => copy(id, room.label))} /><PortalIconAction label="Feed preview" icon={Eye} disabled={busy} onClick={() => run(() => openPreview(id, room.label))} /></div>
                <ol className="list-decimal space-y-1 pl-5 text-sm"><li>Copy the PropLane link.</li><li>In {name}, open Import calendar and paste it.</li></ol>
              </div>
            </div>
          </section></RecordActionContext.Provider>;
        }) : step === 2 ? <section className="space-y-4"><h3 className="font-semibold">Review connections</h3>{rooms.map((r) => <div key={r.id} className="flex justify-between border-b border-border py-3"><span>{r.label}</span><span>{drafts[r.id!]?.trim() ? "Ready to connect" : connections.some((c) => c.roomId === r.id && c.provider === provider && c.hasImportUrl) ? "Connected · sync now" : "Not connected"}</span></div>)}<p className="text-sm">{pending.length} new or updated links. Export feeds must be added in {name}; its import schedule controls when blocks appear there.</p></section> : null}
      </div>
    </WizardShell>
    <PortalDialog open={Boolean(preview)} onClose={() => setPreview(null)} title={`Feed preview · ${preview?.room ?? ""}`} primaryAction={{ label: "Done", onClick: () => setPreview(null) }} secondaryAction={null}><div className="space-y-3">{preview?.events.length === 0 ? <p>No PropLane blocks in this feed.</p> : preview?.events.map((event) => <div key={event.uid} className="rounded-xl border border-border p-3"><p>Blocked by PropLane</p><p>{event.startDate} – {event.endDate}</p><code className="text-xs">DTSTART {event.startDate.replaceAll("-", "")} · DTEND {new Date(Date.parse(`${event.endDate}T00:00:00Z`) + 86400000).toISOString().slice(0, 10).replaceAll("-", "")}</code></div>)}</div></PortalDialog>
    <PortalDialog open={Boolean(disconnect)} onClose={() => setDisconnect(null)} title="Disconnect calendar?" primaryAction={{ label: "Disconnect", onClick: () => run(async () => { await deleteChannelCalendarConnection(disconnect!.id); setDisconnect(null); await refresh(); }), disabled: busy }} secondaryAction={{ label: "Keep connected", onClick: () => setDisconnect(null) }}><p>{disconnect?.label ?? "This room"} · Imported blocks will be removed and this feed link may stop working.</p></PortalDialog>
  </>;
}

export function ChannelCalendarLinkModal({ open, onClose, ...props }: Omit<Props, "active"> & { open: boolean; onClose: () => void }) {
  return <Modal open={open} onClose={onClose} fullPage scrollableContent={false} dismissBlocked={false} title="Connect Airbnb"><div className="flex h-full min-h-0 flex-col" data-attr="channel-calendar-link-modal">{open ? <ChannelCalendarLinkFields active={open} {...props} /> : null}</div></Modal>;
}
