import { describe, expect, it } from "vitest";
import type { DemoApplicantRow } from "@/data/demo-portal";
import { isResidentDirectoryRow, residentDirectoryStage } from "@/lib/current-resident";
import {
  RESIDENT_DIRECTORY_TABS,
  parseResidentsTab,
  residentDetailTabsForStage,
} from "@/lib/portal-detail-routes";

function row(overrides: Partial<DemoApplicantRow> = {}): DemoApplicantRow {
  return {
    id: "PROPLANE-TEST",
    name: "Test Person",
    email: "person@example.com",
    property: "Test Property",
    bucket: "pending",
    stage: "Submitted",
    ...overrides,
  };
}

const unsigned = { leaseExecuted: false };
const signed = { leaseExecuted: true };

describe("residentDirectoryStage", () => {
  it("keeps an unfinished application in the directory as a prospect", () => {
    const draft = row({ stage: "In progress" });
    // The old directory predicate dropped drafts entirely, which is why an
    // incomplete application had nowhere for the manager to chase it.
    expect(isResidentDirectoryRow(draft)).toBe(true);
    expect(residentDirectoryStage(draft, unsigned)).toBe("potential");
  });

  it("keeps a submitted application a prospect — submitting is not moving in", () => {
    expect(residentDirectoryStage(row(), unsigned)).toBe("potential");
  });

  it("keeps an APPROVED application a prospect until the lease is executed", () => {
    const approved = row({ bucket: "approved", stage: "Active" });
    expect(residentDirectoryStage(approved, unsigned)).toBe("potential");
    expect(residentDirectoryStage(approved, signed)).toBe("current");
  });

  it("treats a manually onboarded resident as current with no lease on file", () => {
    expect(
      residentDirectoryStage(row({ bucket: "approved", stage: "Active", manuallyAdded: true }), unsigned),
    ).toBe("current");
  });

  it("sends a moved-out resident to past, signed or not", () => {
    const movedOut = row({
      bucket: "approved",
      stage: "Moved out",
      manualResidentDetails: { moveOutDate: "2020-01-01" },
    });
    expect(residentDirectoryStage(movedOut, signed)).toBe("past");
    expect(residentDirectoryStage(movedOut, unsigned)).toBe("past");
  });

  it("never files a rejected application anywhere in the directory", () => {
    expect(isResidentDirectoryRow(row({ bucket: "rejected" }))).toBe(false);
  });
});

describe("parseResidentsTab", () => {
  it("reads the three stages and still answers the legacy segment", () => {
    expect(parseResidentsTab("potential")).toBe("potential");
    expect(parseResidentsTab("current")).toBe("current");
    expect(parseResidentsTab("past")).toBe("past");
    expect(parseResidentsTab("previous")).toBe("past");
    expect(parseResidentsTab(undefined)).toBe("current");
    expect(parseResidentsTab("nonsense")).toBe("current");
  });
});

describe("residentDetailTabsForStage", () => {
  it("gives a prospect Tours but no Services", () => {
    const tabs = residentDetailTabsForStage("potential");
    expect(tabs).toContain("tours");
    expect(tabs).toContain("application");
    expect(tabs).toContain("lease");
    expect(tabs).toContain("communication");
    expect(tabs).not.toContain("services");
  });

  it("takes Tours off a tenant and leaves everything else", () => {
    for (const stage of ["current", "past"] as const) {
      const tabs = residentDetailTabsForStage(stage);
      expect(tabs).not.toContain("tours");
      expect(tabs).toContain("services");
      expect(tabs).toContain("payments");
      expect(tabs).toContain("inspections");
      expect(tabs).toContain("communication");
    }
  });

  it("covers every directory stage", () => {
    for (const stage of RESIDENT_DIRECTORY_TABS) {
      expect(residentDetailTabsForStage(stage).length).toBeGreaterThan(0);
    }
  });
});

describe("leaseIsFullyExecuted", () => {
  type Row = Parameters<typeof import("@/lib/lease-pipeline-storage").leaseIsFullyExecuted>[0];

  function lease(overrides: Partial<Row> = {}): Row {
    return {
      id: "lease-1",
      residentName: "Test Person",
      residentEmail: "person@example.com",
      unit: "Room 1",
      stageLabel: "Draft",
      updated: "today",
      bucket: "drafts",
      pdfVersion: 1,
      notes: "",
      updatedAtIso: "2026-01-01T00:00:00.000Z",
      thread: [],
      ...overrides,
    } as Row;
  }

  it("is false while only one party has signed — an offer is not a tenancy", async () => {
    const { leaseIsFullyExecuted } = await import("@/lib/lease-pipeline-storage");
    expect(
      leaseIsFullyExecuted(
        lease({ managerSignature: { name: "Manager", signedAtIso: "2026-01-02T00:00:00.000Z" } }),
      ),
    ).toBe(false);
  });

  it("is true on both signatures, on Fully Signed, and on an off-platform filing", async () => {
    const { leaseIsFullyExecuted } = await import("@/lib/lease-pipeline-storage");
    expect(
      leaseIsFullyExecuted(
        lease({
          managerSignature: { name: "Manager", signedAtIso: "2026-01-02T00:00:00.000Z" },
          residentSignature: { name: "Resident", signedAtIso: "2026-01-03T00:00:00.000Z" },
        }),
      ),
    ).toBe(true);
    expect(leaseIsFullyExecuted(lease({ status: "Fully Signed" }))).toBe(true);
    expect(leaseIsFullyExecuted(lease({ externallySignedLease: true }))).toBe(true);
  });

  it("is false once the lease is voided, however it was signed", async () => {
    const { leaseIsFullyExecuted } = await import("@/lib/lease-pipeline-storage");
    expect(
      leaseIsFullyExecuted(
        lease({ fullySignedAt: "2026-01-03T00:00:00.000Z", voidedAt: "2026-02-01T00:00:00.000Z" }),
      ),
    ).toBe(false);
  });
});
