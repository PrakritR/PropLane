// @vitest-environment jsdom
/**
 * The one line the work-number card prints under a live number. It answers for
 * the WORKSPACE's line, never for who is looking: a teammate with read-only
 * Communication reads the same live number — and the same honest reason — the
 * owner does. docs/agents/sms-system.md § One work number per workspace.
 */
import { describe, expect, it } from "vitest";
import { workNumberReadinessCaption } from "@/components/portal/pro-work-number-card";

describe("workNumberReadinessCaption", () => {
  it("says nothing when the line is ready", () => {
    expect(workNumberReadinessCaption({ lineReady: true, sendingAvailable: true })).toBe("");
    expect(workNumberReadinessCaption({ lineReady: true, sendingAvailable: true, lineBlocked: null })).toBe("");
  });

  it("names the deployment switch, for the owner and the teammate alike", () => {
    // `sendingAvailable` is the OWNER's runtime access, so a teammate reads it
    // too: a live, registered line held up by this deployment's send switch is
    // not unfinished setup and must never be captioned as such.
    expect(workNumberReadinessCaption({ lineReady: false, sendingAvailable: false })).toBe(
      "Texting is off for this deployment",
    );
    expect(
      workNumberReadinessCaption({ lineReady: false, sendingAvailable: false, lineBlocked: "deployment" }),
    ).toBe("Texting is off for this deployment");
    // The runtime mode / allowlist blocks the line without the env switch moving.
    expect(workNumberReadinessCaption({ lineReady: false, sendingAvailable: true, lineBlocked: "deployment" })).toBe(
      "Texting is off for this deployment",
    );
  });

  it("gives a plain billing reason when the workspace wallet is what blocks the line", () => {
    expect(workNumberReadinessCaption({ lineReady: false, sendingAvailable: true, lineBlocked: "billing" })).toBe(
      "Texting is paused for billing",
    );
  });

  it("says a live line held by the provider is paused, never finishing setup", () => {
    expect(workNumberReadinessCaption({ lineReady: false, sendingAvailable: true, lineBlocked: "paused" })).toBe(
      "Texting paused",
    );
  });

  it("claims no reason it does not have when the control plane is unreadable", () => {
    expect(workNumberReadinessCaption({ lineReady: false, sendingAvailable: true, lineBlocked: "unavailable" })).toBe(
      "Texting is unavailable right now",
    );
  });

  it("reserves Finishing setup for a line that genuinely is not provisioned yet", () => {
    expect(workNumberReadinessCaption({ lineReady: false, sendingAvailable: true, lineBlocked: "setup" })).toBe(
      "Finishing setup",
    );
    // An older payload with no reason at all: the number exists and the
    // deployment can send, so setup is the only blocker left.
    expect(workNumberReadinessCaption({ lineReady: false, sendingAvailable: true })).toBe("Finishing setup");
  });
});
