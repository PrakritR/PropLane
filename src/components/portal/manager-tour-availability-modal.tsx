"use client";

import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { PortalCalendarPanels } from "@/components/portal/portal-calendar-panels";
import { Modal } from "@/components/ui/modal";
import { Select } from "@/components/ui/input";
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

export function ManagerTourAvailabilityModal({
  open,
  onClose,
  managerUserId,
  propertyId,
  propertyLabel,
  propertyOptions,
  showToast,
}: {
  open: boolean;
  onClose: () => void;
  managerUserId: string | null;
  /** When set, the grid opens on this property and the picker is hidden. */
  propertyId?: string | null;
  propertyLabel?: string;
  /** Portfolio tours: pick which house to edit. Ignored when `propertyId` is set. */
  propertyOptions?: Array<{ id: string; label: string }>;
  showToast: (message: string) => void;
}) {
  const [tick, setTick] = useState(0);
  const [selectedPropertyId, setSelectedPropertyId] = useState(propertyId ?? propertyOptions?.[0]?.id ?? "");
  const [calendarFooterActions, setCalendarFooterActions] = useState<ReactNode>(null);

  const activePropertyId = propertyId ?? selectedPropertyId;
  const activePropertyLabel =
    propertyLabel ??
    propertyOptions?.find((option) => option.id === activePropertyId)?.label ??
    "this property";

  useEffect(() => {
    if (!open || propertyId) return;
    setSelectedPropertyId(propertyOptions?.[0]?.id ?? "");
  }, [open, propertyId, propertyOptions]);

  useEffect(() => {
    if (!open || !managerUserId) return;
    void syncScheduleRecordsFromServer({ force: true }).then(() => setTick((n) => n + 1));
  }, [open, managerUserId]);

  const storageKey = useMemo(() => {
    void tick;
    if (!managerUserId || !activePropertyId) return null;
    return managerPropertyAvailabilityStorageKey(managerUserId, activePropertyId);
  }, [tick, managerUserId, activePropertyId]);

  const otherProperties = useMemo(() => {
    void tick;
    if (!managerUserId || !activePropertyId) return undefined;
    const options = (propertyOptions ?? buildManagerPropertyFilterOptions(managerUserId))
      .filter((property) => property.id !== activePropertyId)
      .map((property) => ({ id: property.id, name: property.label }));
    return options.length > 0 ? options : undefined;
  }, [tick, managerUserId, activePropertyId, propertyOptions]);

  const handleCopyWeekToHouses = useCallback(
    (propertyIds: string[], weekDateStrs: string[], scope: "week" | "entire") => {
      if (!managerUserId || !activePropertyId || !storageKey) return;
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
        .map((id) => otherProperties?.find((property) => property.id === id)?.name ?? id)
        .join(", ");
      showToast(
        scope === "entire"
          ? `Full schedule copied to: ${destNames}.`
          : `This week's schedule copied to: ${destNames}.`,
      );
    },
    [activePropertyId, managerUserId, otherProperties, showToast, storageKey],
  );

  const googleBusyMeetings = useGoogleCalendarBusyMeetings({
    enabled: open && Boolean(managerUserId),
    onWarning: ({ warning, hint }) => {
      if (!isGoogleBusyIncompleteWarning(warning)) return;
      showToast(
        hint ??
          "PropLane could not load all your Google Calendar busy time, so this grid may be missing conflicts.",
      );
    },
  });

  const showPropertyPicker = !propertyId && (propertyOptions?.length ?? 0) > 1;

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Tour availability"
      description={`Publish open tour windows for ${activePropertyLabel}.`}
      panelClassName="max-w-6xl"
      scrollableContent={false}
      footer={calendarFooterActions}
      dataAttr="tour-availability-modal"
    >
      <div className="flex min-h-0 flex-1 flex-col gap-3">
        {showPropertyPicker ? (
          <div className="max-w-sm">
            <label className="mb-1 block text-sm font-medium text-foreground">Property</label>
            <Select
              value={selectedPropertyId}
              onChange={(event) => setSelectedPropertyId(event.target.value)}
              aria-label="Property for tour availability"
            >
              {(propertyOptions ?? []).map((option) => (
                <option key={option.id} value={option.id}>
                  {option.label}
                </option>
              ))}
            </Select>
          </div>
        ) : null}
        <div className="min-h-0 min-w-0 flex-1 overflow-hidden">
          <PortalCalendarPanels
            key={storageKey ?? "tour-availability-unavailable"}
            storageKey={storageKey}
            bareSurface
            compactAvailability
            embeddedInModal
            delegateFooterToModal
            onModalFooterChange={setCalendarFooterActions}
            defaultViewMode="week"
            flowScroll
            availabilityHeading="Tour availability"
            defaultTourAvailability={NO_DEFAULT_TOUR_AVAILABILITY}
            tourScopeLabel={activePropertyLabel}
            unavailableMessage="Sign in to manage tour availability."
            externalMeetings={googleBusyMeetings}
            otherProperties={otherProperties}
            onCopyWeekToHouses={managerUserId && storageKey ? handleCopyWeekToHouses : undefined}
            scheduledTourFilter={
              managerUserId && activePropertyId
                ? {
                    viewerUserId: managerUserId,
                    propertyId: activePropertyId,
                    peers: [],
                  }
                : undefined
            }
          />
        </div>
      </div>
    </Modal>
  );
}
