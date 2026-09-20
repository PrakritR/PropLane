import { describe, expect, it } from "vitest";
import { workNumberStatusWord } from "@/lib/sms/work-number-status";

/**
 * PLAN-0920-1530: the Channels row status word must map every real
 * `ManagerMessagingNumber` state (and the coarser `WorkspaceNumberEntry`
 * shape other workspaces' rows carry) one by one — the old status card's
 * carrier-registration wording carried real states and this collapses them
 * into exactly four words.
 */
describe("workNumberStatusWord maps every state", () => {
  it("canSend true is always Ready, regardless of state", () => {
    expect(workNumberStatusWord({ state: "provisioning", canSend: true })).toBe("Ready");
    expect(workNumberStatusWord({ state: "failed", canSend: true })).toBe("Ready");
  });

  it("setupNeedsAttention always wins over state", () => {
    expect(workNumberStatusWord({ state: "provisioning", setupNeedsAttention: true })).toBe(
      "Needs attention",
    );
    expect(workNumberStatusWord({ state: "active", setupNeedsAttention: true })).toBe(
      "Needs attention",
    );
  });

  it("failed is Needs attention", () => {
    expect(workNumberStatusWord({ state: "failed" })).toBe("Needs attention");
  });

  it("released is Needs attention", () => {
    expect(workNumberStatusWord({ state: "released" })).toBe("Needs attention");
  });

  it("provisioning with a pending carrier registration is Setting up · carrier registration pending", () => {
    expect(
      workNumberStatusWord({ state: "provisioning", carrierRegistrationState: "pending" }),
    ).toBe("Setting up · carrier registration pending");
  });

  it("provisioning with no known carrier detail (a foreign workspace row) is still Setting up", () => {
    expect(workNumberStatusWord({ state: "provisioning" })).toBe(
      "Setting up · carrier registration pending",
    );
  });

  it("provisioning with not_submitted/registered/deregistering carrier states all read Setting up", () => {
    for (const carrierRegistrationState of ["not_submitted", "registered", "deregistering", "deregistered"]) {
      expect(workNumberStatusWord({ state: "provisioning", carrierRegistrationState })).toBe(
        "Setting up · carrier registration pending",
      );
    }
  });

  it("provisioning with a failed carrier registration is Needs attention", () => {
    expect(
      workNumberStatusWord({ state: "provisioning", carrierRegistrationState: "failed" }),
    ).toBe("Needs attention");
  });

  it("pending_registration (queued, no number purchased yet) is Assigning", () => {
    expect(workNumberStatusWord({ state: "pending_registration" })).toBe("Assigning");
  });

  it("active with an unknown canSend (a foreign workspace row) is Ready", () => {
    expect(workNumberStatusWord({ state: "active" })).toBe("Ready");
  });

  it("active with an explicit canSend: false (texting off for this deployment, or a lapsed plan) is Needs attention", () => {
    expect(workNumberStatusWord({ state: "active", canSend: false })).toBe("Needs attention");
  });

  it("null/undefined/unrecognized state defaults to Assigning", () => {
    expect(workNumberStatusWord({ state: null })).toBe("Assigning");
    expect(workNumberStatusWord({})).toBe("Assigning");
    expect(workNumberStatusWord({ state: "something_unexpected" })).toBe("Assigning");
  });
});
