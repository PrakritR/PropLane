/**
 * The inbound events of the homepage Software demo's journey: a text arriving, a tour booked, an application, a
 * payment, a signature, a vendor's YES. Each is a write through the same store writers the portal uses, in demo
 * mode (no server mirror), so the real panels re-render from their own subscriptions. Only the embed imports this
 * file.
 */
import type { DemoApplicantRow, DemoManagerWorkOrderRow } from "@/data/demo-portal";
import { HOME_DEMO_PHOTOS, type HomeDemoEffect } from "@/components/demo/home-demo-script";
import { DISCOVERY_TOUR } from "@/components/marketing/home-discovery-script";
import { seedDemoScheduleData, readPlannedEvents, type PlannedEvent } from "@/lib/demo-admin-scheduling";
import {
  HOME_DEMO_PROPERTY_IDS,
  HOME_DEMO_TOUR_INQUIRY_ID,
  HOME_DEMO_VENDOR_NAME,
  HOME_DEMO_VENDOR_WORK_ORDER_ID,
  homeDemoOtherThreads,
  homeDemoProspectThread,
  homeDemoResidentProspectThread,
  homeDemoTourWindow,
} from "@/lib/demo/demo-guided-data";
import {
  HOME_DEMO_JORDAN,
  homeDemoJordanApplication,
  homeDemoJordanCharges,
  homeDemoJordanLease,
  homeDemoJordanService,
} from "@/lib/demo/home-demo-journey-data";
import { DEMO_MANAGER_USER_ID } from "@/lib/demo/demo-session";
import { readHouseholdCharges, seedDemoHouseholdCharges } from "@/lib/household-charges";
import { readLeasePipeline, seedDemoLeasePipeline } from "@/lib/lease-pipeline-storage";
import { readManagerApplicationRows, seedDemoManagerApplicationRows } from "@/lib/manager-applications-storage";
import { readManagerWorkOrderRows, updateManagerWorkOrder, writeManagerWorkOrderRows } from "@/lib/manager-work-orders-storage";
import { MANAGER_INBOX_STORAGE_KEY, RESIDENT_INBOX_STORAGE_KEY, seedDemoInbox } from "@/lib/portal-inbox-storage";

const VENDOR_ID = "demo-vendor-pacific-plumbing";
/** The calendar event and the prospect's Tour row are one booking: the same id. */
const HOME_DEMO_TOUR_EVENT_ID = HOME_DEMO_TOUR_INQUIRY_ID;

/** One run's clock, so the thread's stamps stay put while the journey adds lines to it. */
export type HomeDemoEffectContext = { nowMs: number };

function withoutJordan<T extends { id: string }>(rows: T[], id: string): T[] {
  return rows.filter((row) => row.id !== id);
}

function setApplication(row: DemoApplicantRow): void {
  // Last, so it wins when the store folds rows that normalise to the same id (the stored one has the older stage).
  seedDemoManagerApplicationRows([...withoutJordan(readManagerApplicationRows(), row.id), row], DEMO_MANAGER_USER_ID);
}

export function applyHomeDemoEffect(effect: HomeDemoEffect, ctx: HomeDemoEffectContext): void {
  switch (effect.id) {
    case "thread": {
      // One conversation, two sides: the manager's inbox and the prospect's own (resident portal) inbox.
      seedDemoInbox(MANAGER_INBOX_STORAGE_KEY, [homeDemoProspectThread(effect.lines, ctx.nowMs), ...homeDemoOtherThreads(ctx.nowMs)]);
      seedDemoInbox(RESIDENT_INBOX_STORAGE_KEY, [homeDemoResidentProspectThread(effect.lines, ctx.nowMs)]);
      return;
    }
    case "tour": {
      const { start, end } = homeDemoTourWindow();
      const event: PlannedEvent = {
        id: HOME_DEMO_TOUR_EVENT_ID,
        title: `Tour · ${DISCOVERY_TOUR.street}`,
        start,
        end,
        kind: "tour",
        managerUserId: DEMO_MANAGER_USER_ID,
        propertyId: HOME_DEMO_PROPERTY_IDS.willow,
        propertyTitle: "Willow Court",
        attendeeName: HOME_DEMO_JORDAN.name,
        attendeeEmail: HOME_DEMO_JORDAN.email,
        notes: "",
      };
      seedDemoScheduleData({ plannedEvents: [...readPlannedEvents().filter((e) => e.id !== HOME_DEMO_TOUR_EVENT_ID), event] });
      return;
    }
    case "applicationSubmit":
      setApplication(homeDemoJordanApplication("submitted"));
      return;
    case "applicationApprove":
      setApplication(homeDemoJordanApplication("approved"));
      return;
    case "chargesCreate":
    case "chargesPay": {
      const mine = homeDemoJordanCharges(effect.id === "chargesPay" ? "paid" : "pending", ctx.nowMs);
      const mineIds = new Set(mine.map((charge) => charge.id));
      seedDemoHouseholdCharges([...mine, ...readHouseholdCharges().filter((charge) => !mineIds.has(charge.id))]);
      return;
    }
    case "leaseSend":
    case "leaseSign": {
      const row = homeDemoJordanLease(effect.id === "leaseSign" ? "signed" : "sent", ctx.nowMs);
      seedDemoLeasePipeline([row, ...withoutJordan(readLeasePipeline(DEMO_MANAGER_USER_ID), row.id)], DEMO_MANAGER_USER_ID);
      return;
    }
    case "serviceRequest": {
      const row = homeDemoJordanService(HOME_DEMO_PHOTOS.leak);
      writeManagerWorkOrderRows([row, ...withoutJordan(readManagerWorkOrderRows(), row.id)], { mirror: false });
      return;
    }
    case "offer": {
      updateManagerWorkOrder(HOME_DEMO_VENDOR_WORK_ORDER_ID, (row) => ({
        ...row,
        vendorId: VENDOR_ID,
        vendorName: HOME_DEMO_VENDOR_NAME,
        biddingOpen: true,
      }));
      return;
    }
    case "assign": {
      updateManagerWorkOrder(HOME_DEMO_VENDOR_WORK_ORDER_ID, (row): DemoManagerWorkOrderRow => ({
        ...row,
        status: "Assigned",
        // The vendor said yes: the offer is answered, so on the vendor's side it leaves Open for Assigned.
        biddingOpen: false,
        vendorId: VENDOR_ID,
        vendorName: HOME_DEMO_VENDOR_NAME,
        vendorAssignedAt: new Date().toISOString(),
        assignee: { type: "vendor", id: VENDOR_ID, name: HOME_DEMO_VENDOR_NAME },
      }));
      return;
    }
  }
}
