// @vitest-environment jsdom
/**
 * PRP-385 — approving one application must not reset every other lease for that
 * manager back to Draft / strip generated documents.
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
import { transitionApplicationBucket } from "@/lib/application-review";

const MANAGER_ID = "mgr-prp-385";

function leaseRow(
  id: string,
  axisId: string,
  overrides: Partial<LeasePipelineRow> = {},
): LeasePipelineRow {
  return {
    id,
    axisId,
    residentName: `Resident ${axisId}`,
    residentEmail: `${axisId.toLowerCase()}@example.com`,
    unit: "Test House · Room 1",
    stageLabel: "Manager Review",
    updated: "Aug 1",
    bucket: "manager",
    pdfVersion: 1,
    notes: "Existing lease",
    updatedAtIso: "2026-08-01T00:00:00.000Z",
    managerUserId: MANAGER_ID,
    propertyId: "mgr-test-house",
    roomChoice: "room-1",
    thread: [],
    generatedHtml: "<html><body>EXISTING LEASE BODY</body></html>",
    managerUploadedPdf: null,
    status: "Manager Review",
    signedRentLabel: "$1,000.00 / month",
    application: { leaseStart: "2026-09-01", leaseEnd: "2027-08-31" },
    ...overrides,
  };
}

function applicationRow(
  id: string,
  bucket: DemoApplicantRow["bucket"],
  overrides: Partial<DemoApplicantRow> = {},
): DemoApplicantRow {
  return {
    id,
    name: `Applicant ${id}`,
    email: `${id.toLowerCase()}@example.com`,
    property: "Test House",
    stage: bucket === "approved" ? "Approved" : "Submitted",
    bucket,
    detail: "",
    managerUserId: MANAGER_ID,
    assignedPropertyId: "mgr-test-house",
    assignedRoomChoice: "room-1",
    signedMonthlyRent: 1000,
    application: {
      propertyId: "mgr-test-house",
      roomChoice1: "room-1",
      leaseStart: "2026-09-01",
      leaseEnd: "2027-08-31",
    },
    ...overrides,
  };
}

function resetStores() {
  window.sessionStorage.clear();
  window.localStorage.clear();
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 })),
  );
}

function leaseByAxis(axisId: string): LeasePipelineRow | undefined {
  return readLeasePipeline(MANAGER_ID).find((row) => row.axisId === axisId);
}

describe("PRP-385 — approving one application preserves sibling leases", () => {
  beforeEach(resetStores);

  it("keeps an in-review lease document when another application is approved", async () => {
    seedDemoManagerApplicationRows(
      [
        applicationRow("AXIS-EXISTING", "approved"),
        applicationRow("AXIS-PENDING", "pending"),
      ],
      MANAGER_ID,
    );
    seedDemoLeasePipeline([leaseRow("lease_existing", "AXIS-EXISTING")], MANAGER_ID);

    const before = leaseByAxis("AXIS-EXISTING");
    expect(before?.status).toBe("Manager Review");
    expect(before?.generatedHtml).toContain("EXISTING LEASE BODY");

    const result = await transitionApplicationBucket("AXIS-PENDING", "approved", {
      userId: MANAGER_ID,
    });
    expect(result?.blocked).toBeUndefined();

    const after = leaseByAxis("AXIS-EXISTING");
    expect(after?.status).toBe("Manager Review");
    expect(after?.generatedHtml).toContain("EXISTING LEASE BODY");
    expect(after?.bucket).toBe("manager");
  });

  it("keeps a resident-signature-pending lease when another application is approved", async () => {
    seedDemoManagerApplicationRows(
      [
        applicationRow("AXIS-SENT", "approved"),
        applicationRow("AXIS-PENDING2", "pending"),
      ],
      MANAGER_ID,
    );
    seedDemoLeasePipeline(
      [
        leaseRow("lease_sent", "AXIS-SENT", {
          bucket: "resident",
          status: "Resident Signature Pending",
          sentToResidentAt: "2026-08-02T00:00:00.000Z",
          stageLabel: "Resident Signature Pending",
        }),
      ],
      MANAGER_ID,
    );

    await transitionApplicationBucket("AXIS-PENDING2", "approved", { userId: MANAGER_ID });

    const after = leaseByAxis("AXIS-SENT");
    expect(after?.status).toBe("Resident Signature Pending");
    expect(after?.generatedHtml).toContain("EXISTING LEASE BODY");
    expect(after?.sentToResidentAt).toBe("2026-08-02T00:00:00.000Z");
  });

  it("keeps a fully signed lease when another application is approved", async () => {
    seedDemoManagerApplicationRows(
      [
        applicationRow("AXIS-SIGNED", "approved"),
        applicationRow("AXIS-PENDING3", "pending"),
      ],
      MANAGER_ID,
    );
    seedDemoLeasePipeline(
      [
        leaseRow("lease_signed", "AXIS-SIGNED", {
          bucket: "signed",
          status: "Fully Signed",
          fullySignedAt: "2026-08-03T00:00:00.000Z",
          managerSignature: { role: "manager", name: "Manager", signedAtIso: "2026-08-03T00:00:00.000Z" },
          residentSignature: { role: "resident", name: "Resident", signedAtIso: "2026-08-03T00:00:00.000Z" },
          stageLabel: "Signed",
        }),
      ],
      MANAGER_ID,
    );

    await transitionApplicationBucket("AXIS-PENDING3", "approved", { userId: MANAGER_ID });

    const after = leaseByAxis("AXIS-SIGNED");
    expect(after?.status).toBe("Fully Signed");
    expect(after?.generatedHtml).toContain("EXISTING LEASE BODY");
    expect(after?.fullySignedAt).toBe("2026-08-03T00:00:00.000Z");
  });

  it("syncLeasePipelineFromApplications alone does not downgrade sibling leases", () => {
    seedDemoManagerApplicationRows(
      [applicationRow("AXIS-KEEP", "approved"), applicationRow("AXIS-NEW", "approved")],
      MANAGER_ID,
    );
    seedDemoLeasePipeline(
      [
        leaseRow("lease_keep", "AXIS-KEEP", {
          bucket: "resident",
          status: "Resident Signature Pending",
          sentToResidentAt: "2026-08-02T00:00:00.000Z",
        }),
      ],
      MANAGER_ID,
    );

    // Simulate the post-approval hook without a lease row for the newly approved app yet.
    writeManagerApplicationRows(readManagerApplicationRows());
    syncLeasePipelineFromApplications(MANAGER_ID);

    const kept = leaseByAxis("AXIS-KEEP");
    expect(kept?.status).not.toBe("Draft");
    expect(kept?.generatedHtml).toContain("EXISTING LEASE BODY");
  });
});
