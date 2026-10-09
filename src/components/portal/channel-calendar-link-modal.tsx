"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { AlertCircle, MoreHorizontal } from "lucide-react";
import { AddWorkspace, type AddWorkspaceStep } from "@/components/portal/add-workspace";
import { StepColumn, StepHeading } from "@/components/portal/listing-wizard-v2/wizard-primitives";
import { PortalDialog } from "@/components/portal/portal-dialog";
import { CopyIconAction, PortalIconAction } from "@/components/portal/portal-icon-action";
import { FieldSingleSelect } from "@/components/ui/checkbox-multi-select";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  deleteChannelCalendarConnection,
  fetchManagerChannelBookings,
  fetchRoomExportCalendarUrl,
  fetchWritableChannelCalendarPropertyIds,
  saveChannelCalendarConnection,
  syncAllChannelCalendarConnections,
  syncChannelCalendarConnection,
} from "@/lib/channel-calendar/client";
import type { ChannelCalendarProvider, ManagerChannelBookingRoom } from "@/lib/channel-calendar/types";
import { channelCalendarProviderLabel, isValidChannelImportUrl } from "@/lib/channel-calendar/airbnb-url";
import { isEntireHomeProperty } from "@/lib/rental-application/data";
import { relativeSyncTime } from "@/lib/channel-calendar/channel-row-fact";
import { buildAirbnbListingPack } from "@/lib/channel-calendar/listing-pack";
import { channelCalendarUnits, type ChannelCalendarUnit } from "@/lib/channel-calendar/property-units";
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
  /** The channel the opener already knows (the Integrations rows). Without it the page starts with a Channel dropdown. */
  initialProvider?: ChannelCalendarProvider;
  showToast: (message: string) => void;
  onChanged?: () => void;
  onClose: () => void;
};

/** The popup's title follows the channel picked in it. */
export function channelCalendarLinkTitle(provider: ChannelCalendarProvider | ""): string {
  return provider ? `Connect ${channelCalendarProviderLabel(provider)}` : "Connect a channel";
}

type LinkRow = {
  key: string;
  propertyId: string;
  unit: ChannelCalendarUnit;
  /** The row's own label: a room's name, or "Whole house" for an entire-home listing. */
  title: string;
};

type LinkGroup = { propertyId: string; label: string; rows: LinkRow[] };

const CHANNEL_OPTIONS = (["airbnb", "booking_com", "vrbo"] as const).map((value) => ({ value, label: channelCalendarProviderLabel(value) }));
const rowKey = (propertyId: string, roomId: string) => `${propertyId}::${roomId}`;

