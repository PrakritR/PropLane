import { describe, expect, it } from "vitest";

import { pollShouldHaltAfterStatus } from "@/lib/poll-halt";

/**
 * The Communication SMS poll treated every failure as retryable and kept its
 * 20s interval running, so one refused session produced a failing request every
 * 20 seconds for as long as the tab stayed open (PRP-226).
 */
describe("pollShouldHaltAfterStatus", () => {
  it("halts on the two statuses that will not change on the next tick", () => {
    expect(pollShouldHaltAfterStatus(401)).toBe(true);
    expect(pollShouldHaltAfterStatus(403)).toBe(true);
  });

  it("keeps retrying a transient server failure", () => {
    // Halting here would turn a momentary hiccup into a panel that stays stale
    // until the page is reloaded.
    for (const status of [500, 502, 503, 504, 429]) {
      expect(pollShouldHaltAfterStatus(status)).toBe(false);
    }
  });

  it("does not halt on success or on a not-configured answer", () => {
    for (const status of [200, 204, 404, 409]) {
      expect(pollShouldHaltAfterStatus(status)).toBe(false);
    }
  });
});
