import { describe, expect, it } from "vitest";
import { buildResidentLifecycle, formatResidentShortDate, resolveStage, leaseTurnOf } from "@/lib/manager-resident-lifecycle";

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

  // One reading of the lease, the way the Leases tabs read it, so the stage, the next step and
  // the to-do can never disagree (the Nov 9 review: "Lease sent" + "waiting for your signature").
  describe("resolveStage lease matrix", () => {
    const lease = (over: Record<string, unknown>) => ({
      id: "l1", residentName: "Casey", residentEmail: "c@example.com", unit: "R1", stageLabel: "x",
      updated: "", pdfVersion: 1, notes: "", updatedAtIso: "", thread: [], ...over,
    });
    const stageOf = (l: Record<string, unknown>) => resolveStage(input({ leaseRows: [lease(l)] }) as never);
    const snapOf = (l: Record<string, unknown>) => buildResidentLifecycle(input({ leaseRows: [lease(l)] }) as never, hrefs);

    it("maps each lease state to one stage", () => {
      expect(stageOf({ bucket: "manager", status: "Draft" })).toBe("lease_drafted");
      expect(stageOf({ bucket: "manager" })).toBe("lease_drafted");
      expect(stageOf({ bucket: "manager", status: "Manager Review" })).toBe("awaiting_your_signature");
      expect(stageOf({ bucket: "manager", status: "Admin Review" })).toBe("awaiting_your_signature");
      expect(stageOf({ bucket: "resident", status: "Resident Signature Pending" })).toBe("lease_sent");
      expect(stageOf({ bucket: "signed", status: "Manager Signature Pending" })).toBe("awaiting_your_signature");
      expect(stageOf({ bucket: "signed", status: "Fully Signed", managerSignature: { name: "M" } })).not.toBe("awaiting_your_signature");
    });

    it("labels follow the stage", () => {
      expect(snapOf({ bucket: "manager", status: "Draft" }).stageLabel).toBe("Lease drafted");
      expect(snapOf({ bucket: "resident", status: "Resident Signature Pending" }).stageLabel).toBe("Lease sent");
      expect(snapOf({ bucket: "signed", status: "Manager Signature Pending" }).stageLabel).toBe("Your signature");
    });

    it("a draft never says waiting for your signature and offers Send lease", () => {
      const snap = snapOf({ bucket: "manager", status: "Draft" });
      expect(snap.next).toMatchObject({ label: "Send lease", actionId: "send-lease" });
      expect(snap.todo.map((t) => t.title).join("|")).not.toMatch(/waiting for your signature/);
      expect(snap.todo.map((t) => t.title)).toContain("Lease not sent");
    });

    it("a sent lease waits on the resident, with no signature ask of the manager", () => {
      const snap = snapOf({ bucket: "resident", status: "Resident Signature Pending", sentToResidentAt: "2026-01-02" });
      expect(snap.next).toMatchObject({ label: "Remind to sign" });
      expect(snap.todo.map((t) => t.title).join("|")).toMatch(/resident to sign/);
      expect(snap.todo.map((t) => t.title).join("|")).not.toMatch(/your signature/);
    });

    it("a resident-signed lease asks for the manager's signature", () => {
      const snap = snapOf({ bucket: "signed", status: "Manager Signature Pending" });
      expect(snap.next).toMatchObject({ label: "Sign lease", actionId: "sign-lease" });
      expect(snap.todo.map((t) => t.title)).toContain("Lease waiting for your signature");
    });

    it("leaseTurnOf is the shared reading", () => {
      expect(leaseTurnOf(null)).toBeNull();
      expect(leaseTurnOf({ bucket: "signed", status: "Fully Signed" } as never)).toBe("signed");
    });
  });
});
