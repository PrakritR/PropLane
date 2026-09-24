"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type MutableRefObject } from "react";
import { Button } from "@/components/ui/button";
import { Input, Select } from "@/components/ui/input";
import { PortalDialog } from "@/components/portal/portal-dialog";
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

export type ChannelCalendarLinkFooterState = {
  canSave: boolean;
  busy: boolean;
};

export type ChannelCalendarLinkActions = {
  save: () => Promise<void>;
  flushChanged: () => void;
};

export function ChannelCalendarLinkFields({
  active,
  propertyIds,
  propertyOptions,
  initialPropertyId,
  showToast,
  onChanged,
  onFooterState,
  actionsRef,
}: {
  active: boolean;
  propertyIds: string[];
  propertyOptions: ManagerPropertyFilterOption[];
  initialPropertyId?: string;
  showToast: (message: string) => void;
  onChanged?: () => void;
  onFooterState?: (state: ChannelCalendarLinkFooterState) => void;
  actionsRef?: MutableRefObject<ChannelCalendarLinkActions | null>;
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
  const [confirmingUnlinkId, setConfirmingUnlinkId] = useState<string | null>(null);
  const hasLinkedRef = useRef(false);
  const dirtyRef = useRef(false);

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
    setConfirmingUnlinkId(null);
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
          exportUrl: room.exportUrl,
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
      dirtyRef.current = true;
      await reloadLinked();
    } catch (e) {
      const message = e instanceof Error ? e.message : "Could not link calendar.";
      setSaveError(message);
      showToast(message);
    } finally {
      setBusy(false);
    }
  }, [canSave, channel, importUrl, propertyId, reloadLinked, roomChoice, roomOptions, showToast]);

  const retrySync = useCallback(
    async (connectionId: string) => {
      setBusy(true);
      try {
        await syncChannelCalendarConnection(connectionId);
        dirtyRef.current = true;
        await reloadLinked();
        showToast("Calendar synced.");
      } catch (e) {
        showToast(e instanceof Error ? e.message : "Sync failed.");
        await reloadLinked();
      } finally {
        setBusy(false);
      }
    },
    [reloadLinked, showToast],
  );

  const unlink = async (connectionId: string) => {
    setBusy(true);
    try {
      await deleteChannelCalendarConnection(connectionId);
      setConfirmingUnlinkId(null);
      dirtyRef.current = true;
      await reloadLinked();
      showToast("Calendar unlinked.");
    } catch (e) {
      showToast(e instanceof Error ? e.message : "Could not remove connection.");
    } finally {
      setBusy(false);
    }
  };

  const onFooterStateRef = useRef(onFooterState);
  useEffect(() => {
    onFooterStateRef.current = onFooterState;
  }, [onFooterState]);
  useEffect(() => {
    onFooterStateRef.current?.({ canSave, busy });
  }, [canSave, busy]);

  useEffect(() => {
    if (!actionsRef) return;
    actionsRef.current = {
      save: handleSave,
      flushChanged: () => {
        if (!dirtyRef.current) return;
        dirtyRef.current = false;
        onChanged?.();
      },
    };
  }, [actionsRef, handleSave, onChanged]);

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

      {selectedListingRoomId ? (
        <div className="space-y-1.5">
          <span className={FIELD_LABEL}>PropLane calendar</span>
          {exportLoading ? (
            <p className="text-xs text-muted">Loading export link…</p>
          ) : exportError ? (
            <p className="text-xs text-danger" role="alert">{exportError}</p>
          ) : proplaneExportUrl ? (
            <div
              className="flex items-center gap-2 rounded-xl border border-border bg-muted/40 px-3 py-2.5"
              data-attr="channel-calendar-proplane-export"
            >
              <code className="min-w-0 flex-1 truncate text-[12px] text-foreground">{proplaneExportUrl}</code>
              <Button
                type="button"
                className="h-8 min-h-0 shrink-0 px-3 text-[12px]"
                data-attr="channel-calendar-copy-proplane-export"
                onClick={copyProplaneExport}
              >
                Copy
              </Button>
            </div>
          ) : null}
        </div>
      ) : null}

      <label className="block">
        <span className={FIELD_LABEL}>Import channel</span>
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

      {linkedLoading ? (
        <p className="text-xs text-muted">Loading linked rooms…</p>
      ) : linkedRows.length > 0 ? (
        <div className="rounded-lg border border-border bg-accent/20 px-3 py-2.5">
          <p className="text-xs font-semibold uppercase tracking-wide text-muted">Imported</p>
          <ul className="mt-2 space-y-2.5 text-xs text-foreground">
            {linkedRows.map((row) => (
              <li key={row.connectionId} className="space-y-1.5">
                <div className="flex flex-wrap items-baseline justify-between gap-x-2 gap-y-0.5">
                  <span>
                    {row.propertyLabel} · {row.roomLabel} · {channelCalendarProviderLabel(row.provider)}
                  </span>
                  <span className="text-muted">
                    {formatSyncedAt(row.lastSyncedAt)}
                    {row.importedRangeCount > 0 ? ` · ${row.importedRangeCount} block${row.importedRangeCount === 1 ? "" : "s"}` : ""}
                  </span>
                </div>
                {row.lastError ? (
                  <p className="text-[11px] text-danger" data-attr="channel-calendar-last-error">
                    {row.lastError}
                  </p>
                ) : null}
                {confirmingUnlinkId === row.connectionId ? (
                  <div className="flex flex-wrap items-center gap-2">
                    <Button
                      type="button"
                      variant="outline"
                      className="h-8 min-h-0 border-rose-200 px-3 text-[12px] text-rose-800 hover:bg-[var(--status-overdue-bg)] portal-danger-outline"
                      disabled={busyAny}
                      data-attr="channel-calendar-unlink-confirm"
                      onClick={() => unlink(row.connectionId)}
                    >
                      Confirm unlink
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      className="h-8 min-h-0 px-3 text-[12px]"
                      disabled={busyAny}
                      data-attr="channel-calendar-unlink-cancel"
                      onClick={() => setConfirmingUnlinkId(null)}
                    >
                      Keep
                    </Button>
                  </div>
                ) : (
                  <div className="flex flex-wrap items-center gap-2">
                    {row.lastError && row.hasImportUrl ? (
                      <Button
                        type="button"
                        variant="outline"
                        className="h-8 min-h-0 px-3 text-[12px]"
                        disabled={busyAny}
                        data-attr="channel-calendar-retry-sync"
                        onClick={() => void retrySync(row.connectionId)}
                      >
                        Retry
                      </Button>
                    ) : null}
                    <Button
                      type="button"
                      variant="outline"
                      className="h-8 min-h-0 px-3 text-[12px]"
                      disabled={busyAny}
                      data-attr="channel-calendar-unlink"
                      aria-label={`Unlink ${row.propertyLabel} · ${row.roomLabel}`}
                      onClick={() => setConfirmingUnlinkId(row.connectionId)}
                    >
                      Unlink
                    </Button>
                  </div>
                )}
              </li>
            ))}
          </ul>
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
  const [footerState, setFooterState] = useState<ChannelCalendarLinkFooterState>({
    canSave: false,
    busy: false,
  });
  const actionsRef = useRef<ChannelCalendarLinkActions | null>(null);

  return (
    <PortalDialog
      open={open}
      onClose={() => {
        actionsRef.current?.flushChanged();
        onClose();
      }}
      title="Link calendars"
      dataAttr="channel-calendar-link-modal"
      primaryAction={{
        label: footerState.busy ? "Saving…" : "Save & sync",
        onClick: () => void actionsRef.current?.save(),
        disabled: !footerState.canSave || footerState.busy,
        loading: footerState.busy,
        dataAttr: "channel-calendar-save-link",
      }}
    >
      <ChannelCalendarLinkFields
        active={open}
        propertyIds={propertyIds}
        propertyOptions={propertyOptions}
        initialPropertyId={initialPropertyId}
        showToast={showToast}
        onChanged={onChanged}
        onFooterState={setFooterState}
        actionsRef={actionsRef}
      />
    </PortalDialog>
  );
}
