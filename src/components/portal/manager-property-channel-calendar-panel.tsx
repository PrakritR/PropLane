"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  PORTAL_PROPERTY_DETAIL_ACTION_BUTTON_CLASS,
  PORTAL_PROPERTY_DETAIL_LIST_ROW_CLASS,
  PortalPropertyDetailSection,
} from "@/components/portal/portal-property-detail-section";
import {
  deleteChannelCalendarConnection,
  fetchChannelCalendarConnections,
  saveChannelCalendarConnection,
  syncChannelCalendarConnection,
} from "@/lib/channel-calendar/client";
import type { ChannelCalendarConnectionPublic } from "@/lib/channel-calendar/types";
import type { ManagerListingSubmissionV1 } from "@/lib/manager-listing-submission";

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

function connectionForRoom(
  connections: ChannelCalendarConnectionPublic[],
  roomId: string,
): ChannelCalendarConnectionPublic | undefined {
  return connections.find((c) => c.roomId === roomId);
}

export function ManagerPropertyChannelCalendarPanel({
  propertyId,
  submission,
  showToast,
}: {
  propertyId: string;
  submission: ManagerListingSubmissionV1 | null;
  showToast: (message: string) => void;
}) {
  const rooms = submission?.rooms ?? [];
  const [connections, setConnections] = useState<ChannelCalendarConnectionPublic[]>([]);
  const [loading, setLoading] = useState(true);
  const [draftImportUrls, setDraftImportUrls] = useState<Record<string, string>>({});
  const [busyRoomId, setBusyRoomId] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const rows = await fetchChannelCalendarConnections(propertyId);
      setConnections(rows);
      setDraftImportUrls((prev) => {
        const next = { ...prev };
        for (const room of submission?.rooms ?? []) {
          const existing = rows.find((c) => c.roomId === room.id);
          if (existing && next[room.id] === undefined) {
            next[room.id] = "";
          }
        }
        return next;
      });
    } catch (e) {
      showToast(e instanceof Error ? e.message : "Could not load channel calendars.");
    } finally {
      setLoading(false);
    }
  }, [propertyId, submission, showToast]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const roomRows = useMemo(
    () =>
      rooms.map((room) => ({
        room,
        connection: connectionForRoom(connections, room.id),
      })),
    [connections, rooms],
  );

  const copyExportUrl = useCallback(
    async (url: string) => {
      try {
        await navigator.clipboard.writeText(url);
        showToast("Export URL copied — paste it into Airbnb under Import calendar.");
      } catch {
        showToast(url);
      }
    },
    [showToast],
  );

  const handleSave = useCallback(
    async (roomId: string, roomName: string) => {
      setBusyRoomId(roomId);
      try {
        const trimmed = (draftImportUrls[roomId] ?? "").trim();
        const existing = connections.find((c) => c.roomId === roomId);
        const saved = await saveChannelCalendarConnection({
          propertyId,
          roomId,
          label: roomName,
          ...(trimmed
            ? { importUrl: trimmed }
            : existing?.hasImportUrl
              ? {}
              : { importUrl: null }),
        });
        setConnections((prev) => {
          const rest = prev.filter((c) => c.roomId !== roomId);
          return [...rest, saved];
        });
        setDraftImportUrls((prev) => ({ ...prev, [roomId]: "" }));
        showToast("Channel calendar saved.");
      } catch (e) {
        showToast(e instanceof Error ? e.message : "Could not save.");
      } finally {
        setBusyRoomId(null);
      }
    },
    [connections, draftImportUrls, propertyId, showToast],
  );

  const handleSync = useCallback(
    async (connection: ChannelCalendarConnectionPublic) => {
      setBusyRoomId(connection.roomId);
      try {
        const saved = await syncChannelCalendarConnection(connection.id);
        setConnections((prev) => prev.map((c) => (c.id === saved.id ? saved : c)));
        showToast(
          saved.importedRangeCount > 0
            ? `Synced ${saved.importedRangeCount} blocked date range${saved.importedRangeCount === 1 ? "" : "s"} from Airbnb.`
            : "Sync complete — no blocked dates in the Airbnb calendar.",
        );
      } catch (e) {
        showToast(e instanceof Error ? e.message : "Sync failed.");
        await reload();
      } finally {
        setBusyRoomId(null);
      }
    },
    [reload, showToast],
  );

  const handleRemove = useCallback(
    async (connection: ChannelCalendarConnectionPublic) => {
      setBusyRoomId(connection.roomId);
      try {
        await deleteChannelCalendarConnection(connection.id);
        setConnections((prev) => prev.filter((c) => c.id !== connection.id));
        showToast("Channel calendar removed.");
      } catch (e) {
        showToast(e instanceof Error ? e.message : "Could not remove.");
      } finally {
        setBusyRoomId(null);
      }
    },
    [showToast],
  );

  if (!submission || rooms.length === 0) return null;

  return (
    <PortalPropertyDetailSection contentClassName="mt-8 border-t border-border/50 pt-6">
      <div className="space-y-1">
        <h3 className="text-sm font-semibold text-foreground">Channel calendars</h3>
        <p className="text-xs text-muted-foreground">
          Link each room to its Airbnb listing calendar. Import pulls Airbnb reservations into PropLane
          as blocked dates; export lets Airbnb read PropLane blocks.
        </p>
      </div>

      {loading ? (
        <p className="mt-4 text-sm text-muted-foreground">Loading channel calendars…</p>
      ) : (
        <div className="mt-4 space-y-0">
          {roomRows.map(({ room, connection }) => {
            const busy = busyRoomId === room.id;
            const importDraft = draftImportUrls[room.id] ?? "";
            return (
              <div key={room.id} className={PORTAL_PROPERTY_DETAIL_LIST_ROW_CLASS}>
                <div className="min-w-0 flex-1 space-y-3">
                  <div>
                    <p className="text-sm font-medium text-foreground">{room.name || "Room"}</p>
                    <p className="text-xs text-muted-foreground">
                      {connection
                        ? `${formatSyncedAt(connection.lastSyncedAt)} · ${connection.importedRangeCount} imported block${connection.importedRangeCount === 1 ? "" : "s"}`
                        : "Not linked"}
                      {connection?.lastError ? (
                        <span className="text-destructive"> · {connection.lastError}</span>
                      ) : null}
                    </p>
                  </div>

                  <label className="block space-y-1">
                    <span className="text-xs font-medium text-muted-foreground">Airbnb import URL</span>
                    <input
                      type="url"
                      className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm"
                      placeholder="https://www.airbnb.com/calendar/ical/…"
                      value={importDraft}
                      onChange={(e) =>
                        setDraftImportUrls((prev) => ({ ...prev, [room.id]: e.target.value }))
                      }
                      disabled={busy}
                      data-attr={`channel-calendar-import-${room.id}`}
                    />
                  </label>

                  {connection ? (
                    <div className="flex flex-wrap items-center gap-2">
                      <Button
                        type="button"
                        variant="outline"
                        className={PORTAL_PROPERTY_DETAIL_ACTION_BUTTON_CLASS}
                        disabled={busy}
                        onClick={() => copyExportUrl(connection.exportUrl)}
                        data-attr={`channel-calendar-copy-export-${room.id}`}
                      >
                        Copy export URL
                      </Button>
                      <Button
                        type="button"
                        variant="outline"
                        className={PORTAL_PROPERTY_DETAIL_ACTION_BUTTON_CLASS}
                        disabled={busy || !connection.hasImportUrl}
                        onClick={() => handleSync(connection)}
                        data-attr={`channel-calendar-sync-${room.id}`}
                      >
                        Sync now
                      </Button>
                      <Button
                        type="button"
                        variant="outline"
                        className={PORTAL_PROPERTY_DETAIL_ACTION_BUTTON_CLASS}
                        disabled={busy}
                        onClick={() => handleRemove(connection)}
                        data-attr={`channel-calendar-remove-${room.id}`}
                      >
                        Remove
                      </Button>
                    </div>
                  ) : null}
                </div>

                <div className="shrink-0 self-start pt-1">
                  <Button
                    type="button"
                    variant="primary"
                    className={PORTAL_PROPERTY_DETAIL_ACTION_BUTTON_CLASS}
                    disabled={busy}
                    onClick={() => handleSave(room.id, room.name)}
                    data-attr={`channel-calendar-save-${room.id}`}
                  >
                    Save
                  </Button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </PortalPropertyDetailSection>
  );
}
