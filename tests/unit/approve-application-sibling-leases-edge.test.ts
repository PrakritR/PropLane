// @vitest-environment jsdom
/**
 * PRP-385 edge cases — scope mismatch and email-collision paths that could
 * have caused sibling leases to reset.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DemoApplicantRow } from "@/data/demo-portal";
import {
  readManagerApplicationRows,
  seedDemoManagerApplicationRows,
  writeManagerApplicationRows,
} from "@/lib/manager-applications-storage";
import {
  readLeasePipeline,
  seedDemoLeasePipeline,
  syncLeasePipelineFromApplications,
  type LeasePipelineRow,
} from "@/lib/lease-pipeline-storage";

const MANAGER_ID = "mgr-prp-385-edge";

function leaseRow(overrides: Partial<LeasePipelineRow> & Pick<LeasePipelineRow, "id" | "axisId">): LeasePipelineRow {
  return {
    residentName: "Resident",
    residentEmail: `${overrides.axisId.toLowerCase()}@example.com`,
    unit: "House A · Room 1",
    stageLabel: "Manager Review",
    updated: "Aug 1",
    bucket: "manager",
    pdfVersion: 1,
    notes: "",
    updatedAtIso: "2026-08-01T00:00:00.000Z",
    managerUserId: MANAGER_ID,
    propertyId: "mgr-a",
    roomChoice: "room-1",
    thread: [],
    generatedHtml: "<html><body>LEASE</body></html>",
    managerUploadedPdf: null,
    status: "Manager Review",
    ...overrides,
  };
}

function app(
  id: string,
  bucket: DemoApplicantRow["bucket"],
  overrides: Partial<DemoApplicantRow> = {},
): DemoApplicantRow {
  return {
    id,
    name: id,
    email: `${id.toLowerCase()}@example.com`,
    property: "House A",
    stage: bucket === "approved" ? "Approved" : "Submitted",
    bucket,
    detail: "",
    managerUserId: MANAGER_ID,
    assignedPropertyId: "mgr-a",
    assignedRoomChoice: "room-1",
    application: { propertyId: "mgr-a", roomChoice1: "room-1" },
    ...overrides,
  };
}

beforeEach(() => {
  window.sessionStorage.clear();
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 })));
});

describe("PRP-385 edge cases", () => {
  it("does not lose scoped leases when syncLeasePipelineFromApplications runs with null scope after manager-scoped seed", () => {
    seedDemoManagerApplicationRows([app("AXIS-A", "approved"), app("AXIS-B", "pending")], MANAGER_ID);
    seedDemoLeasePipeline(
      [leaseRow({ id: "lease_a", axisId: "AXIS-A", generatedHtml: "<html><body>KEEP ME</body></html>" })],
      MANAGER_ID,
    );

    // Approve B through application write (triggers sync with activeApplicationsScopeUserId).
    writeManagerApplicationRows(
      readManagerApplicationRows().map((row) =>
        row.id === "AXIS-B" ? { ...row, bucket: "approved", stage: "Approved" } : row,
      ),
      { serverConfirmed: true },
    );

    // Force the async hook the same way writeManagerApplicationRows does.
    return import("@/lib/lease-pipeline-storage").then(({ syncLeasePipelineFromApplications }) => {
      syncLeasePipelineFromApplications(MANAGER_ID);
      const kept = readLeasePipeline(MANAGER_ID).find((r) => r.axisId === "AXIS-A");
      expect(kept?.generatedHtml).toContain("KEEP ME");
      expect(kept?.status).toBe("Manager Review");
    });
  });

  it("does not collapse two leases that share email but differ by property when approving a third app", () => {
    const sharedEmail = "roommate@example.com";
    seedDemoManagerApplicationRows(
      [
        app("AXIS-P1", "approved", { email: sharedEmail, assignedPropertyId: "mgr-a", assignedRoomChoice: "room-1" }),
        app("AXIS-P2", "approved", { email: sharedEmail, assignedPropertyId: "mgr-b", assignedRoomChoice: "room-2" }),
        app("AXIS-P3", "pending"),
      ],
      MANAGER_ID,
    );
    seedDemoLeasePipeline(
      [
        leaseRow({
          id: "lease_p1",
          axisId: "AXIS-P1",
          residentEmail: sharedEmail,
          propertyId: "mgr-a",
          roomChoice: "room-1",
          generatedHtml: "<html><body>P1</body></html>",
        }),
        leaseRow({
          id: "lease_p2",
          axisId: "AXIS-P2",
          residentEmail: sharedEmail,
          propertyId: "mgr-b",
          roomChoice: "room-2",
          generatedHtml: "<html><body>P2</body></html>",
        }),
      ],
      MANAGER_ID,
    );

    writeManagerApplicationRows(
      readManagerApplicationRows().map((row) =>
        row.id === "AXIS-P3" ? { ...row, bucket: "approved", stage: "Approved" } : row,
      ),
      { serverConfirmed: true },
    );
    syncLeasePipelineFromApplications(MANAGER_ID);

    const rows = readLeasePipeline(MANAGER_ID);
    expect(rows.filter((r) => r.generatedHtml?.includes("P1"))).toHaveLength(1);
    expect(rows.filter((r) => r.generatedHtml?.includes("P2"))).toHaveLength(1);
    expect(rows.length).toBeGreaterThanOrEqual(2);
  });
});
