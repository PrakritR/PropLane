import { describe, expect, it, vi } from "vitest";
import { serviceRequestsAssignedToViewer } from "@/lib/manager-task-display";

vi.mock("@/lib/manager-portfolio-access", () => ({
  moduleRowVisibleToPortalUser: () => true,
}));

vi.mock("@/lib/service-requests-storage", () => ({
  readAllServiceRequests: () => mockServiceRequests,
}));

let mockServiceRequests: Array<Record<string, unknown>> = [];

describe("serviceRequestsAssignedToViewer", () => {
  it("returns only team-assigned service orders for the viewer", () => {
    mockServiceRequests = [
      {
        id: "sr-1",
        managerUserId: "owner-1",
        propertyId: "prop-1",
        status: "approved",
        requestedAt: "2026-08-01T12:00:00.000Z",
        assignee: { type: "team", id: "mgr-a", name: "Alex" },
        offerName: "Linen package",
        residentName: "Sam",
      },
      {
        id: "sr-2",
        managerUserId: "owner-1",
        propertyId: "prop-1",
        status: "pending",
        requestedAt: "2026-08-02T12:00:00.000Z",
        assignee: { type: "vendor", id: "vendor-1", name: "Vendor" },
        offerName: "Parking",
        residentName: "Pat",
      },
      {
        id: "sr-3",
        managerUserId: "owner-1",
        propertyId: "prop-1",
        status: "pending",
        requestedAt: "2026-08-03T12:00:00.000Z",
        offerName: "Unassigned",
        residentName: "Lee",
      },
    ];
    const rows = serviceRequestsAssignedToViewer("mgr-a");
    expect(rows.map((row) => row.id)).toEqual(["sr-1"]);
  });
});
