"use client";

import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { ManagerPortalSettingsModal } from "@/components/portal/manager-portal-settings-modal";
import { PortalCalendarPanels } from "@/components/portal/portal-calendar-panels";
import {
  PORTAL_PROPERTY_DETAIL_ACTION_BUTTON_CLASS,
  PropertyDetailFooterActions,
  PortalPropertyDetailSection,
} from "@/components/portal/portal-property-detail-section";
import { Button } from "@/components/ui/button";
import {
  managerPropertyAvailabilityStorageKey,
  readAvailabilityDateSetForStorageKey,
  syncScheduleRecordsFromServer,
  writeAvailabilityDateSetForStorageKeyToServer,
} from "@/lib/demo-admin-scheduling";
import { buildManagerPropertyFilterOptions } from "@/lib/manager-portfolio-access";
import {
  isGoogleBusyIncompleteWarning,
  useGoogleCalendarBusyMeetings,
} from "@/hooks/use-google-calendar-busy";

import { resolveDefaultTourAvailabilityConfig } from "@/lib/tour-slot-math";

const NO_DEFAULT_TOUR_AVAILABILITY = resolveDefaultTourAvailabilityConfig({ enabled: false });

export function ManagerPropertyTourPanel({
  listingId,
  managerUserId,
  propertyLabel,
  showToast,
}: {
  listingId: string;
  managerUserId: string | null;
  propertyLabel: string;
  /**
   * REQUIRED: this panel publishes availability, so it must be able to tell the
   * manager when its conflict overlay is incomplete. Optional, it could be
   * dropped by a new call site and the warning would vanish silently.
   */
  showToast: (message: string) => void;
}) {
  const [tick, setTick] = useState(0);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [calendarFooterActions, setCalendarFooterActions] = useState<ReactNode>(null);

  const refresh = useCallback(async () => {
    await syncScheduleRecordsFromServer({ force: true });
    setTick((n) => n + 1);
  }, []);

  useEffect(() => {
    if (!managerUserId) return;
    void refresh();
  }, [managerUserId, refresh]);

  useEffect(() => {
    const onStorage = () => setTick((n) => n + 1);
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  const storageKey = useMemo(() => {
    void tick;
    if (!managerUserId || !listingId) return null;
    return managerPropertyAvailabilityStorageKey(managerUserId, listingId);
  }, [tick, managerUserId, listingId]);

  const otherProperties = useMemo(() => {
    void tick;
    if (!managerUserId) return undefined;
    const options = buildManagerPropertyFilterOptions(managerUserId)
      .filter((p) => p.id !== listingId)
      .map((p) => ({ id: p.id, name: p.label }));
    return options.length > 0 ? options : undefined;
  }, [tick, managerUserId, listingId]);

  const handleCopyWeekToHouses = useCallback(
    (propertyIds: string[], weekDateStrs: string[], scope: "week" | "entire") => {
      if (!managerUserId || !listingId || !storageKey) return;
      const srcSlots = readAvailabilityDateSetForStorageKey(storageKey);
      const weekStrs = new Set(weekDateStrs);
      const slotsToCopy =
        scope === "entire"
          ? [...srcSlots]
          : [...srcSlots].filter((key) => weekStrs.has(key.split(":")[0] ?? ""));
      void Promise.all(
        propertyIds.map((pid) => {
          const dstKey = managerPropertyAvailabilityStorageKey(managerUserId, pid);
          const dstSlots = new Set(readAvailabilityDateSetForStorageKey(dstKey));
          for (const slot of slotsToCopy) dstSlots.add(slot);
          return writeAvailabilityDateSetForStorageKeyToServer(dstSlots, dstKey);
        }),
      )
        .then((results) => {
          if (results.some((ok) => !ok)) {
            showToast("Could not save every house schedule to backend.");
          }
          return syncScheduleRecordsFromServer({ force: true });
        })
        .finally(() => setTick((n) => n + 1));
      const destNames = propertyIds
        .map((id) => otherProperties?.find((p) => p.id === id)?.name ?? id)
        .join(", ");
      showToast(
        scope === "entire"
          ? `Full schedule copied to: ${destNames}.`
          : `This week's schedule copied to: ${destNames}.`,
      );
    },
    [listingId, managerUserId, otherProperties, showToast, storageKey],
  );

  const googleBusyMeetings = useGoogleCalendarBusyMeetings({
    enabled: Boolean(managerUserId),
    onWarning: ({ warning, hint }) => {
      if (!isGoogleBusyIncompleteWarning(warning)) return;
      showToast(
        hint ??
          "PropLane could not load all your Google Calendar busy time, so this grid may be missing conflicts.",
      );
    },
  });

  return (
    <PortalPropertyDetailSection
      actions={
        <PropertyDetailFooterActions>
          <Button
            type="button"
            variant="outline"
            className={PORTAL_PROPERTY_DETAIL_ACTION_BUTTON_CLASS}
            data-attr="property-tour-settings-open"
            onClick={() => setSettingsOpen(true)}
          >
            Settings
          </Button>
          {calendarFooterActions}
        </PropertyDetailFooterActions>
      }
    >
      <div className="min-w-0 max-w-full overflow-x-clip">
      <PortalCalendarPanels
        key={storageKey ?? "property-calendar-unavailable"}
        storageKey={storageKey}
        bareSurface
        compactAvailability
        defaultViewMode="week"
        flowScroll
        delegateFooterToModal
        onModalFooterChange={setCalendarFooterActions}
        availabilityHeading="Tour availability"
        defaultTourAvailability={NO_DEFAULT_TOUR_AVAILABILITY}
        tourScopeLabel={propertyLabel}
        unavailableMessage="Sign in to manage tour availability for this property."
        externalMeetings={googleBusyMeetings}
        otherProperties={otherProperties}
        onCopyWeekToHouses={managerUserId && storageKey ? handleCopyWeekToHouses : undefined}
        scheduledTourFilter={
          managerUserId
            ? {
                viewerUserId: managerUserId,
                propertyId: listingId,
                peers: [],
              }
            : undefined
        }
      />
      </div>
      <ManagerPortalSettingsModal
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        initialTab="tours"
        scoped
        scopedTitle="Tours"
      />
    </PortalPropertyDetailSection>
  );
}
