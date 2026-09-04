/**
 * Automation removes a CLICK, never a CHECK.
 *
 * These flags let a manager hand the approve → generate → send handoff to PropLane. The risk is
 * obvious: the manual path is guarded (a withdrawn application is never approved, a lease send
 * runs `leaseSendGateBlocker`), and an automated path that skipped those guards would do the
 * damage silently and at machine speed. `shouldAutomate` is the one decision, so these are the
 * tests that keep it honest.
 */
import { describe, expect, it } from "vitest";
import {
  DEFAULT_APPLICATION_AUTOMATION,
  normalizeApplicationAutomation,
  normalizeApplicationAutomationByPropertyId,
  resolveApplicationAutomationForProperty,
  shouldAutomate,
} from "@/lib/application-automation-preferences";

describe("automation defaults", () => {
  it("is entirely off for a manager who never opened the setting", () => {
    // A feature that silently starts approving applications on deploy is the worst version of
    // this. Absent row, empty row, and junk all mean manual.
    for (const raw of [null, undefined, {}, "nope", 42, []]) {
      expect(normalizeApplicationAutomation(raw)).toEqual(DEFAULT_APPLICATION_AUTOMATION);
    }
  });

  it("only a real boolean true enables a step", () => {
    const prefs = normalizeApplicationAutomation({
      autoApproveApplications: "true",
      autoGenerateLease: 1,
      autoSendLease: true,
    });
    expect(prefs.autoApproveApplications).toBe(false);
    expect(prefs.autoGenerateLease).toBe(false);
    expect(prefs.autoSendLease).toBe(true);
  });

  it("ignores unknown keys rather than carrying them forward", () => {
    const prefs = normalizeApplicationAutomation({ autoDeleteEverything: true, autoSendLease: true });
    expect(prefs).toEqual({ ...DEFAULT_APPLICATION_AUTOMATION, autoSendLease: true });
    expect("autoDeleteEverything" in prefs).toBe(false);
  });

  it("resolves per-property overrides before the portfolio default", () => {
    const state = {
      portfolio: DEFAULT_APPLICATION_AUTOMATION,
      byPropertyId: normalizeApplicationAutomationByPropertyId({
        "prop-1": { autoApproveApplications: true },
      }),
    };
    expect(resolveApplicationAutomationForProperty(state, "prop-1").autoApproveApplications).toBe(true);
    expect(resolveApplicationAutomationForProperty(state, "prop-2").autoApproveApplications).toBe(false);
  });
});

describe("shouldAutomate", () => {
  it("runs when the step is on and nothing objects", () => {
    expect(shouldAutomate({ enabled: true })).toEqual({ run: true });
  });

  it("does nothing when the manager did not enable the step", () => {
    expect(shouldAutomate({ enabled: false, gateBlocker: "Application not approved" })).toEqual({
      run: false,
      reason: "step_disabled",
    });
  });

  it("never fires in demo mode", () => {
    // /demo must never write a real row.
    expect(shouldAutomate({ enabled: true, isDemo: true })).toMatchObject({
      run: false,
      reason: "demo_mode",
    });
  });

  it("never approves a withdrawn application", () => {
    // The manual path refuses this because approving provisions an account and rent charges for
    // someone who explicitly pulled out. Automation gets no exemption.
    expect(shouldAutomate({ enabled: true, isWithdrawn: true })).toMatchObject({
      run: false,
      reason: "application_withdrawn",
    });
  });

  it("does not repeat a step that already happened", () => {
    // Re-running would regenerate a document the resident may already have signed, or send a
    // second copy of a lease that is already out for signature.
    expect(shouldAutomate({ enabled: true, alreadyDone: true })).toMatchObject({
      run: false,
      reason: "already_done",
    });
  });

  it("honours the manual path's own gate, and reports its message", () => {
    // leaseSendGateBlocker's message — unapproved application, parties/terms mismatch, unreviewed
    // uploaded lease — is what the manager would have seen on the button.
    const decision = shouldAutomate({
      enabled: true,
      gateBlocker: "Review the imported lease before sending it.",
    });
    expect(decision).toEqual({
      run: false,
      reason: "gate_blocked",
      detail: "Review the imported lease before sending it.",
    });
  });

  it("treats a blank gate message as no obstacle", () => {
    // Callers return "" / whitespace for "nothing blocking"; that must not read as a blocker.
    expect(shouldAutomate({ enabled: true, gateBlocker: "   " })).toEqual({ run: true });
    expect(shouldAutomate({ enabled: true, gateBlocker: null })).toEqual({ run: true });
  });

  it("reports the hard blockers ahead of the gate message", () => {
    // A withdrawn application that ALSO fails the send gate is a withdrawal, not a review problem
    // — the manager should be told the real reason.
    expect(
      shouldAutomate({ enabled: true, isWithdrawn: true, gateBlocker: "Application not approved" }),
    ).toMatchObject({ reason: "application_withdrawn" });
  });

  it("stays silent about gates for a step nobody turned on", () => {
    // step_disabled outranks everything, so a manager running fully manually never sees
    // automation reasons for work they are doing by hand.
    expect(
      shouldAutomate({ enabled: false, isDemo: true, isWithdrawn: true, alreadyDone: true }),
    ).toMatchObject({ reason: "step_disabled" });
  });
});
