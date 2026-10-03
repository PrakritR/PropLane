"use client";

import { useState } from "react";
import { CalendarSync } from "lucide-react";
import { ChannelCalendarLinkModal } from "@/components/portal/channel-calendar-link-modal";
import { PortalIconAction } from "@/components/portal/portal-icon-action";
import { PortalSettingsGroup, PortalSettingsRow, PortalSettingsSection } from "@/components/portal/portal-settings-ui";
import { useAppUi } from "@/components/providers/app-ui-provider";
import { useManagerUserId } from "@/hooks/use-manager-user-id";
import { buildManagerPropertyFilterOptions } from "@/lib/manager-portfolio-access";

/** The same room-calendar editor reached from Bookings, scoped to this workspace. */
export function BookingsChannelSettings() {
  const [open, setOpen] = useState(false);
  const { userId } = useManagerUserId();
  const { showToast } = useAppUi();
  const propertyOptions = buildManagerPropertyFilterOptions(userId);
  return (
    <PortalSettingsSection title="Airbnb">
      <PortalSettingsGroup>
        <PortalSettingsRow label="Room calendars">
          <PortalIconAction icon={CalendarSync} label="Connect Airbnb" data-attr="settings-connect-airbnb" disabled={!userId} onClick={() => setOpen(true)} />
        </PortalSettingsRow>
      </PortalSettingsGroup>
      <ChannelCalendarLinkModal open={open} onClose={() => setOpen(false)} propertyIds={propertyOptions.map((property) => property.id)} propertyOptions={propertyOptions} showToast={showToast} />
    </PortalSettingsSection>
  );
}
