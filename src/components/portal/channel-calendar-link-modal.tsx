"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input, Select } from "@/components/ui/input";
import { PortalDialog } from "@/components/portal/portal-dialog";
import { RecordActionContext } from "@/components/ui/record-action-context";
import { RecordActionMenu } from "@/components/ui/record-action-menu";
import {
  deleteChannelCalendarConnection,
  fetchManagerChannelBookings,
  fetchRoomExportCalendarUrl,
  saveChannelCalendarConnection,
  syncChannelCalendarConnection,
} from "@/lib/channel-calendar/client";
import {
  type ChannelCalendarProvider,
  type ManagerChannelBookingProperty,
} from "@/lib/channel-calendar/types";
import { channelCalendarProviderLabel } from "@/lib/channel-calendar/airbnb-url";
import {
  getRoomOptionsForProperty,
  parseRoomChoiceValue,
} from "@/lib/rental-application/data";
import type { ManagerPropertyFilterOption } from "@/lib/manager-portfolio-access";
import { PortalIconAction } from "@/components/portal/portal-icon-action";
import { Copy } from "lucide-react";

const FIELD_LABEL = "mb-1.5 block text-xs font-semibold uppercase tracking-wide text-muted";

const CHANNEL_LINK_OPTIONS = [
  { value: "airbnb", label: "Airbnb" },
  { value: "booking_com", label: "Booking.com" },
] as const;

type ChannelLinkKind = (typeof CHANNEL_LINK_OPTIONS)[number]["value"];

function formatSyncedAt(iso: string | null): string {
  if (!iso) return "Never synced";
  try {
    return new Date(iso).toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  } catch {
    return "Never synced";
  }
}

type LinkedRow = {
  propertyLabel: string;
  roomLabel: string;
  provider: ChannelCalendarProvider;
  connectionId: string;
  hasImportUrl: boolean;
  lastSyncedAt: string | null;
  lastError: string | null;
  importedRangeCount: number;
};

function LinkedCalendarRow({
  row,
  busy,
  onSync,
  onUnlink,
}: {
  row: LinkedRow;
  busy: boolean;
  onSync: (connectionId: string) => void;
  onUnlink: (connectionId: string) => void;
}) {
  const label = `${row.propertyLabel} · ${row.roomLabel}`;
  return (
    <RecordActionContext.Provider
      value={{
        scope: row.connectionId,
        clear: () => {},
        actions: (
          <>
            {row.hasImportUrl ? (
              <Button
                type="button"
                variant="outline"
                data-attr="channel-calendar-retry-sync"
                data-record-action-id="sync"
                disabled={busy}
                onClick={() => onSync(row.connectionId)}
              >
                Sync now
              </Button>
            ) : null}
            <Button
              type="button"
              variant="danger"
              data-attr="channel-calendar-unlink"
              data-record-action-id="delete"
              disabled={busy}
              onClick={() => onUnlink(row.connectionId)}
            >
              Unlink
            </Button>
          </>
        ),
      }}
    >
      <div
        className="flex items-center gap-2 rounded-xl border border-border bg-card px-3 py-2.5"
        data-attr={`channel-calendar-linked-row-${row.connectionId}`}
      >
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold text-foreground">
            {label} · {channelCalendarProviderLabel(row.provider)}
          </p>
          <p className="truncate text-[12px] text-muted">
            {formatSyncedAt(row.lastSyncedAt)}
            {row.importedRangeCount > 0
              ? ` · ${row.importedRangeCount} block${row.importedRangeCount === 1 ? "" : "s"}`
              : ""}
          </p>
          {row.lastError ? (
            <p className="mt-0.5 text-[11px] text-danger" data-attr="channel-calendar-last-error">
              {row.lastError}
            </p>
          ) : null}
        </div>
        <RecordActionMenu label={label} activate={() => {}} />
      </div>
    </RecordActionContext.Provider>
  );
}

