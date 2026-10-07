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

  // One blue button that does the next thing (Review application → Send lease → Remind to sign / Sign lease →
  // View payments); the first two open the Approve popup and the Send lease screen directly.
  it("offers Remind to sign while the lease waits on the resident", () => {
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
    expect(snap.next).toMatchObject({ kind: "callback", label: "Remind to sign", actionId: "remind-sign" });
    expect(snap.next?.description).toMatch(/^Lease sent Jan 2/);
    expect(snap.todo.some((t) => t.title.includes("waiting for the resident"))).toBe(true);
  });

  const app = (bucket: "pending" | "approved") => ({
    id: "app-1",
    name: "Casey",
    email: "c@example.com",
    property: "House",
    bucket,
    axisId: "AXIS-1",
    application: { submittedAt: "2026-01-01" },
  });
  const input = (over: Record<string, unknown>) => ({
    directoryStage: "potential" as const,
    application: app("approved"),
    leaseRows: [],
    ledgerRows: [],
    hasPortalAccount: true,
    ...over,
  });

  it("Review application opens the Approve popup", () => {
    const snap = buildResidentLifecycle(input({ application: app("pending") }) as never, hrefs);
    expect(snap.next).toEqual({
      kind: "callback",
      label: "Review application",
      actionId: "approve-application",
      description: "Application waiting for your review",
    });
  });

  it("Send lease opens the Send lease screen for an approved resident, with or without a draft", () => {
    expect(buildResidentLifecycle(input({}) as never, hrefs).next).toMatchObject({ kind: "callback", label: "Send lease", actionId: "send-lease" });
    const draft = { id: "l1", residentName: "Casey", residentEmail: "c@example.com", unit: "R1", stageLabel: "Draft", updated: "", bucket: "manager", pdfVersion: 1, notes: "", updatedAtIso: "", thread: [] };
    expect(buildResidentLifecycle(input({ leaseRows: [draft] }) as never, hrefs).next).toMatchObject({ kind: "callback", label: "Send lease", actionId: "send-lease" });
    expect(buildResidentLifecycle(input({}) as never, hrefs).next?.description).toBeTruthy();
  });

  // balanceDue is a dollar label; the lifecycle used to treat it as cents and showed $5.25 for $525.
  it("reads an overdue balance label in dollars, not cents", () => {
    const snap = buildResidentLifecycle(
      {
        directoryStage: "current",
        application: null,
        leaseRows: [],
        ledgerRows: [
          { id: "c1", bucket: "overdue", balanceDue: "$525.00", amount: "$1,050.00", residentName: "Jamie", dueDate: "2026-10-01" } as never,
        ],
        hasPortalAccount: true,
      },
      hrefs,
    );
    const text = JSON.stringify(snap);
    expect(text).toContain("$525");
    expect(text).not.toContain("$5.25");
  });
});
