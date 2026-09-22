import { describe, expect, it } from "vitest";
import { managerWorkOrderToCalendarMeeting } from "@/lib/manager-service-calendar";
import type { DemoManagerWorkOrderRow } from "@/data/demo-portal";

describe("manager service calendar", () => {
  it("maps scheduled vendor visits and self-assigned work", () => {
    const vendorRow = {
      id: "WO-1",
      propertyName: "5257 Brooklyn",
      unit: "Room 1",
      title: "Fix sink",
      priority: "normal",
      status: "Scheduled",
      bucket: "scheduled",
      description: "",
      scheduled: "",
      cost: "",
      scheduledAtIso: "2026-08-01T17:00:00.000Z",
      vendorName: "Ace Plumbing",
      residentName: "Casey Cosigner Host",
      residentEmail: "casey.host@axis.local",
    } satisfies DemoManagerWorkOrderRow;
    const vendorMeeting = managerWorkOrderToCalendarMeeting(vendorRow);
    expect(vendorMeeting?.statusLabel).toContain("Ace Plumbing");
    expect(vendorMeeting?.name).toBe("Casey Cosigner Host");
    expect(vendorMeeting?.email).toBe("casey.host@axis.local");
    expect(vendorMeeting?.kind).toBe("service");

    const selfRow = { ...vendorRow, id: "WO-2", selfAssigned: true, vendorName: undefined };
    const selfMeeting = managerWorkOrderToCalendarMeeting(selfRow);
    expect(selfMeeting?.title).toContain("My work");
    expect(selfMeeting?.statusLabel).toBe("You");
  });
});
