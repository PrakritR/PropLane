// @vitest-environment jsdom
/**
 * The one line the work-number card prints under a live number. It answers for
 * the WORKSPACE's line, never for who is looking: a teammate with read-only
 * Communication reads the same live number the owner does.
 * docs/agents/sms-system.md § One work number per workspace.
 */
import { describe, expect, it } from "vitest";
import { workNumberReadinessCaption } from "@/components/portal/pro-work-number-card";

describe("workNumberReadinessCaption", () => {
  it("says nothing when the line is ready, for an owner and a teammate alike", () => {
    expect(workNumberReadinessCaption({ lineReady: true, sendingAvailable: true })).toBe("");
    expect(workNumberReadinessCaption({ lineReady: true, sendingAvailable: true, coManager: true })).toBe("");
  });

  it("says Finishing setup when the line itself is not ready", () => {
    expect(workNumberReadinessCaption({ lineReady: false, sendingAvailable: true })).toBe("Finishing setup");
    expect(workNumberReadinessCaption({ lineReady: false, sendingAvailable: true, coManager: true })).toBe(
      "Finishing setup",
    );
  });

  it("names the deployment switch for an owner and keeps it to one word for a teammate", () => {
    expect(workNumberReadinessCaption({ lineReady: false, sendingAvailable: false })).toBe(
      "Texting is off for this deployment",
    );
    expect(workNumberReadinessCaption({ lineReady: false, sendingAvailable: false, coManager: true })).toBe(
      "Finishing setup",
    );
  });
});
