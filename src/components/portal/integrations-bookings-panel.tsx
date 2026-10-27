"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Building2, CalendarPlus, ExternalLink, House, Palmtree, Plus, UsersRound } from "lucide-react";

import { ChannelCalendarLinkModal } from "@/components/portal/channel-calendar-link-modal";
import { IntegrationRow } from "@/components/portal/integration-row";
import { useAppUi } from "@/components/providers/app-ui-provider";
import { PortalSettingsGroup } from "@/components/portal/portal-settings-ui";
import { useWorkspaces } from "@/components/portal/workspace-provider";
import { PortalIconAction } from "@/components/portal/portal-icon-action";
import { Button } from "@/components/ui/button";
import { fetchManagerChannelBookings } from "@/lib/channel-calendar/client";
import { channelRowFact } from "@/lib/channel-calendar/channel-row-fact";
import { channelCalendarUnits } from "@/lib/channel-calendar/property-units";
import type { ChannelCalendarProvider, ManagerChannelBookingProperty } from "@/lib/channel-calendar/types";

type ChannelCounts = Record<ChannelCalendarProvider, number | null>;
type ChannelSyncs = Record<ChannelCalendarProvider, string | null>;

/** Channels that connect today; their rows open the one-page Connect popup. */
const LIVE_CHANNELS = [
  { provider: "airbnb", name: "Airbnb", icon: House, tone: "text-rose-500" },
  { provider: "booking_com", name: "Booking.com", icon: Building2, tone: "text-blue-600" },
] as const;

/** PadSplit's host dashboard. PadSplit has no calendar feed and no API, so this is a plain link, never a connection. */
export const PADSPLIT_HOST_URL = "https://www.padsplit.com/host";

/** What the Other calendar row says before any site is linked: the sites people reach for first. */
const OTHER_CALENDAR_HINT = "Houfy, Furnished Finder, Vrbo, any .ics";

const EMPTY_COUNTS: ChannelCounts = { airbnb: null, booking_com: null, vrbo: null, ical: null };
const EMPTY_SYNCS: ChannelSyncs = { airbnb: null, booking_com: null, vrbo: null, ical: null };

/** Settings → Integrations → Bookings: the channels whose calendars PropLane syncs. */
export function ManagerBookingChannelsPanel() {
  const { showToast } = useAppUi();
  const workspaceCtx = useWorkspaces();
  const activeWorkspace = workspaceCtx?.active ?? null;
  const [channelOpen, setChannelOpen] = useState<ChannelCalendarProvider | null>(null);
  const [counts, setCounts] = useState<ChannelCounts>(EMPTY_COUNTS);
  // The rooms and links this panel already loaded; the Connect popup opens from them instead of
  // waiting on a read of its own (and refreshes behind itself).
  const [loaded, setLoaded] = useState<ManagerChannelBookingProperty[] | null>(null);
  const [icalSites, setIcalSites] = useState<string[]>([]);
  // Every scoped property, drafts included: a draft can still hold a channel
  // link that is syncing, and this panel is the only place to unlink it.
  const scopedIds = useMemo(() => activeWorkspace?.propertyIds ?? [], [activeWorkspace]);
  const [syncs, setSyncs] = useState<ChannelSyncs>(EMPTY_SYNCS);
  const propertyKey = scopedIds.join(",");

  const loadChannels = useCallback(async () => {
    const ids = propertyKey.split(",").filter(Boolean);
    if (!ids.length) {
      setCounts({ airbnb: 0, booking_com: 0, vrbo: 0, ical: 0 });
      setLoaded([]);
      return;
    }
    try {
      // Rooms and links only: the stored stays are for the Bookings calendar and are what made this read slow.
      const properties = await fetchManagerChannelBookings(ids, { slim: true });
      setLoaded(properties);
      const count = (provider: ChannelCalendarProvider) =>
        new Set(
          properties.flatMap((p) =>
            p.rooms
              .filter((r) => r.provider === provider && r.hasImportUrl)
              // An Other calendar link is one per site, so a room linked to two sites counts twice.
              .map((r) => `${p.propertyId}:${r.roomId}${provider === "ical" ? `:${(r.label ?? "").toLowerCase()}` : ""}`),
          ),
        ).size;
      setCounts({ airbnb: count("airbnb"), booking_com: count("booking_com"), vrbo: count("vrbo"), ical: count("ical") });
      setIcalSites([
        ...new Set(
          properties.flatMap((p) => p.rooms.filter((r) => r.provider === "ical" && r.hasImportUrl && r.label?.trim()).map((r) => r.label!.trim())),
        ),
      ]);
      const latest = (provider: ChannelCalendarProvider) =>
        properties
          .flatMap((p) => p.rooms.filter((r) => r.provider === provider && r.hasImportUrl && r.lastSyncedAt).map((r) => r.lastSyncedAt as string))
          .sort()
          .at(-1) ?? null;
      setSyncs({ airbnb: latest("airbnb"), booking_com: latest("booking_com"), vrbo: latest("vrbo"), ical: latest("ical") });
    } catch {
      showToast("Could not load channel connections.");
    }
  }, [propertyKey, showToast]);
  useEffect(() => {
    void loadChannels();
  }, [loadChannels]);

  const propertyOptions = scopedIds.map((id) => ({
    id,
    label: activeWorkspace?.propertyLabels?.[id] ?? id,
  }));
  const totalUnits = scopedIds.reduce((sum, id) => sum + channelCalendarUnits(id, activeWorkspace?.propertyLabels?.[id] ?? id).length, 0);
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
            fact={channelRowFact({ linked: counts[provider] ?? 0, total: totalUnits, lastSyncedAt: syncs[provider] })}
            factDataAttr={`settings-${provider}-status`}
            action={
              <Button variant="ghost" data-attr={`settings-${provider}-manage`} onClick={() => setChannelOpen(provider)}>
                {counts[provider] && counts[provider] >= totalUnits ? "Manage" : "Connect"}
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
        <IntegrationRow
          icon={UsersRound}
          tone="text-violet-600"
          name="PadSplit"
          fact="Manual · approve each booking in PadSplit"
          factDataAttr="settings-padsplit-status"
          dataAttr="settings-padsplit-row"
          action={<PortalIconAction icon={ExternalLink} label="Open PadSplit" data-attr="settings-padsplit-open" onClick={() => window.open(PADSPLIT_HOST_URL, "_blank", "noopener,noreferrer")} />}
        />
        <IntegrationRow
          icon={CalendarPlus}
          tone="text-emerald-600"
          name="Other calendar"
          fact={counts.ical ? `Connected · ${counts.ical} ${counts.ical === 1 ? "link" : "links"} · ${icalSites.join(", ")}` : OTHER_CALENDAR_HINT}
          factDataAttr="settings-ical-status"
          action={<PortalIconAction icon={Plus} label="Connect an Other calendar" data-attr="settings-ical-manage" onClick={() => setChannelOpen("ical")} />}
        />
      </PortalSettingsGroup>
      <ChannelCalendarLinkModal
        open={channelOpen !== null}
        onClose={() => setChannelOpen(null)}
        initialProvider={channelOpen ?? undefined}
        initialConnections={loaded ?? undefined}
        propertyIds={scopedIds}
        propertyOptions={propertyOptions}
        showToast={showToast}
        onChanged={() => {
          void loadChannels();
        }}
      />
    </>
  );
}
