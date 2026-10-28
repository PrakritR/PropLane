"use client";

import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, ExternalLink, House } from "lucide-react";

import { IntegrationRow } from "@/components/portal/integration-row";
import { CopyIconAction, PortalIconAction } from "@/components/portal/portal-icon-action";
import { PortalSettingsGroup } from "@/components/portal/portal-settings-ui";
import { Button } from "@/components/ui/button";
import { PORTAL_READ_TIMEOUT_MS, fetchWithTimeout } from "@/lib/auth/fetch-with-timeout";
import { healthChannelName, reopenClosureEdit, type ChannelAttentionItem, type ChannelHealth, type ChannelHealthChannel, type FeedState } from "@/lib/channel-calendar/channel-health";
import type { ChannelCalendarProvider } from "@/lib/channel-calendar/types";
import { fetchRoomDateBlocks, saveRoomDateBlock } from "@/lib/channel-calendar/room-date-blocks";
import { pacificTodayKey } from "@/lib/public-room-live-label";

/** Where a channel's own calendar is edited (the "Open on Airbnb" action). Account pages, never a listing the feed named. */
const CHANNEL_CALENDAR_URL: Record<string, string> = {
  airbnb: "https://www.airbnb.com/hosting/calendar",
  booking_com: "https://admin.booking.com/",
  vrbo: "https://www.vrbo.com/",
};

const NOT_READING: ReadonlySet<FeedState> = new Set(["stale", "never"]);

function channelFact(channel: ChannelHealthChannel): string {
  const name = healthChannelName(channel.provider, channel.label);
  const base = `${name} ${channel.linked}/${channel.total}`;
  if (NOT_READING.has(channel.feed)) return `${base} · not reading`;
  return channel.feed === "error" ? `${base} · error` : base;
}

function houseFact(house: ChannelHealth["houses"][number]): string {
  const open = house.vacancy
    ? `${house.vacancy.filter((room) => room.status.kind === "now" || room.status.kind === "soon").length} open`
    : "Availability unavailable";
  return [open, ...house.channels.map(channelFact)].join(" · ");
}

function OpenOnChannel({ provider }: { provider: ChannelCalendarProvider }) {
  return (
    <PortalIconAction
      icon={ExternalLink}
      label={`Open on ${healthChannelName(provider, null)}`}
      data-attr="settings-channels-open-on-channel"
      onClick={() => window.open(CHANNEL_CALENDAR_URL[provider] ?? CHANNEL_CALENDAR_URL.airbnb, "_blank", "noopener,noreferrer")}
    />
  );
}

/** Integrations › Bookings › Channels: house x channel state, Copy post, and what needs a look. */
export function ChannelsHealthCard({
  propertyIds,
  showToast,
}: {
  propertyIds: readonly string[];
  showToast: (message: string) => void;
}) {
  const [health, setHealth] = useState<ChannelHealth | null>(null);
  const [busyItem, setBusyItem] = useState<string | null>(null);
  const key = propertyIds.join(",");

  const load = useCallback(async () => {
    if (!key) {
      setHealth({ houses: [], items: [] });
      return;
    }
    try {
      const res = await fetchWithTimeout(
        `/api/portal/channel-calendar/health?propertyIds=${encodeURIComponent(key)}`,
        { credentials: "include", cache: "no-store" },
        PORTAL_READ_TIMEOUT_MS,
      );
      if (!res.ok) throw new Error("health");
      const body = (await res.json()) as Partial<ChannelHealth> | null;
      // A payload that is not a health read draws nothing rather than taking the Integrations page down with it.
      if (!body || !Array.isArray(body.houses) || !Array.isArray(body.items)) throw new Error("health");
      setHealth({ houses: body.houses, items: body.items });
    } catch {
      showToast("Could not load channel health.");
    }
  }, [key, showToast]);
  useEffect(() => {
    void load();
  }, [load]);

  const reopen = async (item: ChannelAttentionItem) => {
    if (item.action?.kind !== "reopen") return;
    const blockId = item.action.blockId;
    setBusyItem(item.id);
    try {
      const block = (await fetchRoomDateBlocks()).find((candidate) => candidate.id === blockId);
      if (!block) throw new Error("That closure is already gone.");
      await saveRoomDateBlock("", {
        id: block.id,
        propertyId: block.propertyId,
        roomId: block.roomId,
        checkIn: block.checkIn,
        checkOut: block.checkOut,
        reason: block.reason,
        residentName: block.residentName,
        residentEmail: block.residentEmail,
        residentPhone: block.residentPhone,
        blockKind: block.blockKind,
        bookingStatus: block.bookingStatus,
        stayDetails: block.stayDetails,
        ...reopenClosureEdit(block, pacificTodayKey()),
      });
      showToast("Room reopened.");
      await load();
    } catch (error) {
      showToast(error instanceof Error ? error.message : "Could not reopen that room.");
    } finally {
      setBusyItem(null);
    }
  };

  if (!health || (health.houses.length === 0 && health.items.length === 0)) return null;

  return (
    <div className="mb-4 space-y-3" data-attr="settings-channels-card">
      <PortalSettingsGroup>
        {health.houses.map((house) => (
          <IntegrationRow
            stackOnPhone
            key={house.propertyId}
            icon={House}
            tone="text-foreground"
            name={house.label}
            fact={houseFact(house)}
            factDataAttr={`settings-channels-${house.propertyId}`}
            action={
              house.post ? (
                <CopyIconAction
                  label="Copy post"
                  data-attr="settings-channels-copy-post"
                  onCopy={async () => {
                    await navigator.clipboard.writeText(house.post!);
                    showToast("Post copied.");
                  }}
                />
              ) : undefined
            }
          />
        ))}
      </PortalSettingsGroup>
      {health.items.length > 0 ? (
        <PortalSettingsGroup>
          {health.items.map((item) => (
            <IntegrationRow
              stackOnPhone
              key={item.id}
              icon={AlertTriangle}
              tone="text-amber-600"
              name={item.text}
              dataAttr={`settings-channels-item-${item.kind}`}
              action={
                item.action?.kind === "reopen" ? (
                  <Button variant="ghost" data-attr="settings-channels-reopen" disabled={busyItem === item.id} onClick={() => reopen(item)}>
                    Reopen
                  </Button>
                ) : item.action?.kind === "open_on_channel" ? (
                  <OpenOnChannel provider={item.action.provider} />
                ) : undefined
              }
            />
          ))}
        </PortalSettingsGroup>
      ) : null}
    </div>
  );
}
