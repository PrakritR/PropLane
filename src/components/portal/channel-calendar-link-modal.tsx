"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type MutableRefObject } from "react";
import { Button } from "@/components/ui/button";
import { Input, Select } from "@/components/ui/input";
import { Modal, ModalFooter } from "@/components/ui/modal";
import {
  deleteChannelCalendarConnection,
  fetchManagerChannelBookings,
  saveChannelCalendarConnection,
  syncChannelCalendarConnection,
} from "@/lib/channel-calendar/client";
import {
  CHANNEL_CALENDAR_PROVIDERS,
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
  syncing: boolean;
  syncableCount: number;
};

export type ChannelCalendarLinkActions = {
  save: () => Promise<void>;
  syncAll: () => Promise<void>;
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
  const [provider, setProvider] = useState<ChannelCalendarProvider>("airbnb");
  const [propertyId, setPropertyId] = useState(initialPropertyId ?? "");
  const [roomChoice, setRoomChoice] = useState("");
  const [importUrl, setImportUrl] = useState("");
  const [saveError, setSaveError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [linked, setLinked] = useState<ManagerChannelBookingProperty[]>([]);
  const [linkedLoading, setLinkedLoading] = useState(false);
  const [confirmingUnlinkId, setConfirmingUnlinkId] = useState<string | null>(null);

  const reloadLinked = useCallback(async () => {
    if (propertyIds.length === 0) {
      setLinked([]);
      return;
    }
    setLinkedLoading(true);
    try {
      const rows = await fetchManagerChannelBookings(propertyIds);
      setLinked(rows);
    } catch {
      setLinked([]);
    } finally {
      setLinkedLoading(false);
    }
  }, [propertyIds]);

  useEffect(() => {
    if (!active) return;
    setProvider("airbnb");
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

  const syncableConnections = useMemo(
    () =>
      linked.flatMap((property) =>
        property.rooms.filter((room) => room.hasImportUrl).map((room) => room.connectionId),
      ),
    [linked],
  );

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
  const busyAny = busy || syncing;

  const handleSave = useCallback(async () => {
    if (!canSave) return;
    const { listingRoomId } = parseRoomChoiceValue(roomChoice);
    if (!listingRoomId) return;
    const roomLabel = roomOptions.find((r) => r.value === roomChoice)?.label ?? "Room";
    setBusy(true);
    setSaveError(null);
    try {
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
        showToast("Calendar saved. Use Sync all to refresh bookings.");
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
  }, [canSave, importUrl, onChanged, propertyId, provider, reloadLinked, roomChoice, roomOptions, showToast]);

  const syncAll = useCallback(async () => {
    if (syncableConnections.length === 0) {
      showToast("Link a room with an import URL first.");
      return;
    }
    setSyncing(true);
    let ok = 0;
    let failed = 0;
    try {
      for (const connectionId of syncableConnections) {
        try {
          await syncChannelCalendarConnection(connectionId);
          ok += 1;
        } catch {
          failed += 1;
        }
      }
      await reloadLinked();
      onChanged?.();
      if (failed === 0) {
        showToast(`Synced ${ok} calendar${ok === 1 ? "" : "s"}.`);
      } else {
        showToast(`Synced ${ok}; ${failed} failed.`);
      }
    } finally {
      setSyncing(false);
    }
  }, [onChanged, reloadLinked, showToast, syncableConnections]);

  const unlink = async (connectionId: string) => {
    setBusy(true);
    try {
      await deleteChannelCalendarConnection(connectionId);
      setConfirmingUnlinkId(null);
      await reloadLinked();
      onChanged?.();
      showToast("Calendar unlinked.");
    } catch (e) {
      showToast(e instanceof Error ? e.message : "Could not remove connection.");
    } finally {
      setBusy(false);
    }
  };

  const onFooterStateRef = useRef(onFooterState);
  // Keep the callback current without making a parent callback replacement a
  // footer-state notification. This effect runs before the notification effect.
  useEffect(() => {
    onFooterStateRef.current = onFooterState;
  }, [onFooterState]);
  useEffect(() => {
    onFooterStateRef.current?.({
      canSave,
      busy,
      syncing,
      syncableCount: syncableConnections.length,
    });
  }, [canSave, busy, syncing, syncableConnections.length]);

  useEffect(() => {
    if (!actionsRef) return;
    actionsRef.current = { save: handleSave, syncAll };
  }, [actionsRef, handleSave, syncAll]);

  const importPlaceholder =
    provider === "booking_com"
      ? "https://ical.booking.com/v1/export?t=…"
      : "https://www.airbnb.com/calendar/ical/…";

  return (
    <div className="space-y-4">
      <label className="block">
        <span className={FIELD_LABEL}>Channel</span>
        <Select
          value={provider}
          onChange={(e) => {
            setProvider(e.target.value as ChannelCalendarProvider);
            setImportUrl("");
            if (saveError) setSaveError(null);
          }}
          disabled={busyAny}
          aria-label="Channel"
          data-attr="channel-calendar-link-provider"
        >
          {CHANNEL_CALENDAR_PROVIDERS.map((value) => (
            <option key={value} value={value}>
              {channelCalendarProviderLabel(value)}
            </option>
          ))}
        </Select>
      </label>

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
        <span className={FIELD_LABEL}>{channelCalendarProviderLabel(provider)} import URL</span>
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
          <p className="text-xs font-semibold uppercase tracking-wide text-muted">Linked rooms</p>
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
                    <Button
                      type="button"
                      variant="outline"
                      className="h-8 min-h-0 px-3 text-[12px]"
                      disabled={busyAny}
                      data-attr="channel-calendar-copy-export-url"
                      onClick={() => {
                        const url = row.exportUrl;
                        if (!url) return;
                        void navigator.clipboard?.writeText(url)
                          .then(() => showToast("Export URL copied."))
                          .catch(() => showToast(url));
                      }}
                    >
                      Copy export URL
                    </Button>
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
    syncing: false,
    syncableCount: 0,
  });
  const actionsRef = useRef<ChannelCalendarLinkActions | null>(null);
  const busyAny = footerState.busy || footerState.syncing;

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Link calendars"
      dataAttr="channel-calendar-link-modal"
      footer={
        <ModalFooter className="justify-start">
          <Button
            type="button"
            variant="outline"
            disabled={busyAny || footerState.syncableCount === 0}
            data-attr="channel-calendar-sync-all"
            onClick={() => void actionsRef.current?.syncAll()}
          >
            {footerState.syncing ? "Syncing…" : "Sync all"}
          </Button>
          <Button
            type="button"
            variant="primary"
            disabled={!footerState.canSave || busyAny}
            data-attr="channel-calendar-save-link"
            onClick={() => void actionsRef.current?.save()}
          >
            {footerState.busy ? "Saving…" : "Save & sync"}
          </Button>
        </ModalFooter>
      }
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
    </Modal>
  );
}
