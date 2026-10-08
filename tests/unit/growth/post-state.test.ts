import { describe, expect, it } from "vitest";
import { assertTransition, canTransition, POST_TRANSITIONS } from "@/lib/growth/post-state";
import { GROWTH_POST_STATUSES } from "@/lib/growth/types";

describe("growth post state", () => {
  it("covers every status", () => {
    expect(Object.keys(POST_TRANSITIONS).sort()).toEqual([...GROWTH_POST_STATUSES].sort());
  });
  it("allows the happy path", () => {
    for (const [a, b] of [["drafted", "review"], ["review", "approved"], ["approved", "scheduled"], ["scheduled", "publishing"], ["publishing", "published"]] as const) {
      expect(canTransition(a, b)).toBe(true);
    }
  });
  it("rejects skipping review and leaving archived", () => {
    expect(() => assertTransition("drafted", "scheduled")).toThrow(/Invalid growth post transition/);
    expect(() => assertTransition("archived", "review")).toThrow();
    expect(() => assertTransition("published", "scheduled")).toThrow();
  });
});
