import { describe, expect, it } from "vitest";
import {
  residentJourneySteps,
  resolveResidentJourneyNextAction,
  type ResidentJourneyInput,
} from "@/lib/resident-journey-timeline";

function baseInput(overrides: Partial<ResidentJourneyInput> = {}): ResidentJourneyInput {
  return {
    hasPendingTour: false,
    applicationSubmitted: true,
    applicationApproved: true,
    leaseSignatureNeeded: false,
    leaseSigned: true,
    overdueChargeCount: 0,
    pendingChargeCount: 0,
    totalBalanceDueLabel: "$0",
    ...overrides,
  };
}

describe("resolveResidentJourneyNextAction (C118)", () => {
  it("surfaces the pending tour first, ahead of everything else", () => {
    const action = resolveResidentJourneyNextAction(baseInput({ hasPendingTour: true, applicationApproved: false }));
    expect(action.id).toBe("tour");
  });

  it("asks to finish an unsubmitted application", () => {
    const action = resolveResidentJourneyNextAction(baseInput({ applicationSubmitted: false, applicationApproved: false }));
    expect(action.id).toBe("application");
    expect(action.ctaLabel).toBe("Continue application");
  });

  it("shows the application under review once submitted but not yet approved", () => {
    const action = resolveResidentJourneyNextAction(baseInput({ applicationApproved: false }));
    expect(action.id).toBe("application");
    expect(action.ctaLabel).toBe("View application");
  });

  it("asks for a lease signature when one is due", () => {
    const action = resolveResidentJourneyNextAction(baseInput({ leaseSignatureNeeded: true, leaseSigned: false }));
    expect(action.id).toBe("lease");
    expect(action.ctaLabel).toBe("Sign lease");
  });

  it("marks an overdue balance urgent and names the amount", () => {
    const action = resolveResidentJourneyNextAction(
      baseInput({ overdueChargeCount: 1, pendingChargeCount: 1, totalBalanceDueLabel: "$900" }),
    );
    expect(action.id).toBe("payments");
    expect(action.urgent).toBe(true);
    expect(action.title).toContain("$900");
  });

  it("shows a pending (non-overdue) balance without urgency", () => {
    const action = resolveResidentJourneyNextAction(
      baseInput({ pendingChargeCount: 1, totalBalanceDueLabel: "$900" }),
    );
    expect(action.id).toBe("payments");
    expect(action.urgent).toBe(false);
  });

  it("resolves to 'none' once every step has cleared", () => {
    const action = resolveResidentJourneyNextAction(baseInput());
    expect(action.id).toBe("none");
  });

  it("respects a custom basePath", () => {
    const action = resolveResidentJourneyNextAction(baseInput({ basePath: "/demo/resident" }));
    expect(action.href).toBe("/demo/resident/move-in");
  });
});

describe("residentJourneySteps (C118)", () => {
  it("marks exactly one step 'current' and never two", () => {
    const steps = residentJourneySteps(baseInput({ applicationApproved: false }));
    const currentSteps = steps.filter((s) => s.state === "current");
    expect(currentSteps).toHaveLength(1);
    expect(currentSteps[0]!.id).toBe("application");
  });

  it("marks every step before the current one done, and every step after upcoming", () => {
    const steps = residentJourneySteps(baseInput({ leaseSignatureNeeded: true, leaseSigned: false }));
    expect(steps.map((s) => s.state)).toEqual(["done", "done", "current", "upcoming"]);
  });

  it("marks every step done when the journey is fully complete", () => {
    const steps = residentJourneySteps(baseInput());
    expect(steps.every((s) => s.state === "done")).toBe(true);
  });
});
