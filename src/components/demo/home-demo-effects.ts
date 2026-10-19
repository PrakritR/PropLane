/**
 * The inbound events of the homepage Software demo: a text arriving, a vendor's YES, a photo. Each is a write
 * through the same store writers the portal uses, in demo mode (no server mirror), so the real panels re-render
 * from their own subscriptions. Only the embed imports this file.
 */
import type { DemoManagerWorkOrderRow } from "@/data/demo-portal";
import { HOME_DEMO_PHOTOS, type HomeDemoEffect } from "@/components/demo/home-demo-script";
import { DISCOVERY_TOUR } from "@/components/marketing/home-discovery-script";
import { seedDemoScheduleData, readPlannedEvents, type PlannedEvent } from "@/lib/demo-admin-scheduling";
import {
  HOME_DEMO_PHOTO_WORK_ORDER_ID,
  HOME_DEMO_PROPERTY_IDS,
  HOME_DEMO_VENDOR_NAME,
  HOME_DEMO_VENDOR_WORK_ORDER_ID,
  homeDemoOtherThreads,
  homeDemoProspectThread,
  homeDemoTourWindow,
  homeDemoVisitIso,
} from "@/lib/demo/demo-guided-data";
import { DEMO_MANAGER_USER_ID } from "@/lib/demo/demo-session";
import { readManagerWorkOrderRows, updateManagerWorkOrder, writeManagerWorkOrderRows } from "@/lib/manager-work-orders-storage";
import { MANAGER_INBOX_STORAGE_KEY, seedDemoInbox } from "@/lib/portal-inbox-storage";

const VENDOR_ID = "demo-vendor-pacific-plumbing";
const TOUR_EVENT_ID = "home-tour-willow";

/** One run's clock, so the thread's stamps stay put while chapters add lines to it. */
export type HomeDemoEffectContext = { nowMs: number };

function assignedTo(row: DemoManagerWorkOrderRow): DemoManagerWorkOrderRow {
  return {
    ...row,
    status: "Assigned",
    vendorId: VENDOR_ID,
    vendorName: HOME_DEMO_VENDOR_NAME,
    vendorAssignedAt: new Date().toISOString(),
    assignee: { type: "vendor", id: VENDOR_ID, name: HOME_DEMO_VENDOR_NAME },
  };
}

export function applyHomeDemoEffect(effect: HomeDemoEffect, ctx: HomeDemoEffectContext): void {
  switch (effect.id) {
    case "thread": {
      seedDemoInbox(MANAGER_INBOX_STORAGE_KEY, [homeDemoProspectThread(effect.lines, ctx.nowMs), ...homeDemoOtherThreads(ctx.nowMs)]);
      return;
    }
    case "tour": {
      const { start, end } = homeDemoTourWindow();
      const event: PlannedEvent = {
        id: TOUR_EVENT_ID,
        title: `Tour · ${DISCOVERY_TOUR.street}`,
        start,
        end,
        kind: "tour",
        managerUserId: DEMO_MANAGER_USER_ID,
        propertyId: HOME_DEMO_PROPERTY_IDS.willow,
        propertyTitle: "Willow Court",
        attendeeName: "Jordan",
        attendeeEmail: "jordan.prospect@example.com",
        notes: "",
      };
      seedDemoScheduleData({ plannedEvents: [...readPlannedEvents().filter((e) => e.id !== TOUR_EVENT_ID), event] });
      return;
    }
    case "assign": {
      const id = effect.workOrder === "vendor" ? HOME_DEMO_VENDOR_WORK_ORDER_ID : HOME_DEMO_PHOTO_WORK_ORDER_ID;
      updateManagerWorkOrder(id, assignedTo);
      return;
    }
    case "schedule": {
      updateManagerWorkOrder(HOME_DEMO_VENDOR_WORK_ORDER_ID, (row) => ({
        ...row,
        status: "Scheduled",
        bucket: "scheduled",
        scheduled: "Thu 9:00 AM – 11:00 AM",
        scheduledAtIso: homeDemoVisitIso(),
      }));
      return;
    }
    case "clearServices": {
      writeManagerWorkOrderRows([], { mirror: false });
      return;
    }
    case "photoService": {
      const row: DemoManagerWorkOrderRow = {
        id: HOME_DEMO_PHOTO_WORK_ORDER_ID,
        reference: "WO-2042",
        propertyName: "Maple Duplex",
        propertyId: HOME_DEMO_PROPERTY_IDS.maple,
        propertyAddress: "1412 Maple Ct",
        unit: "Maple Duplex · Unit A",
        title: "Leaking kitchen faucet",
        priority: "Normal",
        status: "Open",
        bucket: "open",
        description: "The kitchen faucet is leaking.",
        scheduled: "",
        cost: "",
        category: "plumbing",
        managerUserId: DEMO_MANAGER_USER_ID,
        residentName: "Dana Reyes",
        residentEmail: "dana.reyes@example.com",
        photoDataUrls: [HOME_DEMO_PHOTOS.leak],
      };
      writeManagerWorkOrderRows([row, ...readManagerWorkOrderRows().filter((r) => r.id !== row.id)], { mirror: false });
      return;
    }
    case "complete": {
      updateManagerWorkOrder(HOME_DEMO_PHOTO_WORK_ORDER_ID, (row) => ({
        ...assignedTo(row),
        status: "Completed",
        bucket: "completed",
        scheduled: "Today",
        scheduledAtIso: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
        completedAt: new Date().toISOString(),
        workDoneSummary: "Replaced the faucet cartridge.",
        photoDataUrls: [...(row.photoDataUrls ?? []), HOME_DEMO_PHOTOS.fixed],
      }));
      return;
    }
  }
}