export function ChannelCalendarLinkFields({
  active,
  propertyIds,
  propertyOptions,
  initialPropertyId,
  showToast,
  onChanged,
}: {
  active: boolean;
  propertyIds: string[];
  propertyOptions: ManagerPropertyFilterOption[];
  initialPropertyId?: string;
  showToast: (message: string) => void;
  onChanged?: () => void;
}) {
  const [channel, setChannel] = useState<ChannelLinkKind>("airbnb");
  const [propertyId, setPropertyId] = useState(initialPropertyId ?? "");
  const [roomChoice, setRoomChoice] = useState("");
  const [importUrl, setImportUrl] = useState("");
  const [saveError, setSaveError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [proplaneExportUrl, setProplaneExportUrl] = useState<string | null>(null);
  const [exportLoading, setExportLoading] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
  const [linked, setLinked] = useState<ManagerChannelBookingProperty[]>([]);
  const [linkedLoading, setLinkedLoading] = useState(false);
  const hasLinkedRef = useRef(false);

  const reloadLinked = useCallback(async () => {
    if (propertyIds.length === 0) {
      setLinked([]);
      return;
    }
    if (!hasLinkedRef.current) setLinkedLoading(true);
    try {
      const rows = await fetchManagerChannelBookings(propertyIds);
      setLinked(rows);
      hasLinkedRef.current = true;
    } catch {
      if (!hasLinkedRef.current) setLinked([]);
    } finally {
      setLinkedLoading(false);
    }
  }, [propertyIds]);

  useEffect(() => {
    if (!active) return;
    setChannel("airbnb");
    setPropertyId(initialPropertyId ?? propertyOptions[0]?.id ?? "");
    setRoomChoice("");
    setImportUrl("");
    void reloadLinked();
  }, [active, initialPropertyId, propertyOptions, reloadLinked]);

  const roomOptions = useMemo(() => {
    if (!propertyId) return [];
    return getRoomOptionsForProperty(propertyId, { includeUnavailable: true });
  }, [propertyId]);

  useEffect(() => {
    if (!active) return;
    if (roomOptions.length === 1) {
      setRoomChoice(roomOptions[0]!.value);
    } else {
      setRoomChoice("");
    }
  }, [active, propertyId, roomOptions]);

  const linkedRows = useMemo(
    () =>
      linked.flatMap((property) =>
        property.rooms.map((room) => ({
          propertyLabel: property.propertyLabel,
          roomLabel: room.roomLabel,
          provider: room.provider,
          connectionId: room.connectionId,
          hasImportUrl: room.hasImportUrl,
          lastSyncedAt: room.lastSyncedAt,
          lastError: room.lastError,
          importedRangeCount: room.ranges.length,
        })),
      ),
    [linked],
  );

  const canSave = Boolean(propertyId && roomChoice && importUrl.trim());
  const busyAny = busy;

  const selectedListingRoomId = useMemo(() => {
    const { listingRoomId } = parseRoomChoiceValue(roomChoice);
    return listingRoomId || "";
  }, [roomChoice]);

  useEffect(() => {
    if (!active || !propertyId || !selectedListingRoomId) {
      setProplaneExportUrl(null);
      setExportError(null);
      setExportLoading(false);
      return;
    }
    const roomLabel = roomOptions.find((r) => r.value === roomChoice)?.label ?? "";
    let cancelled = false;
    setExportLoading(true);
    setExportError(null);
    void fetchRoomExportCalendarUrl({
      propertyId,
      roomId: selectedListingRoomId,
      roomLabel,
    })
      .then((url) => {
        if (!cancelled) setProplaneExportUrl(url);
      })
      .catch((e) => {
        if (!cancelled) {
          setProplaneExportUrl(null);
          setExportError(e instanceof Error ? e.message : "Could not load PropLane calendar link.");
        }
      })
      .finally(() => {
        if (!cancelled) setExportLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [active, propertyId, roomChoice, roomOptions, selectedListingRoomId]);

  const handleSave = useCallback(async () => {
    if (!canSave) return;
    const { listingRoomId } = parseRoomChoiceValue(roomChoice);
    if (!listingRoomId) return;
    const roomLabel = roomOptions.find((r) => r.value === roomChoice)?.label ?? "Room";
    setBusy(true);
    setSaveError(null);
    try {
      const provider: ChannelCalendarProvider = channel === "booking_com" ? "booking_com" : "airbnb";
      const saved = await saveChannelCalendarConnection({
        propertyId,
        roomId: listingRoomId,
        provider,
        label: roomLabel,
        importUrl: importUrl.trim(),
      });
      try {
        await syncChannelCalendarConnection(saved.id);
        showToast(`${channelCalendarProviderLabel(provider)} calendar linked and synced.`);
      } catch {
        showToast("Calendar saved. Sync will retry automatically.");
      }
      setImportUrl("");
      await reloadLinked();
      onChanged?.();
    } catch (e) {
      const message = e instanceof Error ? e.message : "Could not link calendar.";
      setSaveError(message);
      showToast(message);
    } finally {
      setBusy(false);
    }
  }, [canSave, channel, importUrl, onChanged, propertyId, reloadLinked, roomChoice, roomOptions, showToast]);

  const retrySync = useCallback(
    async (connectionId: string) => {
      setBusy(true);
      try {
        await syncChannelCalendarConnection(connectionId);
        await reloadLinked();
        showToast("Calendar synced.");
        onChanged?.();
      } catch (e) {
        showToast(e instanceof Error ? e.message : "Sync failed.");
        await reloadLinked();
      } finally {
        setBusy(false);
      }
    },
    [onChanged, reloadLinked, showToast],
  );

  const unlink = useCallback(
    async (connectionId: string) => {
      setBusy(true);
      try {
        await deleteChannelCalendarConnection(connectionId);
        await reloadLinked();
        showToast("Calendar unlinked.");
        onChanged?.();
      } catch (e) {
        showToast(e instanceof Error ? e.message : "Could not remove connection.");
      } finally {
        setBusy(false);
      }
    },
    [onChanged, reloadLinked, showToast],
  );

  const importPlaceholder =
    channel === "booking_com"
      ? "https://ical.booking.com/v1/export?t=…"
      : "https://www.airbnb.com/calendar/ical/…";

  const copyProplaneExport = () => {
    const url = proplaneExportUrl;
    if (!url) return;
    void navigator.clipboard?.writeText(url)
      .then(() => showToast("PropLane calendar link copied."))
      .catch(() => showToast(url));
  };

  const showLinkCard = Boolean(propertyId && roomChoice);

  return (
    <div className="space-y-4">
      <label className="block">
        <span className={FIELD_LABEL}>House</span>
        <Select
          value={propertyId}
          onChange={(e) => setPropertyId(e.target.value)}
          disabled={busyAny || propertyOptions.length === 0}
          data-attr="channel-calendar-link-property"
        >
          <option value="">Select a house…</option>
          {propertyOptions.map((property) => (
            <option key={property.id} value={property.id}>
              {property.label}
            </option>
          ))}
        </Select>
      </label>

      <label className="block">
        <span className={FIELD_LABEL}>Room</span>
        <Select
          value={roomChoice}
          onChange={(e) => setRoomChoice(e.target.value)}
          disabled={busyAny || !propertyId || roomOptions.length === 0}
          data-attr="channel-calendar-link-room"
        >
          <option value="">
            {roomOptions.length === 0 ? "No rooms on this listing" : "Select a room…"}
          </option>
          {roomOptions.map((room) => (
            <option key={room.value} value={room.value}>
              {room.label}
            </option>
          ))}
        </Select>
      </label>

      <label className="block">
        <span className={FIELD_LABEL}>Channel</span>
        <Select
          value={channel}
          onChange={(e) => {
            setChannel(e.target.value as ChannelLinkKind);
            setImportUrl("");
            if (saveError) setSaveError(null);
          }}
          disabled={busyAny}
          aria-label="Import channel"
          data-attr="channel-calendar-link-provider"
        >
          {CHANNEL_LINK_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </Select>
      </label>

      {showLinkCard ? (
        <div
          className="space-y-3 rounded-2xl border border-border bg-accent/15 p-3.5"
          data-attr="channel-calendar-link-card"
        >
          <p className="text-xs font-semibold uppercase tracking-wide text-muted">Link this room</p>

          <div className="space-y-1.5">
            <span className={FIELD_LABEL}>PropLane export</span>
            {exportLoading ? (
              <p className="text-xs text-muted">Loading export link…</p>
            ) : exportError ? (
              <p className="text-xs text-danger" role="alert">
                {exportError}
              </p>
            ) : proplaneExportUrl ? (
              <div
                className="flex items-center gap-2 rounded-xl border border-border bg-card px-3 py-2.5"
                data-attr="channel-calendar-proplane-export"
              >
                <code className="min-w-0 flex-1 truncate text-[12px] text-foreground">{proplaneExportUrl}</code>
                <PortalIconAction
                  icon={Copy}
                  label="Copy PropLane calendar link"
                  data-attr="channel-calendar-copy-proplane-export"
                  onClick={copyProplaneExport}
                />
              </div>
            ) : null}
          </div>

          <label className="block">
            <span className={FIELD_LABEL}>
              {channel === "booking_com" ? "Booking.com" : "Airbnb"} import URL
            </span>
            <Input
              type="url"
              placeholder={importPlaceholder}
              value={importUrl}
              onChange={(e) => {
                setImportUrl(e.target.value);
                if (saveError) setSaveError(null);
              }}
              disabled={busyAny}
              aria-invalid={saveError ? true : undefined}
              data-attr="channel-calendar-link-import-url"
            />
            {saveError ? (
              <p className="mt-1.5 text-xs text-danger" role="alert" data-attr="channel-calendar-link-error">
                {saveError}
              </p>
            ) : null}
          </label>

          <Button
            type="button"
            className="w-full"
            disabled={!canSave || busyAny}
            loading={busyAny && canSave}
            data-attr="channel-calendar-save-link"
            onClick={() => void handleSave()}
          >
            {busyAny && canSave ? "Linking…" : "Link & sync"}
          </Button>
        </div>
      ) : null}

      {linkedLoading ? (
        <p className="text-xs text-muted">Loading linked rooms…</p>
      ) : linkedRows.length > 0 ? (
        <div className="space-y-2" data-attr="channel-calendar-linked-list">
          <p className="text-xs font-semibold uppercase tracking-wide text-muted">Linked</p>
          {linkedRows.map((row) => (
            <LinkedCalendarRow
              key={row.connectionId}
              row={row}
              busy={busyAny}
              onSync={(id) => void retrySync(id)}
              onUnlink={(id) => void unlink(id)}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

export function ChannelCalendarLinkModal({
  open,
  onClose,
  propertyIds,
  propertyOptions,
  initialPropertyId,
  showToast,
  onChanged,
}: {
  open: boolean;
  onClose: () => void;
  propertyIds: string[];
  propertyOptions: ManagerPropertyFilterOption[];
  initialPropertyId?: string;
  showToast: (message: string) => void;
  onChanged?: () => void;
}) {
  return (
    <PortalDialog
      open={open}
      onClose={onClose}
      title="Link calendars"
      dataAttr="channel-calendar-link-modal"
      primaryAction={{
        label: "Done",
        onClick: onClose,
        dataAttr: "channel-calendar-link-done",
      }}
      secondaryAction={null}
    >
      <ChannelCalendarLinkFields
        active={open}
        propertyIds={propertyIds}
        propertyOptions={propertyOptions}
        initialPropertyId={initialPropertyId}
        showToast={showToast}
        onChanged={onChanged}
      />
    </PortalDialog>
  );
}
