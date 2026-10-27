"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { AlertCircle, Check, ClipboardCopy, ClipboardPaste, MoreHorizontal, RotateCw } from "lucide-react";
import { AddWorkspace, type AddWorkspaceStep } from "@/components/portal/add-workspace";
import { StepColumn, StepHeading } from "@/components/portal/listing-wizard-v2/wizard-primitives";
import { PortalDialog } from "@/components/portal/portal-dialog";
import { CopyIconAction, PortalIconAction } from "@/components/portal/portal-icon-action";
import { FieldSingleSelect } from "@/components/ui/checkbox-multi-select";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";
import { POPUP_FIELD_LABEL_CLASS } from "@/components/portal/popup-phone-styles";
import { Input, Textarea } from "@/components/ui/input";
import {
  deleteChannelCalendarConnection,
  fetchManagerChannelBookings,
  fetchRoomExportCalendarUrl,
  fetchWritableChannelCalendarPropertyIds,
  saveChannelCalendarConnectionsBatch,
  syncAllChannelCalendarConnections,
  syncChannelCalendarConnection,
  validateChannelImportUrl,
} from "@/lib/channel-calendar/client";
import type { ChannelCalendarProvider, ManagerChannelBookingProperty, ManagerChannelBookingRoom } from "@/lib/channel-calendar/types";
import { channelCalendarProviderLabel, icalLabelKey, ICAL_LABEL_MAX_LENGTH, isValidChannelImportUrl, normalizeIcalLabel } from "@/lib/channel-calendar/airbnb-url";
import { isEntireHomeProperty } from "@/lib/rental-application/data";
import { channelStatusParts, type ChannelConnectionStatus } from "@/lib/channel-calendar/channel-links";
import { buildAirbnbListingPack } from "@/lib/channel-calendar/listing-pack";
import { channelCalendarUnits, type ChannelCalendarUnit } from "@/lib/channel-calendar/property-units";
import {
  checkBulkRows,
  copyAllLinksText,
  draftsFromBulkRows,
  mapWithConcurrency,
  matchLinksToRooms,
  parsePastedLinks,
  type BulkRow,
  type BulkRowCheck,
} from "@/lib/channel-calendar/link-bulk";
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
  /**
   * The rooms and links the opener already loaded (the Integrations panel). With them the popup opens
   * at once and refreshes behind itself; a slow or failed refresh keeps what is shown and never
   * becomes a timeout message.
   */
  initialConnections?: readonly ManagerChannelBookingProperty[];
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

const CHANNEL_OPTIONS = (["airbnb", "booking_com", "vrbo", "ical"] as const).map((value) => ({ value, label: channelCalendarProviderLabel(value) }));
const rowKey = (propertyId: string, roomId: string) => `${propertyId}::${roomId}`;

/** One plain status line, composed from `channelStatusParts` so the red "Error:" is a part, not a cut. */
function ChannelStatusText({
  connection,
  channel,
  label,
}: {
  connection: ChannelConnectionStatus | null | undefined;
  channel: ChannelCalendarProvider;
  label?: string | null;
}) {
  const status = channelStatusParts(connection, new Date(), channel, label);
  const lead = status.error ? (
    <>
      <span className="text-danger">Error:</span> {status.error}
    </>
  ) : (
    status.state
  );
  return (
    <>
      {lead}
      {status.details.map((part) => (
        <span key={part}> · {part}</span>
      ))}
    </>
  );
}

/** Links saved or synced at once: four keeps 28 rooms quick without hammering the channel. */
const SAVE_SYNC_CONCURRENCY = 4;

type LinkCheck = { state: "checking" } | { state: "ok"; text: string } | { state: "bad"; text: string };

