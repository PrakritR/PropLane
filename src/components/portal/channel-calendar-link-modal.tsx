"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { CheckCircle, CircleDashed, AlertCircle, Eye, House, Building2, Palmtree, type LucideIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { FieldSingleSelect } from "@/components/ui/checkbox-multi-select";
import { AddWorkspace, type AddWorkspaceStep } from "@/components/portal/add-workspace";
import { StepColumn, StepHeading } from "@/components/portal/listing-wizard-v2/wizard-primitives";
import { PortalDialog } from "@/components/portal/portal-dialog";
import { CopyIconAction, PortalIconAction } from "@/components/portal/portal-icon-action";
import { RecordActionContext } from "@/components/ui/record-action-context";
import { RecordActionMenu } from "@/components/ui/record-action-menu";
import { deleteChannelCalendarConnection, fetchChannelCalendarConnections, fetchRoomExportCalendarUrl, saveChannelCalendarConnection, syncChannelCalendarConnection } from "@/lib/channel-calendar/client";
import type { ChannelCalendarConnectionPublic, ChannelCalendarProvider } from "@/lib/channel-calendar/types";
import { isValidChannelImportUrl, channelCalendarProviderLabel } from "@/lib/channel-calendar/airbnb-url";
import { isEntireHomeProperty } from "@/lib/rental-application/data";
import { channelCalendarUnits } from "@/lib/channel-calendar/property-units";
import type { ManagerPropertyFilterOption } from "@/lib/manager-portfolio-access";
import { parseIcsCalendar } from "@/lib/ical/parse";

import { useManagerBookingEntries } from "@/hooks/use-manager-booking-entries";
import { useManagerUserId } from "@/hooks/use-manager-user-id";
import type { PropertyBookingEntry } from "@/lib/channel-calendar/property-bookings";
import { conflictingChannelStays } from "@/lib/channel-calendar/channel-conflicts";
import { bookingEntryKey } from "@/lib/channel-calendar/bookings-ui";
import { formatPortalListDate } from "@/lib/portal-display-dates";
import { bookingRecordHref } from "@/lib/portal-detail-routes";

type Props = {
  entries?: readonly PropertyBookingEntry[];
  onOpenBooking?: () => void;
  active: boolean;
  propertyIds: string[];
  propertyOptions: ManagerPropertyFilterOption[];
  initialPropertyId?: string;
  /** The channel the opener already knows (the Integrations rows). Without it the wizard starts on a channel chooser. */
  initialProvider?: ChannelCalendarProvider;
  showToast: (message: string) => void;
  onChanged?: () => void;
  onClose: () => void;
};

/** The popup's title follows the channel picked in it. */
export function channelCalendarLinkTitle(provider: ChannelCalendarProvider | ""): string {
  return provider ? `Connect ${channelCalendarProviderLabel(provider)}` : "Connect a channel";
}

const CHANNEL_CHOICES: readonly { provider: ChannelCalendarProvider; icon: LucideIcon; tone: string }[] = [
  { provider: "airbnb", icon: House, tone: "text-rose-500" },
  { provider: "booking_com", icon: Building2, tone: "text-blue-600" },
  { provider: "vrbo", icon: Palmtree, tone: "text-indigo-600" },
];
const CHOICE_CLASS =
  "group flex min-h-[112px] flex-col items-start justify-between gap-4 rounded-2xl border border-border bg-card p-4 text-left shadow-sm transition-[transform,box-shadow,border-color] duration-(--motion-base) ease-(--motion-crossfade) hover:-translate-y-0.5 hover:border-primary/40 hover:shadow-md active:translate-y-0 motion-reduce:transition-none";

