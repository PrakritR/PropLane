"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input, Select } from "@/components/ui/input";
import { Modal, ModalFooter } from "@/components/ui/modal";
import {
  deleteChannelCalendarConnection,
  fetchManagerChannelBookings,
  saveChannelCalendarConnection,
  syncChannelCalendarConnection,
} from "@/lib/channel-calendar/client";
import type { ManagerChannelBookingProperty } from "@/lib/channel-calendar/types";
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
  const [propertyId, setPropertyId] = useState(initialPropertyId ?? "");
  const [roomChoice, setRoomChoice] = useState("");
  const [importUrl, setImportUrl] = useState("");
  // Inline, field-level failure. A toast alone was too easy to miss for a
  // validation message about the box directly above it.
  const [saveError, setSaveError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [linked, setLinked] = useState<ManagerChannelBookingProperty[]>([]);
  const [linkedLoading, setLinkedLoading] = useState(false);
  // Unlinking drops every imported range for that room, so it asks once rather
  // than firing from a single tap in a dense list.
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
    if (!open) return;
    setPropertyId(initialPropertyId ?? propertyOptions[0]?.id ?? "");
    setRoomChoice("");
    setImportUrl("");
    setConfirmingUnlinkId(null);
    void reloadLinked();
  }, [open, initialPropertyId, propertyOptions, reloadLinked]);

  const roomOptions = useMemo(() => {
    if (!propertyId) return [];
    return getRoomOptionsForProperty(propertyId, { includeUnavailable: true });
  }, [propertyId]);

  useEffect(() => {
    if (!open) return;
    if (roomOptions.length === 1) {
      setRoomChoice(roomOptions[0]!.value);
    } else {
      setRoomChoice("");
    }
  }, [open, propertyId, roomOptions]);

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

  const handleSave = async () => {
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
        label: roomLabel,
        importUrl: importUrl.trim(),
      });
      try {
        await syncChannelCalendarConnection(saved.id);
        showToast("Airbnb calendar linked and synced.");
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
  };

  const syncAll = async () => {
    if (syncableConnections.length === 0) {
      showToast("Link a room with an Airbnb import URL first.");
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
        showToast(`Synced ${ok} Airbnb calendar${ok === 1 ? "" : "s"}.`);
      } else {
        showToast(`Synced ${ok}; ${failed} failed.`);
      }
    } finally {
      setSyncing(false);
    }
  };

  /**
   * Linking is only half of it: a wrong or revoked iCal URL keeps importing
   * blocked ranges into the grid until the connection itself is removed, and
   * this modal is the only surface that lists them.
   */
  const unlink = async (connectionId: string) => {
    setBusy(true);
    try {
      await deleteChannelCalendarConnection(connectionId);
      setConfirmingUnlinkId(null);
      await reloadLinked();
      onChanged?.();
      showToast("Airbnb calendar unlinked.");
    } catch (e) {
      showToast(e instanceof Error ? e.message : "Could not remove connection.");
    } finally {
      setBusy(false);
    }
  };

  const busyAny = busy || syncing;

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Link Airbnb"
      description="Choose a house and room, paste the Airbnb export URL, then save or sync."
      dataAttr="channel-calendar-link-modal"
      /* Footer actions are left-justified here: they read as the next step in
         the form above them, not as a confirm/cancel pair in the corner. */
      footer={
        <ModalFooter className="justify-start">
          <Button
            type="button"
            variant="outline"
            disabled={busyAny || syncableConnections.length === 0}
            data-attr="channel-calendar-sync-all"
            onClick={() => void syncAll()}
          >
            {syncing ? "Syncing…" : "Sync all"}
          </Button>
          <Button
            type="button"
            variant="primary"
            disabled={!canSave || busyAny}
            data-attr="channel-calendar-save-link"
            onClick={() => void handleSave()}
          >
            {busy ? "Saving…" : "Save & sync"}
          </Button>
        </ModalFooter>
      }
    >
      <div className="space-y-4">
        <label className="block">
          <span className={FIELD_LABEL}>Property</span>
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
          <span className={FIELD_LABEL}>Airbnb import URL</span>
          <Input
            type="url"
            placeholder="https://www.airbnb.com/calendar/ical/…"
            value={importUrl}
            onChange={(e) => {
              setImportUrl(e.target.value);
              // Clear a previous rejection as soon as the manager edits, so the
              // message always refers to what is currently in the box.
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
          ) : (
            <p className="mt-1.5 text-xs text-muted">
              Airbnb → Calendar → Availability → Connect calendars → Export calendar.
            </p>
          )}
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
                      {row.propertyLabel} · {row.roomLabel}
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
                      <span className="text-[11px] text-muted">
                        Unlink this room? Its imported blocks are removed from the calendar.
                      </span>
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
    </Modal>
  );
}
