import React from "react";
import { createRoot } from "react-dom/client";
import { PortalCalendarPanels } from "../../../src/components/portal/portal-calendar-panels";
import {
  managerPropertyAvailabilityStorageKey,
  startOfWeekMonday,
  toLocalDateStr,
  writeAvailabilityDateSetForStorageKey,
} from "../../../src/lib/demo-admin-scheduling";
import { managerKindAvailabilityStorageKey } from "../../../src/lib/manager-availability-kinds";
import { resolveDefaultTourAvailabilityConfig } from "../../../src/lib/tour-slot-math";

// Paint NEXT week's Monday 10:00-11:30 (slots 20-22) and Wednesday 14:00-15:00
// (28-29) for tours before the panel mounts. Next week so no painted day is
// already in the past (past slots are not open).
//
// Tour hours are stored PER HOUSE (`manager_property_availability` — the key the
// public booking route reads), which is also what the dialog writes back, so the
// fixture owns one house and keys tours off it.
const MANAGER_ID = "fixture-manager";
const PROPERTY = { id: "prop-fixture", label: "The Magnolia" };
const STORAGE_KEY = managerPropertyAvailabilityStorageKey(MANAGER_ID, PROPERTY.id);
const nextWeek = new Date();
nextWeek.setDate(nextWeek.getDate() + 7);
const monday = startOfWeekMonday(nextWeek);
const wednesday = new Date(monday);
wednesday.setDate(monday.getDate() + 2);
const mondayDs = toLocalDateStr(monday);
const wednesdayDs = toLocalDateStr(wednesday);
const painted = [`${mondayDs}:20`, `${mondayDs}:21`, `${mondayDs}:22`, `${wednesdayDs}:28`, `${wednesdayDs}:29`];
writeAvailabilityDateSetForStorageKey(new Set(painted), STORAGE_KEY);

// There are exactly three availability kinds (tours · services · tasks —
// inspections and move-ins folded into tasks). Services and tasks live under
// their own per-manager keys, never the tours key the public booking route
// reads, so paint them on their own days: Thursday 9-10 am and Friday noon-1 pm.
const SERVICES_KEY = managerKindAvailabilityStorageKey(MANAGER_ID, "services");
const TASKS_KEY = managerKindAvailabilityStorageKey(MANAGER_ID, "tasks");
const thursday = new Date(monday);
thursday.setDate(monday.getDate() + 3);
const friday = new Date(monday);
friday.setDate(monday.getDate() + 4);
const thursdayDs = toLocalDateStr(thursday);
const fridayDs = toLocalDateStr(friday);
const servicesPainted = [`${thursdayDs}:18`, `${thursdayDs}:19`];
const tasksPainted = [`${fridayDs}:24`, `${fridayDs}:25`];
writeAvailabilityDateSetForStorageKey(new Set(servicesPainted), SERVICES_KEY);
writeAvailabilityDateSetForStorageKey(new Set(tasksPainted), TASKS_KEY);

/** Availability is shared with everyone in the workspace who has calendar access. */
const PEERS = [
  { userId: MANAGER_ID, label: "You", isSelf: true, slots: painted, kindSlots: { services: servicesPainted, tasks: tasksPainted } },
  { userId: "peer-jules", label: "Jules Park", isSelf: false, slots: [], kindSlots: { services: [], tasks: [] } },
];

(window as unknown as { __fixture: unknown }).__fixture = {
  toursKey: STORAGE_KEY,
  servicesKey: SERVICES_KEY,
  tasksKey: TASKS_KEY,
  mondayDs,
  wednesdayDs,
  thursdayDs,
  fridayDs,
  painted,
  servicesPainted,
  tasksPainted,
};

function Fixture() {
  return (
    <main style={{ padding: 16, background: "var(--background)" }}>
      <PortalCalendarPanels
        storageKey={STORAGE_KEY}
        compactAvailability
        bareSurface
        availabilityHeading="Tour availability"
        defaultTourAvailability={resolveDefaultTourAvailabilityConfig({ enabled: false })}
        availabilityKeysByKind={{ tours: [STORAGE_KEY], services: [SERVICES_KEY], tasks: [TASKS_KEY] }}
        coManagerPeers={PEERS}
        scheduleTourPropertyOptions={[PROPERTY]}
        studioGrid
        anchorDate={monday}
      />
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<Fixture />);