export function ChannelCalendarLinkFields({ active, propertyOptions: allPropertyOptions, initialProvider, initialConnections, showToast, onChanged, onClose, entries = [], onOpenBooking }: Props) {
  const [provider, setProvider] = useState<ChannelCalendarProvider | "">(initialProvider ?? "");
  // The raw rooms and links; the per-row map below is derived from them for the channel (and, for Other calendar, site) in view.
  const [linked, setLinked] = useState<readonly ManagerChannelBookingProperty[]>(initialConnections ?? []);
  const [siteName, setSiteName] = useState("");
  const [checks, setChecks] = useState<Record<string, LinkCheck>>({});
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [copiedKeys, setCopiedKeys] = useState<Record<string, boolean>>({});
  const [exports, setExports] = useState<Record<string, string>>({});
  // With links handed in there is nothing to wait for: the read below only refreshes them.
  const [loading, setLoading] = useState(false);
  const haveInitial = Boolean(initialConnections);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [preview, setPreview] = useState<{ room: string; events: ReturnType<typeof parseIcsCalendar> } | null>(null);
  const [disconnect, setDisconnect] = useState<{ id: string; label: string } | null>(null);
  const channel: ChannelCalendarProvider = provider || "airbnb";
  const isIcal = channel === "ical";
  const site = isIcal ? normalizeIcalLabel(siteName) : "";
  const name = channelCalendarProviderLabel(channel, site);
  const connections = useMemo(() => connectionMap(linked, channel, site), [linked, channel, site]);
  const knownSites = useMemo(
    () => [...new Set(linked.flatMap((p) => p.rooms.filter((r) => r.provider === "ical" && r.label?.trim()).map((r) => r.label!.trim())))],
    [linked],
  );

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
  const baseGroups = useMemo<LinkGroup[]>(
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
  // A link to a room the house no longer lists (a renamed or removed room, or one that only ever got an export link)
  // still exists and still blocks: it is drawn as a row under its house instead of being invisible here.
  const groups = useMemo<LinkGroup[]>(() => {
    const known = new Set(baseGroups.flatMap((g) => g.rows.map((r) => r.key)));
    const stray = new Map<string, LinkRow[]>();
    for (const property of linked) {
      if (!scopeIds.includes(property.propertyId)) continue;
      for (const room of property.rooms) {
        if (room.provider !== channel || (isIcal && icalLabelKey(room.label) !== icalLabelKey(site))) continue;
        const key = rowKey(property.propertyId, room.roomId);
        if (known.has(key)) continue;
        known.add(key);
        const unit: ChannelCalendarUnit = { id: room.roomId, label: room.roomLabel, name: room.roomLabel };
        stray.set(property.propertyId, [...(stray.get(property.propertyId) ?? []), { key, propertyId: property.propertyId, unit, title: room.roomLabel }]);
      }
    }
    return baseGroups.map((g) => (stray.has(g.propertyId) ? { ...g, rows: [...g.rows, ...stray.get(g.propertyId)!] } : g));
  }, [baseGroups, linked, scopeIds, channel, isIcal, site]);
  const rows = useMemo(() => groups.flatMap((g) => g.rows), [groups]);
  const houseLabelOf = (propertyId: string) => groups.find((g) => g.propertyId === propertyId)?.label ?? propertyId;

  const linkedRef = useRef(linked);
  useEffect(() => { linkedRef.current = linked; }, [linked]);
  useEffect(() => {
    if (!active) return;
    const ids = scopeKey ? scopeKey.split("\n") : [];
    if (!ids.length) { setLinked([]); return; }
    let stopped = false;
    // Only a popup opened WITHOUT links waits on this read. One opened with them (or that already
    // has them from an earlier pass) refreshes silently: a slow read leaves what is on screen alone.
    if (!haveInitial && linkedRef.current.length === 0) setLoading(true);
    setError("");
    // Rooms and links only (no stored stays): the heavy part of the Bookings read that used to time out here.
    fetchManagerChannelBookings(ids, { slim: true })
      .then((properties) => { if (!stopped) setLinked(properties); })
      .catch((e: unknown) => { if (!stopped && !haveInitial && linkedRef.current.length === 0) setError(e instanceof Error ? e.message : "Could not load calendars."); })
      .finally(() => { if (!stopped) setLoading(false); });
    return () => { stopped = true; };
  }, [active, scopeKey, haveInitial]);

  const refresh = async () => {
    const ids = scopeKey ? scopeKey.split("\n") : [];
    setLinked(ids.length ? await fetchManagerChannelBookings(ids, { slim: true }) : []);
    onChanged?.();
  };
  const run = async (action: () => Promise<void>) => {
    setBusy(true); setError("");
    try { await action(); } catch (e) { setError(e instanceof Error ? e.message : "Calendar action failed."); }
    finally { setBusy(false); }
  };
  const exportKey = (row: LinkRow) => `${row.key}:${channel}${isIcal ? `:${icalLabelKey(site)}` : ""}`;
  const exportFor = async (row: LinkRow) => {
    const key = exportKey(row);
    if (isIcal && !site) throw new Error("Name the site first, such as Houfy.");
    const url = exports[key] || connections.get(row.key)?.exportUrl || await fetchRoomExportCalendarUrl({ propertyId: row.propertyId, roomId: row.unit.id, roomLabel: isIcal ? site : row.unit.label, provider: channel });
    setExports((old) => ({ ...old, [key]: url }));
    return url;
  };
  const urlFor = (row: LinkRow) => exports[exportKey(row)] || connections.get(row.key)?.exportUrl || "";
  const openPreview = async (row: LinkRow) => {
    const response = await fetch(await exportFor(row), { credentials: "omit", cache: "no-store" });
    if (!response.ok) throw new Error("Could not load feed preview.");
    const body = await response.text();
    if (!body.includes("BEGIN:VCALENDAR")) throw new Error("The export did not return a calendar feed.");
    setPreview({ room: row.unit.label, events: parseIcsCalendar(body) });
  };
  const copy = async (row: LinkRow) => { await navigator.clipboard.writeText(await exportFor(row)); setCopiedKeys((old) => ({ ...old, [exportKey(row)]: true })); showToast("PropLane calendar link copied."); };
  const copyListingPack = async (row: LinkRow) => {
    const pack = buildAirbnbListingPack({ propertyId: row.propertyId, roomId: row.unit.id });
    await navigator.clipboard.writeText(pack.text);
    showToast(`Listing pack copied · ${pack.photoUrls.length} ${pack.photoUrls.length === 1 ? "photo" : "photos"} listed`);
  };
  const syncAll = () => run(async () => {
    try {
      const { synced, failed, skipped } = await syncAllChannelCalendarConnections(scopeKey ? scopeKey.split("\n") : []);
      showToast(
        failed || skipped
          ? `Synced ${synced}${failed ? ` · ${failed} failed` : ""}${skipped ? ` · ${skipped} left, sync again` : ""}`
          : `Synced ${synced} ${synced === 1 ? "calendar" : "calendars"}.`,
      );
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

  // Save sends every row whose link changed in ONE request, then syncs the ones that now have a link four at a
  // time. A row the manager emptied is sent as `importUrl: null`, which clears the stored link and its imported stays.
  const save = () => run(async () => {
    const failures: string[] = [];
    const failedKeys = new Set<string>();
    const results = await saveChannelCalendarConnectionsBatch(
      pending.map((row) => ({ propertyId: row.propertyId, roomId: row.unit.id, provider: channel, label: isIcal ? site : row.unit.label, importUrl: draftOf(row) || null })),
    );
    const toSync: Array<{ row: LinkRow; id: string }> = [];
    results.forEach((result, index) => {
      const row = pending[index]!;
      if (!result.ok) { failures.push(`${row.unit.label}: ${result.error}`); failedKeys.add(row.key); }
      else if (result.connection.hasImportUrl) toSync.push({ row, id: result.connection.id });
    });
    const synced = await mapWithConcurrency(toSync, SAVE_SYNC_CONCURRENCY, ({ id }) => syncChannelCalendarConnection(id));
    synced.forEach((result, index) => {
      if (!result.ok) failures.push(`${toSync[index]!.row.unit.label}: ${result.error instanceof Error ? result.error.message : "Sync failed"}`);
    });
    await refresh();
    // What saved is on the server now; only a row that failed to save keeps what the manager typed.
    setDrafts((old) => Object.fromEntries(Object.entries(old).filter(([key]) => failedKeys.has(key))));
    if (failures.length) setError(failures.join(" · "));
    else { showToast(pending.length > 0 && pending.every(clearedOf) ? "Calendar link removed." : "Calendars saved and synced."); }
  });

  // Copy all: every room's PropLane link as one "House · Room: URL" list. A room with no link yet gets one made,
  // the same way copying it one at a time does.
  const copyAll = () => run(async () => {
    const made = await mapWithConcurrency(rows, SAVE_SYNC_CONCURRENCY, async (row) => ({ house: houseLabelOf(row.propertyId), room: row.title, url: await exportFor(row) }));
    const entries = made.flatMap((result) => (result.ok ? [result.value] : []));
    if (entries.length === 0) throw new Error("Could not create the PropLane links.");
    await navigator.clipboard.writeText(copyAllLinksText(entries));
    const missed = made.length - entries.length;
    showToast(missed ? `Copied ${entries.length} PropLane links · ${missed} could not be created.` : `Copied ${entries.length} PropLane ${entries.length === 1 ? "link" : "links"}.`);
  });

  // Paste many: every link at once, matched to rooms in the order listed, each with its own room picker and its
  // own check. Using them only fills the boxes; the one Save below saves them all.
  const [paste, setPaste] = useState<{ text: string; rows: BulkRow[] | null } | null>(null);
  const labelOfKey = (key: string) => { const row = rows.find((r) => r.key === key); return row ? `${houseLabelOf(row.propertyId)} · ${row.title}` : key; };
  const pastedRows = paste?.rows ?? null;
  const bulkChecks = useMemo(
    () => (pastedRows ? checkBulkRows(channel, pastedRows, (key) => { const row = rows.find((r) => r.key === key); return row ? row.title : key; }) : new Map<string, BulkRowCheck>()),
    [pastedRows, channel, rows],
  );
  const reviewPaste = () => {
    if (!paste) return;
    const links = parsePastedLinks(paste.text);
    const keys = matchLinksToRooms(links, rows.map((row) => ({ key: row.key, label: row.title, filled: Boolean(shownOf(row).trim()) })));
    setPaste({ ...paste, rows: links.map((url, index) => ({ id: String(index), url, roomKey: keys[index] ?? "" })) });
  };
  const usablePasted = paste?.rows ? Object.keys(draftsFromBulkRows(paste.rows, bulkChecks)).length : 0;
  const pasteBlocked = Boolean(paste?.rows?.some((row) => row.roomKey && bulkChecks.get(row.id)?.ok === false));
  const applyPaste = () => {
    if (!paste?.rows) return;
    const next = draftsFromBulkRows(paste.rows, bulkChecks);
    setDrafts((old) => ({ ...old, ...next }));
    setPaste(null);
    showToast(`${Object.keys(next).length} ${Object.keys(next).length === 1 ? "link" : "links"} ready. Save to connect.`);
  };

  // "Other calendar" can be checked from the server before it is saved: public host, a real calendar.
  const checkLink = async (row: LinkRow) => {
    setChecks((old) => ({ ...old, [row.key]: { state: "checking" } }));
    try {
      const result = await validateChannelImportUrl(draftOf(row) || shownOf(row).trim());
      setChecks((old) => ({ ...old, [row.key]: result.ok ? { state: "ok", text: `Valid calendar · ${result.eventCount} ${result.eventCount === 1 ? "block" : "blocks"}` } : { state: "bad", text: result.error } }));
    } catch {
      // A check that cannot finish says so; saving is not gated on it.
      setChecks((old) => ({ ...old, [row.key]: { state: "bad", text: "Could not check that link in time. Try again." } }));
    }
  };
  const statusOf = (row: LinkRow) => clearedOf(row) ? "Link will be removed" : draftOf(row) ? (isBad(row) ? "Link not valid" : "Ready to connect") : connections.get(row.key)?.hasImportUrl ? "Connected" : "Not connected";
  const needsName = isIcal && !site;
  const stepsDef: AddWorkspaceStep[] = [
    { id: "link", label: "Link", incomplete: invalid || !provider || needsName },
  ];
  const errorAlert = error ? <p role="alert" className="mb-4 text-sm text-danger">{error}</p> : null;
  const gridClass = "md:grid md:grid-cols-[minmax(0,0.8fr)_minmax(0,1.5fr)_minmax(0,1.3fr)_auto] md:items-start md:gap-3";

  const page = <StepColumn wide>
    <StepHeading title="Link" />
    {errorAlert}
    <div className="mb-5 space-y-4">
      {!initialProvider ? <FieldSingleSelect labelClassName={POPUP_FIELD_LABEL_CLASS} label="Channel" dataAttr="channel-calendar-link-provider" value={provider} placeholder="Pick a channel…" disabled={busy} options={CHANNEL_OPTIONS} onChange={(next) => { if (next !== provider) { setDrafts({}); setChecks({}); } setProvider(next as ChannelCalendarProvider); }} /> : null}
      {isIcal ? <div className="space-y-1.5">
        <label htmlFor="channel-calendar-site-name" className="text-sm font-medium">Name</label>
        <Input id="channel-calendar-site-name" value={siteName} maxLength={ICAL_LABEL_MAX_LENGTH} list="channel-calendar-site-names" disabled={busy} placeholder="Houfy, Furnished Finder…" onChange={(e) => setSiteName(e.target.value)} data-attr="channel-calendar-site-name" />
        <datalist id="channel-calendar-site-names">{knownSites.map((known) => <option key={known} value={known} />)}</datalist>
      </div> : null}
    </div>
    {!loading && provider && rows.length > 0 ? <div className="-mt-2 mb-3 flex items-center justify-end gap-1" data-attr="channel-calendar-bulk-actions">
      <PortalIconAction icon={ClipboardCopy} label="Copy all PropLane links" disabled={busy || needsName} onClick={() => void copyAll()} data-attr="channel-calendar-copy-all" />
      <PortalIconAction icon={ClipboardPaste} label="Paste many" disabled={busy || needsName} onClick={() => setPaste({ text: "", rows: null })} data-attr="channel-calendar-paste-many" />
    </div> : null}
    {loading ? <p role="status">Loading linked rooms…</p> : rows.length === 0 ? <p>This workspace has no rooms listed.</p> : <div className="space-y-5" data-attr="channel-calendar-link-table">
      <div className={`hidden text-xs font-medium text-muted ${gridClass}`}><span>Room</span><span>{name} calendar link</span><span>PropLane link</span><span className="w-9" /></div>
      {groups.filter((g) => g.rows.length).map((group) => <section key={group.propertyId} aria-label={group.label} className="overflow-hidden rounded-2xl border border-border bg-card">
        <h3 className="border-b border-border px-4 py-2.5 text-sm font-semibold max-lg:text-[16px]">{group.label}</h3>
        {group.rows.map((row) => {
          const connection = connections.get(row.key);
          const url = urlFor(row);
          const conflicts = conflictingChannelStays(entries, row.propertyId, row.unit.id, channel);
          const bad = isBad(row);
          return <div key={row.key} data-attr="channel-calendar-room-row" className={`space-y-2 border-b border-border px-4 py-3 last:border-0 ${gridClass}`}>
            <div className="text-sm font-medium max-lg:text-[16px] md:pt-2.5">{row.title}
              {conflicts.length ? <Link className="mt-1 flex min-h-11 items-center gap-1.5 text-[13px] font-normal text-danger underline md:min-h-0 md:text-xs" href={bookingRecordHref("/portal", bookingEntryKey(conflicts[0]!))} onClick={onOpenBooking}><AlertCircle className="size-3.5" />{conflicts.length} {conflicts.length === 1 ? "conflict" : "conflicts"}</Link> : null}
            </div>
            <div className="space-y-1">
              <div className="flex items-center gap-2">
                <Input id={`channel-import-${row.key}`} type="url" aria-label={`${row.unit.label} ${name} calendar link`} aria-invalid={bad} value={shownOf(row)} disabled={busy} placeholder={`Paste ${name} calendar link`} onChange={(e) => setDrafts({ ...drafts, [row.key]: e.target.value })} data-attr="channel-calendar-link-import-url" />
                {isIcal && shownOf(row).trim() && !bad ? <PortalIconAction icon={checks[row.key]?.state === "bad" ? RotateCw : Check} label={checks[row.key]?.state === "bad" ? "Check link again" : "Check link"} disabled={busy || checks[row.key]?.state === "checking"} onClick={() => void checkLink(row)} data-attr="channel-calendar-check-link" /> : null}
                {shownOf(row).trim() ? <CopyIconAction label={`Copy ${name} calendar link`} disabled={busy} onCopy={async () => { await navigator.clipboard.writeText(shownOf(row).trim()); showToast(`${name} calendar link copied.`); }} /> : null}
              </div>
              {bad ? <p role="alert" className="text-sm text-danger">Enter a valid {name} calendar link.</p> : null}
              {checks[row.key]?.state === "ok" ? <p role="status" className="text-sm">{(checks[row.key] as { text: string }).text}</p> : null}
              {checks[row.key]?.state === "bad" ? <p role="alert" className="text-sm text-danger">{(checks[row.key] as { text: string }).text}</p> : null}
              {connection?.lastError ? <p role="alert" className="break-words text-sm text-danger">{connection.lastError}</p> : null}
            </div>
            <div className="flex items-center gap-2">
              <Input readOnly aria-label={`${row.unit.label} PropLane export link`} value={url} placeholder="Created when you copy it" data-attr="channel-calendar-export-url" />
              <CopyIconAction label="Copy PropLane calendar link" disabled={busy} onCopy={() => run(() => copy(row))} />
            </div>
            <div className="flex items-center justify-between gap-2 md:contents">
            <div data-attr="channel-calendar-room-status" className="min-w-0 break-words text-[13px] text-muted md:col-start-2 md:col-span-2 md:text-xs">
              <ChannelStatusText connection={connection} channel={channel} label={site} />
            </div>
            <div className="flex md:justify-end">
              <DropdownMenu><DropdownMenuTrigger asChild><PortalIconAction icon={MoreHorizontal} label={`${row.unit.label} actions`} /></DropdownMenuTrigger><DropdownMenuContent align="end">
                <DropdownMenuItem disabled={busy || !connection?.hasImportUrl} onSelect={() => { void run(async () => { try { await syncChannelCalendarConnection(connection!.connectionId); } finally { await refresh(); } }); }}>Sync now</DropdownMenuItem>
                <DropdownMenuItem disabled={busy} onSelect={() => { void run(() => openPreview(row)); }}>Feed preview</DropdownMenuItem>
                {channel === "airbnb" ? <DropdownMenuItem disabled={busy} onSelect={() => { void run(() => copyListingPack(row)); }}>Copy Airbnb listing pack</DropdownMenuItem> : null}
                <DropdownMenuItem className="text-danger" disabled={!connection || busy} onSelect={() => setDisconnect({ id: connection!.connectionId, label: row.unit.label })}>Disconnect</DropdownMenuItem>
              </DropdownMenuContent></DropdownMenu>
            </div>
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
      lastDisabled={loading || !provider || invalid || needsName || pending.length === 0}
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
    <PortalDialog
      open={Boolean(paste)}
      onClose={() => setPaste(null)}
      title={paste?.rows ? "Match links to rooms" : "Paste many"}
      primaryAction={paste?.rows
        ? { label: `Use ${usablePasted} ${usablePasted === 1 ? "link" : "links"}`, onClick: applyPaste, disabled: usablePasted === 0 || pasteBlocked, dataAttr: "channel-calendar-paste-apply" }
        : { label: "Match rooms", onClick: reviewPaste, disabled: parsePastedLinks(paste?.text ?? "").length === 0, dataAttr: "channel-calendar-paste-match" }}
      secondaryAction={paste?.rows ? { label: "Back", onClick: () => setPaste({ text: paste.text, rows: null }) } : null}
    >
      {paste?.rows ? <div className="space-y-3" data-attr="channel-calendar-paste-review">
        {paste.rows.length === 0 ? <p>No links found.</p> : paste.rows.map((row) => {
          const check = bulkChecks.get(row.id);
          return <div key={row.id} className="space-y-1.5 rounded-xl border border-border p-3" data-attr="channel-calendar-paste-row">
            <p className="break-all text-xs text-muted">{row.url}</p>
            <FieldSingleSelect hideLabel label="Room" dataAttr="channel-calendar-paste-room" value={row.roomKey} placeholder="Skip this link"
              options={[{ value: "", label: "Skip this link" }, ...rows.map((r) => ({ value: r.key, label: labelOfKey(r.key) }))]}
              onChange={(next) => setPaste({ text: paste.text, rows: paste.rows!.map((candidate) => (candidate.id === row.id ? { ...candidate, roomKey: next } : candidate)) })} />
            {row.roomKey && check?.ok === false ? <p role="alert" className="text-sm text-danger">{check.error}</p> : row.roomKey ? <p className="text-sm">OK</p> : null}
          </div>;
        })}
      </div> : <Textarea aria-label="Calendar links" rows={9} autoFocus value={paste?.text ?? ""} placeholder={`Paste every ${name} calendar link, one per line`} onChange={(event) => setPaste({ text: event.target.value, rows: null })} data-attr="channel-calendar-paste-text" />}
    </PortalDialog>
    <PortalDialog open={Boolean(preview)} onClose={() => setPreview(null)} title={`Feed preview · ${preview?.room ?? ""}`} primaryAction={{ label: "Done", onClick: () => setPreview(null) }} secondaryAction={null}><div className="space-y-3">{preview?.events.length === 0 ? <p>No PropLane blocks in this feed.</p> : preview?.events.map((event) => <div key={event.uid} className="rounded-xl border border-border p-3"><p>Blocked by PropLane</p><p>{formatPortalListDate(event.startDate)} – {formatPortalListDate(event.endDate)}</p><code className="text-xs">DTSTART {event.startDate.replaceAll("-", "")} · DTEND {new Date(Date.parse(`${event.endDate}T00:00:00Z`) + 86400000).toISOString().slice(0, 10).replaceAll("-", "")}</code></div>)}</div></PortalDialog>
    <PortalDialog open={Boolean(disconnect)} onClose={() => setDisconnect(null)} title="Disconnect calendar?" primaryAction={{ label: "Disconnect", onClick: () => run(async () => { await deleteChannelCalendarConnection(disconnect!.id); setDisconnect(null); await refresh(); }), disabled: busy }} secondaryAction={{ label: "Keep connected", onClick: () => setDisconnect(null) }}><p>{disconnect?.label ?? "This room"} · Imported blocks will be removed and this feed link may stop working.</p></PortalDialog>
  </>;
}

/** One connection per (property, room) for the channel being linked, keyed like a table row. */
function connectionMap(properties: readonly { propertyId: string; rooms: ManagerChannelBookingRoom[] }[], channel: ChannelCalendarProvider, site = ""): Map<string, ManagerChannelBookingRoom> {
  const map = new Map<string, ManagerChannelBookingRoom>();
  // Other calendar: a room can hold one link per site name, so a row shows only the named site's.
  const want = icalLabelKey(site);
  for (const property of properties) for (const room of property.rooms) if (room.provider === channel && (channel !== "ical" || icalLabelKey(room.label) === want)) map.set(rowKey(property.propertyId, room.roomId), room);
  return map;
}

function ConnectedChannelCalendarFields(props: Props) {
  const { userId } = useManagerUserId();
  const idsKey = props.propertyIds.join("\n");
  const ids = useMemo(() => idsKey ? idsKey.split("\n") : [], [idsKey]);
  const [refreshSignal, setRefreshSignal] = useState(0);
  const { entries } = useManagerBookingEntries({ userId, propertyIds: ids, propertyOptions: props.propertyOptions, propertyTick: 0, refreshSignal });
  return <ChannelCalendarLinkFields {...props} entries={entries} onChanged={() => { setRefreshSignal((value) => value + 1); props.onChanged?.(); }} />;
}

export function ChannelCalendarLinkModal({ open, onClose, ...props }: Omit<Props, "active" | "onClose"> & { open: boolean; onClose: () => void }) {
  if (!open) return null;
  return <div data-attr="channel-calendar-link-modal">{props.entries ? <ChannelCalendarLinkFields active {...props} onClose={onClose} onOpenBooking={onClose} /> : <ConnectedChannelCalendarFields active {...props} onClose={onClose} onOpenBooking={onClose} />}</div>;
}
