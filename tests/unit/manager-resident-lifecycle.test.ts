import { describe, expect, it } from "vitest";
import { buildResidentLifecycle, formatResidentShortDate } from "@/lib/manager-resident-lifecycle";

const hrefs = {
  application: "/portal/residents/potential/a/application",
  backgroundCheck: "/portal/residents/potential/a/background-check",
  lease: "/portal/residents/potential/a/lease",
  payments: "/portal/residents/potential/a/payments",
  tours: "/portal/residents/potential/a/tours",
  inspections: "/portal/residents/potential/a/inspections",
  services: "/portal/residents/potential/a/services",
};

describe("manager-resident-lifecycle", () => {
  it("formats same-year dates without the year", () => {
    const year = new Date().getUTCFullYear();
    expect(formatResidentShortDate(`${year}-09-26`)).toMatch(/Sep 26/);
    expect(formatResidentShortDate("2027-02-28")).toContain("2027");
  });

  it("omits reminder-style next steps for lease_sent waiting on resident", () => {
    const snap = buildResidentLifecycle(
      {
        directoryStage: "potential",
        application: {
          id: "app-1",
          name: "Casey",
          email: "c@example.com",
          property: "House",
          bucket: "approved",
          axisId: "AXIS-1",
          application: { submittedAt: "2026-01-01" },
        },
        leaseRows: [
          {
            id: "l1",
            residentName: "Casey",
            residentEmail: "c@example.com",
            unit: "R1",
            stageLabel: "Out for signature",
            updated: "",
            bucket: "resident",
            pdfVersion: 1,
            notes: "",
            updatedAtIso: "",
            sentToResidentAt: "2026-01-02",
            thread: [],
          },
        ],
        ledgerRows: [],
        hasPortalAccount: true,
      },
      hrefs,
    );
    expect(snap.next).toBeNull();
    expect(snap.todo.some((t) => t.title.includes("waiting for the resident"))).toBe(true);
  });
});