export function ChannelCalendarLinkFields({ active, propertyOptions, initialPropertyId, initialProvider, showToast, onChanged, onClose, entries = [], onOpenBooking }: Props) {
  const [propertyId, setPropertyId] = useState(initialPropertyId ?? propertyOptions[0]?.id ?? "");
  const [provider, setProvider] = useState<ChannelCalendarProvider | "">(initialProvider ?? "");
  const needsChannel = !initialProvider;
  const stepIds = useMemo(() => (needsChannel ? ["channel", "house", "rooms", "review"] : ["house", "rooms", "review"]) as readonly string[], [needsChannel]);
  const [step, setStep] = useState(0);
  const stepId = stepIds[step];
  const [connections, setConnections] = useState<ChannelCalendarConnectionPublic[]>([]);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [exports, setExports] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [preview, setPreview] = useState<{ room: string; events: ReturnType<typeof parseIcsCalendar> } | null>(null);
  const [disconnect, setDisconnect] = useState<ChannelCalendarConnectionPublic | null>(null);
  const houseLabel = propertyOptions.find((p) => p.id === propertyId)?.label ?? "";
  // An entire-home listing has no rooms to pick: the house itself is the one unit (see channelCalendarUnits).
  const entireHome = useMemo(() => Boolean(propertyId) && isEntireHomeProperty(propertyId), [propertyId]);
  const rooms = useMemo(() => channelCalendarUnits(propertyId, houseLabel), [propertyId, houseLabel]);
  const channel: ChannelCalendarProvider = provider || "airbnb";
  const name = channelCalendarProviderLabel(channel);
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
    const key = `${id}:${channel}`;
    const url = exports[key] || connections.find((c) => c.roomId === id && c.provider === channel)?.exportUrl || await fetchRoomExportCalendarUrl({ propertyId, roomId: id, roomLabel: label, provider: channel });
    setExports((old) => ({ ...old, [key]: url }));
    return url;
  };
  const openPreview = async (id: string, label: string) => {
    const response = await fetch(await exportFor(id, label), { credentials: "omit", cache: "no-store" });
    if (!response.ok) throw new Error("Could not load feed preview.");
    const body = await response.text();
    if (!body.includes("BEGIN:VCALENDAR")) throw new Error("The export did not return a calendar feed.");
    setPreview({ room: label, events: parseIcsCalendar(body) });
  };
  const copy = async (id: string, label: string) => { await navigator.clipboard.writeText(await exportFor(id, label)); showToast("PropLane calendar link copied."); };
  const invalid = rooms.some((room) => Boolean(drafts[room.id!]?.trim()) && !isValidChannelImportUrl(channel, drafts[room.id!]!.trim()));
  const pending = rooms.filter((r) => drafts[r.id!]?.trim());
  const save = () => run(async () => {
    const failures: string[] = [];
    for (const room of rooms) {
      const id = room.id!;
      const draft = drafts[id]?.trim();
      let connection = connections.find((c) => c.roomId === id && c.provider === channel);
      if (draft) connection = await saveChannelCalendarConnection({ propertyId, roomId: id, provider: channel, label: room.label, importUrl: draft });
      if (connection?.hasImportUrl) {
        try { await syncChannelCalendarConnection(connection.id); }
        catch (e) { failures.push(`${room.label}: ${e instanceof Error ? e.message : "Sync failed"}`); }
      }
    }
    await refresh();
    setDrafts({});
    if (failures.length) { setError(failures.join(" · ")); setStep(stepIds.indexOf("rooms")); }
    else showToast("Calendars saved and synced.");
  });
  const statusOf = (id: string) => drafts[id]?.trim() ? (isValidChannelImportUrl(channel, drafts[id]!.trim()) ? "Ready to connect" : "Link not valid") : connections.some((c) => c.roomId === id && c.provider === channel && c.hasImportUrl) ? "Connected" : "Not connected";
  const unitWord = entireHome ? "Whole house" : "Rooms";
  const stepsDef: AddWorkspaceStep[] = [
    ...(needsChannel ? [{ id: "channel", label: "Channel", summary: provider ? name : "Pick a channel", incomplete: !provider }] : []),
    { id: "house", label: "House", summary: houseLabel || "Pick a house", incomplete: !propertyId },
    { id: "rooms", label: unitWord, summary: loading ? undefined : entireHome ? "The whole house" : `${rooms.length} ${rooms.length === 1 ? "room" : "rooms"}`, incomplete: invalid || ((stepId === "rooms" || stepId === "review") && rooms.length === 0) },
    { id: "review", label: "Review", summary: pending.length ? `${pending.length} to connect` : undefined },
  ];
  const errorAlert = error ? <p role="alert" className="mb-4 text-sm text-danger">{error}</p> : null;
  const channelStep = <StepColumn>
    <StepHeading title="Channel" />
    {errorAlert}
    <div className="grid gap-3 sm:grid-cols-3" data-attr="channel-calendar-link-channels">
      {CHANNEL_CHOICES.map(({ provider: choice, icon: Icon, tone }) => <button key={choice} type="button" className={CHOICE_CLASS} aria-pressed={provider === choice} data-selected={provider === choice} data-attr={`channel-calendar-link-choose-${choice}`} onClick={() => { if (choice !== provider) setDrafts({}); setProvider(choice); setStep(stepIds.indexOf("house")); }}>
        <span className="grid size-10 place-items-center rounded-xl bg-accent transition-transform duration-(--motion-base) ease-(--motion-nudge) group-hover:scale-105"><Icon className={`size-5 ${tone}`} /></span>
        <span className="text-[15px] font-semibold text-foreground">{channelCalendarProviderLabel(choice)}</span>
      </button>)}
    </div>
  </StepColumn>;
  const houseStep = <StepColumn>
    <StepHeading title="House" />
    {errorAlert}
    <div className="space-y-4">
      <div data-wizard-required="true" data-wizard-field="channel-calendar-house" data-wizard-label="House" data-wizard-empty={!propertyId}>
        <FieldSingleSelect label="House" placeholder="Select a house…" dataAttr="channel-calendar-link-property" value={propertyId} disabled={busy} options={propertyOptions.map((p) => ({ value: p.id, label: p.label }))} onChange={(next) => setPropertyId(next)} />
      </div>
    </div>
  </StepColumn>;
  const roomsStep = <StepColumn wide>
    <StepHeading title={unitWord} />
    {errorAlert}
    {loading ? <p role="status">Loading linked rooms…</p> : rooms.length === 0 ? <div className="space-y-3"><p>This house has no rooms listed.</p><Button variant="ghost" data-attr="channel-calendar-no-rooms-back" onClick={() => setStep(stepIds.indexOf("house"))}>Choose another house</Button></div> : <div className="space-y-5">{rooms.map((room) => {
          const id = room.id!;
          const connection = connections.find((c) => c.roomId === id && c.provider === channel);
          const StatusIcon = connection?.lastError ? AlertCircle : connection?.lastSyncedAt ? CheckCircle : CircleDashed;
          const url = exports[`${id}:${channel}`] || connection?.exportUrl;
          const generate = () => run(async () => { await exportFor(id, room.label); setConnections(await fetchChannelCalendarConnections(propertyId)); });
          const conflicts = conflictingChannelStays(entries, propertyId, id, channel);
          const bad = Boolean(drafts[id]?.trim()) && !isValidChannelImportUrl(channel, drafts[id]!.trim());
          return <RecordActionContext.Provider key={id} value={{ scope: id, clear: () => {}, actions: <>
            <Button disabled={busy || !connection?.hasImportUrl} data-record-action-id="sync" onClick={() => run(async () => { try { await syncChannelCalendarConnection(connection!.id); } finally { await refresh(); } })}>Sync now</Button>
            <Button data-record-action-id="edit" onClick={() => document.getElementById(`channel-import-${id}`)?.focus()}>Edit link</Button>
            <Button disabled={busy} data-record-action-id="preview" onClick={() => run(() => openPreview(id, room.label))}>Feed preview</Button>
            <Button disabled={busy} data-record-action-id="copy" onClick={() => run(() => copy(id, room.label))}>Copy PropLane link</Button>
            <Button variant="danger" disabled={!connection || busy} data-record-action-id="delete" onClick={() => setDisconnect(connection ?? null)}>Disconnect</Button>
          </> }}><section className="rounded-2xl border border-border bg-card p-5" data-attr="channel-calendar-room-card">
            <div className="mb-4 flex items-center justify-between"><h3 className="font-semibold">{room.label}</h3><RecordActionMenu label={room.label} activate={() => {}} /></div>
            {conflicts.length ? <Link className="mb-3 flex items-center gap-2 text-sm text-danger underline" href={bookingRecordHref("/portal", bookingEntryKey(conflicts[0]!))} onClick={onOpenBooking}><AlertCircle className="size-4" />{conflicts.length} {conflicts.length === 1 ? "conflict" : "conflicts"}</Link> : null}
            <div className="grid gap-6 md:grid-cols-2">
              <div className="space-y-3"><h4 className="text-sm font-medium">{name} → PropLane</h4><div className="flex items-center gap-2 text-sm"><StatusIcon className="size-4" />{connection?.lastError ? "Sync failed" : connection?.lastSyncedAt ? "Connected" : "Not connected"}</div>
                {connection?.lastSyncedAt ? <div className="text-sm">{new Date(connection.lastSyncedAt).toLocaleString()} · {connection.importedRangeCount} stays</div> : null}
                {connection?.lastError ? <p role="alert" className="text-sm text-danger">{connection.lastError}</p> : null}
                <Input id={`channel-import-${id}`} type="url" aria-label={`${room.label} ${name} calendar link`} aria-invalid={bad} value={drafts[id] ?? ""} disabled={busy} placeholder={connection?.hasImportUrl ? "Paste a replacement calendar link" : `Paste ${name} calendar link`} onChange={(e) => setDrafts({ ...drafts, [id]: e.target.value })} data-attr="channel-calendar-link-import-url" />
                {bad ? <p role="alert" className="text-sm text-danger">Enter a valid {name} calendar link.</p> : null}
              </div>
              <div className="space-y-3"><h4 className="text-sm font-medium">PropLane → {name}</h4><div className="flex items-center gap-2 text-sm">{url ? <CheckCircle className="size-4" /> : <CircleDashed className="size-4" />}{url ? "Link ready" : "Not set up"}</div>{url ? <div className="flex items-center gap-2"><Input readOnly aria-label={`${room.label} PropLane export link`} value={url} /><CopyIconAction label="Copy PropLane calendar link" disabled={busy} onCopy={() => run(() => copy(id, room.label))} /><PortalIconAction label="Feed preview" icon={Eye} disabled={busy} onClick={() => run(() => openPreview(id, room.label))} /></div> : <Button variant="secondary" disabled={busy} data-attr="channel-calendar-generate-link" aria-label={`Generate ${room.label} PropLane export link`} onClick={generate}>Generate link</Button>}
              </div>
            </div>
          </section></RecordActionContext.Provider>;
        })}</div>}
  </StepColumn>;
  const reviewStep = <StepColumn>
    <StepHeading title="Review" />
    {errorAlert}
    {rooms.length === 0 ? <p>Nothing to connect yet.</p> : <section className="space-y-1">{rooms.map((r) => <div key={r.id} className="flex justify-between gap-3 border-b border-border py-3"><span>{r.label}</span><span>{statusOf(r.id!) === "Connected" ? "Connected · sync now" : statusOf(r.id!)}</span></div>)}<p className="pt-3 text-sm font-semibold">{pending.length} new or updated {pending.length === 1 ? "link" : "links"}</p></section>}
  </StepColumn>;
  const previewPanel = <aside aria-label="What will be linked" data-attr="channel-calendar-link-preview" className="space-y-4">
    <h3 className="text-[15px] font-bold text-foreground">What will be linked</h3>
    <dl className="space-y-2 text-sm">
      <div className="flex justify-between gap-3"><dt className="text-muted">House</dt><dd className="text-right font-semibold">{houseLabel || "Not picked"}</dd></div>
      <div className="flex justify-between gap-3"><dt className="text-muted">Channel</dt><dd className="text-right font-semibold">{provider ? name : "Not picked"}</dd></div>
    </dl>
    {provider ? <ul className="space-y-2">{rooms.map((r) => <li key={r.id} className="rounded-xl border border-border bg-card p-3 text-sm"><p className="font-semibold">{r.label}</p><p>{name} ⇄ PropLane calendar</p><p className="font-semibold">{statusOf(r.id!)}</p></li>)}</ul> : null}
  </aside>;
  return <>
    <AddWorkspace
      title={channelCalendarLinkTitle(provider)}
      steps={stepsDef}
      current={step}
      onJump={setStep}
      onClose={onClose}
      dirty={pending.length > 0}
      discardTitle="Discard these links?"
      discardBody="The calendar links you pasted have not been saved yet."
      assistantContext="Connect a booking channel calendar"
      assistantScopeKey="channel-calendar-link"
      dataAttrPrefix="channel-calendar-link"
      finishDataAttr="channel-calendar-link-save"
      lastLabel="Connect"
      lastDisabled={loading || !provider || !propertyId || invalid || rooms.length === 0}
      nextDisabled={stepId === "channel" ? !provider : stepId === "house" ? loading || !propertyId : invalid || rooms.length === 0}
      busy={busy}
      numberedSteps
      hideFooterStepCount
      reviewEditLinks={false}
      saveState={busy ? "Saving…" : undefined}
      onFinish={() => void save()}
      sidePanel={previewPanel}
    >
      <div className="motion-wiz-dir-fwd" key={step}>{stepId === "channel" ? channelStep : stepId === "house" ? houseStep : stepId === "rooms" ? roomsStep : reviewStep}</div>
    </AddWorkspace>
    <PortalDialog open={Boolean(preview)} onClose={() => setPreview(null)} title={`Feed preview · ${preview?.room ?? ""}`} primaryAction={{ label: "Done", onClick: () => setPreview(null) }} secondaryAction={null}><div className="space-y-3">{preview?.events.length === 0 ? <p>No PropLane blocks in this feed.</p> : preview?.events.map((event) => <div key={event.uid} className="rounded-xl border border-border p-3"><p>Blocked by PropLane</p><p>{formatPortalListDate(event.startDate)} – {formatPortalListDate(event.endDate)}</p><code className="text-xs">DTSTART {event.startDate.replaceAll("-", "")} · DTEND {new Date(Date.parse(`${event.endDate}T00:00:00Z`) + 86400000).toISOString().slice(0, 10).replaceAll("-", "")}</code></div>)}</div></PortalDialog>
    <PortalDialog open={Boolean(disconnect)} onClose={() => setDisconnect(null)} title="Disconnect calendar?" primaryAction={{ label: "Disconnect", onClick: () => run(async () => { await deleteChannelCalendarConnection(disconnect!.id); setDisconnect(null); await refresh(); }), disabled: busy }} secondaryAction={{ label: "Keep connected", onClick: () => setDisconnect(null) }}><p>{disconnect?.label ?? "This room"} · Imported blocks will be removed and this feed link may stop working.</p></PortalDialog>
  </>;
}

function ConnectedChannelCalendarFields(props: Props) {
  const { userId } = useManagerUserId();
  const idsKey = props.propertyIds.join("\n");
  const ids = useMemo(() => idsKey ? idsKey.split("\n") : [], [idsKey]);
  const [refreshSignal, setRefreshSignal] = useState(0);
  const { entries } = useManagerBookingEntries({ userId, propertyIds: ids, propertyOptions: props.propertyOptions, propertyTick: 0, refreshSignal, showToast: props.showToast });
  return <ChannelCalendarLinkFields {...props} entries={entries} onChanged={() => { setRefreshSignal((value) => value + 1); props.onChanged?.(); }} />;
}

export function ChannelCalendarLinkModal({ open, onClose, ...props }: Omit<Props, "active" | "onClose"> & { open: boolean; onClose: () => void }) {
  if (!open) return null;
  return <div data-attr="channel-calendar-link-modal">{props.entries ? <ChannelCalendarLinkFields active {...props} onClose={onClose} onOpenBooking={onClose} /> : <ConnectedChannelCalendarFields active {...props} onClose={onClose} onOpenBooking={onClose} />}</div>;
}
