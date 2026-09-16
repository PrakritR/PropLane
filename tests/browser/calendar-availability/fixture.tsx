import React from "react";
import { createRoot } from "react-dom/client";
import { PortalCalendarPanels } from "../../../src/components/portal/portal-calendar-panels";
import { startOfWeekMonday, toLocalDateStr, writeAvailabilityDateSetForStorageKey } from "../../../src/lib/demo-admin-scheduling";
import { resolveDefaultTourAvailabilityConfig } from "../../../src/lib/tour-slot-math";

// Paint NEXT week's Monday 10:00-11:30 (slots 20-22) and Wednesday 14:00-15:00
// (28-29) for tours under the fixture storage key before the panel mounts.
// Next week so no painted day is already in the past (past slots are not open).
const STORAGE_KEY = "axis_mgr_avail_slots_v2_fixture";
const nextWeek = new Date();
nextWeek.setDate(nextWeek.getDate() + 7);
const monday = startOfWeekMonday(nextWeek);
const wednesday = new Date(monday);
wednesday.setDate(monday.getDate() + 2);
const mondayDs = toLocalDateStr(monday);
const wednesdayDs = toLocalDateStr(wednesday);
const painted = [`${mondayDs}:20`, `${mondayDs}:21`, `${mondayDs}:22`, `${wednesdayDs}:28`, `${wednesdayDs}:29`];
writeAvailabilityDateSetForStorageKey(new Set(painted), STORAGE_KEY);
(window as unknown as { __fixture: unknown }).__fixture = { mondayDs, wednesdayDs, painted };

function Fixture() {
  return (
    <main style={{ padding: 16, background: "var(--background)" }}>
      <PortalCalendarPanels
        storageKey={STORAGE_KEY}
        compactAvailability
        bareSurface
        availabilityHeading="Tour availability"
        defaultTourAvailability={resolveDefaultTourAvailabilityConfig({ enabled: false })}
        anchorDate={monday}
      />
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<Fixture />);
