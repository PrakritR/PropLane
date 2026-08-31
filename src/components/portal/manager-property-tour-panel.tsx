"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { PortalCalendarPanels } from "@/components/portal/portal-calendar-panels";
import { PortalPropertyDetailSection } from "@/components/portal/portal-property-detail-section";
import {
  managerPropertyAvailabilityStorageKey,
  readAvailabilityDateSetForStorageKey,
  syncScheduleRecordsFromServer,
  writeAvailabilityDateSetForStorageKeyToServer,
} from "@/lib/demo-admin-scheduling";
import { isDemoModeActive } from "@/lib/demo/demo-session";
import { buildManagerPropertyFilterOptions } from "@/lib/manager-portfolio-access";
import {
  DEFAULT_MANAGER_TOUR_SETTINGS,
  managerTourSettingsToDefaultAvailability,
  type ManagerTourSettings,
} from "@/lib/manager-tour-settings";
import {
  isGoogleBusyIncompleteWarning,
  useGoogleCalendarBusyMeetings,
} from "@/hooks/use-google-calendar-busy";

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
  const [tourSettings, setTourSettings] = useState<ManagerTourSettings>(DEFAULT_MANAGER_TOUR_SETTINGS);

  const loadTourSettings = useCallback(async () => {
    if (!managerUserId || isDemoModeActive()) {
      setTourSettings(DEFAULT_MANAGER_TOUR_SETTINGS);
      return;
    }
    try {
      const res = await fetch("/api/portal/manager-tour-settings", {
        credentials: "include",
        cache: "no-store",
      });
      const body = (await res.json().catch(() => ({}))) as { settings?: ManagerTourSettings };
      if (res.ok && body.settings) setTourSettings(body.settings);
    } catch {
      /* keep prior */
    }
  }, [managerUserId]);

  useEffect(() => {
    void loadTourSettings();
  }, [loadTourSettings]);

  const persistTourSettings = useCallback(
    async (next: ManagerTourSettings) => {
      setTourSettings(next);
      if (!managerUserId || isDemoModeActive()) return;
      try {
        const res = await fetch("/api/portal/manager-tour-settings", {
          method: "PATCH",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(next),
        });
        if (!res.ok) {
          showToast("Could not save tour default settings.");
          void loadTourSettings();
        }
      } catch {
        showToast("Could not save tour default settings.");
        void loadTourSettings();
      }
    },
    [loadTourSettings, managerUserId, showToast],
  );

  const defaultTourAvailability = useMemo(
    () => managerTourSettingsToDefaultAvailability(tourSettings),
    [tourSettings],
  );

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

  const handleDefaultTourHoursChange = useCallback(
    (startSlot: number, endSlotExclusive: number) => {
      void persistTourSettings({
        ...tourSettings,
        defaultTourStartSlot: startSlot,
        defaultTourEndSlotExclusive: endSlotExclusive,
      });
    },
    [persistTourSettings, tourSettings],
  );

  const handleDefaultTourGridEnabledChange = useCallback(
    (enabled: boolean) => {
      void persistTourSettings({
        ...tourSettings,
        defaultTourGridEnabled: enabled,
      });
    },
    [persistTourSettings, tourSettings],
  );

  return (
    <PortalPropertyDetailSection>
      <p className="mb-3 text-sm text-muted">
        Set when prospects can book a tour at{" "}
        <span className="font-medium text-foreground">{propertyLabel}</span>. Click an empty slot or
        drag across a range, then confirm in the schedule dialog. Use Add availability for a recurring
        block. The Default toggle and time range set fallback hours for days without painted
        availability.
      </p>
      <PortalCalendarPanels
        key={storageKey ?? "property-calendar-unavailable"}
        storageKey={storageKey}
        bareSurface
        compactAvailability
        defaultViewMode="week"
        flowScroll
        availabilityHeading="Tour availability"
        defaultTourAvailability={defaultTourAvailability}
        editableDefaultTourHours
        onDefaultTourHoursChange={handleDefaultTourHoursChange}
        onDefaultTourGridEnabledChange={handleDefaultTourGridEnabledChange}
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
    </PortalPropertyDetailSection>
  );
}
