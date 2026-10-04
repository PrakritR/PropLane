"use client";

import { useCallback, useEffect, useState } from "react";
import { BedDouble, Building2, House, Palmtree, Sofa } from "lucide-react";

import { ChannelCalendarLinkModal } from "@/components/portal/channel-calendar-link-modal";
import { IntegrationRow } from "@/components/portal/integration-row";
import { useAppUi } from "@/components/providers/app-ui-provider";
import { PortalSettingsGroup } from "@/components/portal/portal-settings-ui";
import { useWorkspaces } from "@/components/portal/workspace-provider";
import { Button } from "@/components/ui/button";
import { fetchManagerChannelBookings } from "@/lib/channel-calendar/client";
import type { ChannelCalendarProvider } from "@/lib/channel-calendar/types";

type ChannelCounts = Record<ChannelCalendarProvider, number | null>;

/** Channels that connect today; their rows open the one-page Connect popup. */
const LIVE_CHANNELS = [
  { provider: "airbnb", name: "Airbnb", icon: House, tone: "text-rose-500" },
  { provider: "booking_com", name: "Booking.com", icon: Building2, tone: "text-blue-600" },
] as const;

/** Channels that are listed so managers see what is coming - no connect action yet. */
const COMING_SOON_CHANNELS = [
  { id: "spareroom", name: "SpareRoom", icon: BedDouble },
  { id: "furnished-finder", name: "Furnished Finder", icon: Sofa },
] as const;

/** Settings → Integrations → Bookings: the channels whose calendars PropLane syncs. */
export function ManagerBookingChannelsPanel() {
  const { showToast } = useAppUi();
  const workspaceCtx = useWorkspaces();
  const activeWorkspace = workspaceCtx?.active ?? null;
  const [channelOpen, setChannelOpen] = useState<ChannelCalendarProvider | null>(null);
  const [counts, setCounts] = useState<ChannelCounts>({ airbnb: null, booking_com: null, vrbo: null });
  const propertyKey = (activeWorkspace?.propertyIds ?? []).join(",");

  const loadChannels = useCallback(async () => {
    const ids = propertyKey.split(",").filter(Boolean);
    if (!ids.length) {
      setCounts({ airbnb: 0, booking_com: 0, vrbo: 0 });
      return;
    }
    try {
      const properties = await fetchManagerChannelBookings(ids);
      const count = (provider: ChannelCalendarProvider) =>
        new Set(
          properties.flatMap((p) =>
            p.rooms.filter((r) => r.provider === provider && r.hasImportUrl).map((r) => `${p.propertyId}:${r.roomId}`),
          ),
        ).size;
      setCounts({ airbnb: count("airbnb"), booking_com: count("booking_com"), vrbo: count("vrbo") });
    } catch {
      showToast("Could not load channel connections.");
    }
  }, [propertyKey, showToast]);
  useEffect(() => {
    void loadChannels();
  }, [loadChannels]);

  const propertyOptions = (activeWorkspace?.propertyIds ?? []).map((id) => ({
    id,
    label: activeWorkspace?.propertyLabels?.[id] ?? id,
  }));
  const roomsFact = (rooms: number | null) =>
    rooms ? `Connected · ${rooms} ${rooms === 1 ? "room" : "rooms"}` : "";
  // A Vrbo link a manager already made keeps working and stays manageable; with none, Vrbo is not offered yet.
  const vrboRooms = counts.vrbo;

  return (
    <>
      <PortalSettingsGroup>
        {LIVE_CHANNELS.map(({ provider, name, icon, tone }) => (
          <IntegrationRow
            key={provider}
            icon={icon}
            tone={tone}
            name={name}
            fact={roomsFact(counts[provider])}
            factDataAttr={`settings-${provider}-status`}
            action={
              <Button variant="ghost" data-attr={`settings-${provider}-manage`} onClick={() => setChannelOpen(provider)}>
                {counts[provider] ? "Manage" : "Connect"}
              </Button>
            }
          />
        ))}
        <IntegrationRow
          icon={Palmtree}
          tone="text-indigo-600"
          name="Vrbo"
          comingSoon={!vrboRooms}
          fact={roomsFact(vrboRooms)}
          factDataAttr="settings-vrbo-status"
          action={
            <Button variant="ghost" data-attr="settings-vrbo-manage" onClick={() => setChannelOpen("vrbo")}>
              Manage
            </Button>
          }
        />
        {COMING_SOON_CHANNELS.map(({ id, name, icon }) => (
          <IntegrationRow key={id} icon={icon} name={name} comingSoon dataAttr={`settings-${id}-row`} />
        ))}
      </PortalSettingsGroup>
      <ChannelCalendarLinkModal
        open={channelOpen !== null}
        onClose={() => setChannelOpen(null)}
        initialProvider={channelOpen ?? undefined}
        propertyIds={activeWorkspace?.propertyIds ?? []}
        propertyOptions={propertyOptions}
        showToast={showToast}
        onChanged={() => {
          void loadChannels();
        }}
      />
    </>
  );
}