export function ChannelCalendarLinkFields({ active, propertyOptions: allPropertyOptions, initialProvider, showToast, onChanged, onClose, entries = [], onOpenBooking }: Props) {
  const [provider, setProvider] = useState<ChannelCalendarProvider | "">(initialProvider ?? "");
  const [connections, setConnections] = useState<Map<string, ManagerChannelBookingRoom>>(new Map());
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [copiedKeys, setCopiedKeys] = useState<Record<string, boolean>>({});
  const [exports, setExports] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [preview, setPreview] = useState<{ room: string; events: ReturnType<typeof parseIcsCalendar> } | null>(null);
  const [disconnect, setDisconnect] = useState<{ id: string; label: string } | null>(null);
  const channel: ChannelCalendarProvider = provider || "airbnb";
  const name = channelCalendarProviderLabel(channel);

  // Linking, unlinking and syncing need the Calendar module at edit, so the picker (and with it the "Entire
  // workspace" scope) lists only the properties the caller may write. The server re-checks every write.
  const [writableIds, setWritableIds] = useState<string[] | null>(null);
  const allOptionIdsKey = allPropertyOptions.map((p) => p.id).join(",");
  useEffect(() => {
    if (!active || !allOptionIdsKey) return;
    let stopped = false;
    fetchWritableChannelCalendarPropertyIds(allOptionIdsKey.split(","))
      .then((ids) => { if (!stopped) setWritableIds(ids); })
      .catch(() => { if (!stopped) setWritableIds(null); });
    return () => { stopped = true; };
  }, [active, allOptionIdsKey]);
  const writableOptions = useMemo(
    () => (writableIds ? allPropertyOptions.filter((p) => writableIds.includes(p.id)) : allPropertyOptions),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- allOptionIdsKey is allPropertyOptions' identity
    [writableIds, allOptionIdsKey],
  );

  // Connecting a channel always links the whole workspace (every property the caller may write).
  const scopeIds = useMemo(() => writableOptions.map((p) => p.id), [writableOptions]);
  const scopeKey = scopeIds.join("\n");
  // An entire-home listing has no rooms to list: the house itself is its one row (see channelCalendarUnits).
  const groups = useMemo<LinkGroup[]>(
    () =>
      scopeIds.map((propertyId) => {
        const label = writableOptions.find((p) => p.id === propertyId)?.label ?? propertyId;
        const entireHome = isEntireHomeProperty(propertyId);
        const rows = channelCalendarUnits(propertyId, label).map((unit) => ({ key: rowKey(propertyId, unit.id), propertyId, unit, title: entireHome ? "Whole house" : unit.name }));
        return { propertyId, label, rows };
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- scopeKey is scopeIds' identity
    [scopeKey, writableOptions],
  );
  const rows = useMemo(() => groups.flatMap((g) => g.rows), [groups]);

  useEffect(() => {
    if (!active) return;
    const ids = scopeKey ? scopeKey.split("\n") : [];
    if (!ids.length) { setConnections(new Map()); return; }
    let stopped = false;
    setLoading(true);
    setError("");
    fetchManagerChannelBookings(ids)
      .then((properties) => { if (!stopped) setConnections(connectionMap(properties, channel)); })
      .catch((e: unknown) => { if (!stopped) setError(e instanceof Error ? e.message : "Could not load calendars."); })
      .finally(() => { if (!stopped) setLoading(false); });
    return () => { stopped = true; };
  }, [active, scopeKey, channel]);

  const refresh = async () => {
    const ids = scopeKey ? scopeKey.split("\n") : [];
    setConnections(connectionMap(ids.length ? await fetchManagerChannelBookings(ids) : [], channel));
    onChanged?.();
  };
  const run = async (action: () => Promise<void>) => {
    setBusy(true); setError("");
    try { await action(); } catch (e) { setError(e instanceof Error ? e.message : "Calendar action failed."); }
    finally { setBusy(false); }
  };
  const exportFor = async (row: LinkRow) => {
    const key = `${row.key}:${channel}`;
    const url = exports[key] || connections.get(row.key)?.exportUrl || await fetchRoomExportCalendarUrl({ propertyId: row.propertyId, roomId: row.unit.id, roomLabel: row.unit.label, provider: channel });
    setExports((old) => ({ ...old, [key]: url }));
    return url;
  };
  const urlFor = (row: LinkRow) => exports[`${row.key}:${channel}`] || connections.get(row.key)?.exportUrl || "";
  const openPreview = async (row: LinkRow) => {
    const response = await fetch(await exportFor(row), { credentials: "omit", cache: "no-store" });
    if (!response.ok) throw new Error("Could not load feed preview.");
    const body = await response.text();
    if (!body.includes("BEGIN:VCALENDAR")) throw new Error("The export did not return a calendar feed.");
    setPreview({ room: row.unit.label, events: parseIcsCalendar(body) });
  };
  const copy = async (row: LinkRow) => { await navigator.clipboard.writeText(await exportFor(row)); setCopiedKeys((old) => ({ ...old, [`${row.key}:${channel}`]: true })); showToast("PropLane calendar link copied."); };
  const copyListingPack = async (row: LinkRow) => {
    const pack = buildAirbnbListingPack({ propertyId: row.propertyId, roomId: row.unit.id });
    await navigator.clipboard.writeText(pack.text);
    showToast(`Listing pack copied · ${pack.photoUrls.length} ${pack.photoUrls.length === 1 ? "photo" : "photos"} listed`);
  };
  const syncAll = () => run(async () => {
    try {
      const { synced, failed } = await syncAllChannelCalendarConnections(scopeKey ? scopeKey.split("\n") : []);
      showToast(failed ? `Synced ${synced} · ${failed} failed` : `Synced ${synced} ${synced === 1 ? "calendar" : "calendars"}.`);
    } finally { await refresh(); }
  });

  // The input shows the saved link until edited; only a value that differs from the saved one counts
  // as a change. Emptying a box that HAD a link is such a change — it unlinks the channel (the
  // PropLane export feed and its token stay, which is what ⋯ Disconnect would throw away).
  const savedOf = (row: LinkRow) => connections.get(row.key)?.importUrl?.trim() ?? "";
  const shownOf = (row: LinkRow) => drafts[row.key] ?? connections.get(row.key)?.importUrl ?? "";
  const changedOf = (row: LinkRow) => { const draft = drafts[row.key]; return draft !== undefined && draft.trim() !== savedOf(row); };
  const draftOf = (row: LinkRow) => changedOf(row) ? drafts[row.key]!.trim() : "";
  const clearedOf = (row: LinkRow) => changedOf(row) && !draftOf(row);
  const isBad = (row: LinkRow) => Boolean(draftOf(row)) && !isValidChannelImportUrl(channel, draftOf(row));
  const invalid = rows.some(isBad);
  const pending = rows.filter(changedOf);

  // Save upserts every row whose link changed, then syncs the ones that now have one. A row the
  // manager emptied is sent as `importUrl: null`, which clears the stored link and its imported stays.
  const save = () => run(async () => {
    const failures: string[] = [];
    for (const row of pending) {
      try {
        const connection = await saveChannelCalendarConnection({ propertyId: row.propertyId, roomId: row.unit.id, provider: channel, label: row.unit.label, importUrl: draftOf(row) || null });
        if (connection.hasImportUrl) await syncChannelCalendarConnection(connection.id);
      } catch (e) { failures.push(`${row.unit.label}: ${e instanceof Error ? e.message : "Save failed"}`); }
    }
    await refresh();
    setDrafts({});
    if (failures.length) setError(failures.join(" · "));
    else { showToast(pending.length > 0 && pending.every(clearedOf) ? "Calendar link removed." : "Calendars saved and synced."); }
  });

  const statusOf = (row: LinkRow) => clearedOf(row) ? "Link will be removed" : draftOf(row) ? (isBad(row) ? "Link not valid" : "Ready to connect") : connections.get(row.key)?.hasImportUrl ? "Connected" : "Not connected";
  const stepsDef: AddWorkspaceStep[] = [
    { id: "link", label: "Link", summary: loading ? undefined : `${rows.length} ${rows.length === 1 ? "calendar" : "calendars"}`, incomplete: invalid || !provider },
  ];
  const errorAlert = error ? <p role="alert" className="mb-4 text-sm text-danger">{error}</p> : null;
  const gridClass = "md:grid md:grid-cols-[minmax(0,0.8fr)_minmax(0,1.5fr)_minmax(0,1.3fr)_auto] md:items-start md:gap-3";

  const page = <StepColumn wide>
    <StepHeading title="Link" />
    {errorAlert}
    <div className="mb-5 space-y-4">
      {!initialProvider ? <FieldSingleSelect label="Channel" dataAttr="channel-calendar-link-provider" value={provider} placeholder="Pick a channel…" disabled={busy} options={CHANNEL_OPTIONS} onChange={(next) => { if (next !== provider) setDrafts({}); setProvider(next as ChannelCalendarProvider); }} /> : null}
    </div>
    {loading ? <p role="status">Loading linked rooms…</p> : rows.length === 0 ? <p>This workspace has no rooms listed.</p> : <div className="space-y-5" data-attr="channel-calendar-link-table">
      <div className={`hidden text-xs font-medium text-muted ${gridClass}`}><span>Room</span><span>{name} calendar link</span><span>PropLane link</span><span className="w-9" /></div>
      {groups.filter((g) => g.rows.length).map((group) => <section key={group.propertyId} aria-label={group.label} className="overflow-hidden rounded-2xl border border-border bg-card">
        <h3 className="border-b border-border px-4 py-2.5 text-sm font-semibold">{group.label}</h3>
        {group.rows.map((row) => {
          const connection = connections.get(row.key);
          const url = urlFor(row);
          const conflicts = conflictingChannelStays(entries, row.propertyId, row.unit.id, channel);
          const bad = isBad(row);
          return <div key={row.key} data-attr="channel-calendar-room-row" className={`space-y-2 border-b border-border px-4 py-3 last:border-0 ${gridClass}`}>
            <div className="text-sm font-medium md:pt-2.5">{row.title}
              {conflicts.length ? <Link className="mt-1 flex items-center gap-1.5 text-xs font-normal text-danger underline" href={bookingRecordHref("/portal", bookingEntryKey(conflicts[0]!))} onClick={onOpenBooking}><AlertCircle className="size-3.5" />{conflicts.length} {conflicts.length === 1 ? "conflict" : "conflicts"}</Link> : null}
            </div>
            <div className="space-y-1">
              <div className="flex items-center gap-2">
                <Input id={`channel-import-${row.key}`} type="url" aria-label={`${row.unit.label} ${name} calendar link`} aria-invalid={bad} value={shownOf(row)} disabled={busy} placeholder={`Paste ${name} calendar link`} onChange={(e) => setDrafts({ ...drafts, [row.key]: e.target.value })} data-attr="channel-calendar-link-import-url" />
                {shownOf(row).trim() ? <CopyIconAction label={`Copy ${name} calendar link`} disabled={busy} onCopy={async () => { await navigator.clipboard.writeText(shownOf(row).trim()); showToast(`${name} calendar link copied.`); }} /> : null}
              </div>
              {bad ? <p role="alert" className="text-sm text-danger">Enter a valid {name} calendar link.</p> : null}
              {connection?.lastError ? <p role="alert" className="text-sm text-danger">{connection.lastError}</p> : null}
            </div>
            <div className="flex items-center gap-2">
              <Input readOnly aria-label={`${row.unit.label} PropLane export link`} value={url} placeholder="Created when you copy it" data-attr="channel-calendar-export-url" />
              <CopyIconAction label="Copy PropLane calendar link" disabled={busy} onCopy={() => run(() => copy(row))} />
            </div>
            <div data-attr="channel-calendar-room-status" className="flex flex-wrap items-center gap-1.5 text-xs text-muted md:col-start-2 md:col-span-2">
              {connection?.lastError ? <Badge tone="danger">Feed failed · {connection.lastError}</Badge> : connection?.hasImportUrl ? <Badge tone="success">Linked</Badge> : <Badge>Paste {name} calendar link</Badge>}
              {copiedKeys[`${row.key}:${channel}`] || connection?.exportUrl ? <Badge tone="success">Copied</Badge> : <Badge>Not yet pasted into {name}</Badge>}
              <span>Last sync {connection?.lastSyncedAt ? relativeSyncTime(connection.lastSyncedAt) : "—"}</span>
            </div>
            <div className="flex md:justify-end">
              <DropdownMenu><DropdownMenuTrigger asChild><PortalIconAction icon={MoreHorizontal} label={`${row.unit.label} actions`} /></DropdownMenuTrigger><DropdownMenuContent align="end">
                <DropdownMenuItem disabled={busy || !connection?.hasImportUrl} onSelect={() => { void run(async () => { try { await syncChannelCalendarConnection(connection!.connectionId); } finally { await refresh(); } }); }}>Sync now</DropdownMenuItem>
                <DropdownMenuItem disabled={busy} onSelect={() => { void run(() => openPreview(row)); }}>Feed preview</DropdownMenuItem>
                {channel === "airbnb" ? <DropdownMenuItem disabled={busy} onSelect={() => { void run(() => copyListingPack(row)); }}>Copy Airbnb listing pack</DropdownMenuItem> : null}
                <DropdownMenuItem className="text-danger" disabled={!connection || busy} onSelect={() => setDisconnect({ id: connection!.connectionId, label: row.unit.label })}>Disconnect</DropdownMenuItem>
              </DropdownMenuContent></DropdownMenu>
            </div>
          </div>;
        })}
      </section>)}
    </div>}
  </StepColumn>;

  const previewPanel = <aside aria-label="What will be linked" data-attr="channel-calendar-link-preview" className="space-y-4">
    <h3 className="text-[15px] font-bold text-foreground">What will be linked</h3>
    <dl className="space-y-2 text-sm">
      <div className="flex justify-between gap-3"><dt className="text-muted">Channel</dt><dd className="text-right font-semibold">{provider ? name : "Not picked"}</dd></div>
      <div className="flex justify-between gap-3"><dt className="text-muted">Link</dt><dd className="text-right font-semibold">Entire workspace</dd></div>
    </dl>
    {provider ? <ul className="space-y-2">{rows.map((r) => <li key={r.key} className="rounded-xl border border-border bg-card p-3 text-sm"><p className="font-semibold">{groups.length > 1 ? `${writableOptions.find((p) => p.id === r.propertyId)?.label ?? ""} · ` : ""}{r.title}</p><p>{name} ⇄ PropLane calendar</p><p className="font-semibold">{statusOf(r)}</p></li>)}</ul> : null}
  </aside>;

  return <>
    <AddWorkspace
      title={channelCalendarLinkTitle(provider)}
      steps={stepsDef}
      current={0}
      onJump={() => {}}
      onClose={onClose}
      dirty={pending.length > 0}
      discardTitle="Discard these links?"
      discardBody="The calendar links you pasted have not been saved yet."
      assistantContext="Connect a booking channel calendar"
      assistantScopeKey="channel-calendar-link"
      dataAttrPrefix="channel-calendar-link"
      finishDataAttr="channel-calendar-link-save"
      lastLabel="Save"
      lastDisabled={loading || !provider || invalid || pending.length === 0}
      busy={busy}
      dangerAction={<Button variant="ghost" disabled={busy || loading || rows.length === 0} data-attr="channel-calendar-sync-all" onClick={() => void syncAll()}>Sync all now</Button>}
      hideFooterStepCount
      reviewEditLinks={false}
      saveState={busy ? "Saving…" : undefined}
      onFinish={() => void save()}
      sidePanel={previewPanel}
    >
      {page}
    </AddWorkspace>
    <PortalDialog open={Boolean(preview)} onClose={() => setPreview(null)} title={`Feed preview · ${preview?.room ?? ""}`} primaryAction={{ label: "Done", onClick: () => setPreview(null) }} secondaryAction={null}><div className="space-y-3">{preview?.events.length === 0 ? <p>No PropLane blocks in this feed.</p> : preview?.events.map((event) => <div key={event.uid} className="rounded-xl border border-border p-3"><p>Blocked by PropLane</p><p>{formatPortalListDate(event.startDate)} – {formatPortalListDate(event.endDate)}</p><code className="text-xs">DTSTART {event.startDate.replaceAll("-", "")} · DTEND {new Date(Date.parse(`${event.endDate}T00:00:00Z`) + 86400000).toISOString().slice(0, 10).replaceAll("-", "")}</code></div>)}</div></PortalDialog>
    <PortalDialog open={Boolean(disconnect)} onClose={() => setDisconnect(null)} title="Disconnect calendar?" primaryAction={{ label: "Disconnect", onClick: () => run(async () => { await deleteChannelCalendarConnection(disconnect!.id); setDisconnect(null); await refresh(); }), disabled: busy }} secondaryAction={{ label: "Keep connected", onClick: () => setDisconnect(null) }}><p>{disconnect?.label ?? "This room"} · Imported blocks will be removed and this feed link may stop working.</p></PortalDialog>
  </>;
}

/** One connection per (property, room) for the channel being linked, keyed like a table row. */
function connectionMap(properties: { propertyId: string; rooms: ManagerChannelBookingRoom[] }[], channel: ChannelCalendarProvider): Map<string, ManagerChannelBookingRoom> {
  const map = new Map<string, ManagerChannelBookingRoom>();
  for (const property of properties) for (const room of property.rooms) if (room.provider === channel) map.set(rowKey(property.propertyId, room.roomId), room);
  return map;
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
