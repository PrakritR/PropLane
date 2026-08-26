/**
 * What may be approved without a human looking.
 *
 * Approval provisions a resident account and writes rent charges, so the asymmetry is stark: an
 * application that should have been approved and was not costs the manager a click; one approved
 * that should not have been creates an account, bills someone, and has to be unpicked by hand.
 *
 * Every branch therefore refuses when it cannot tell.
 */
import { describe, expect, it } from "vitest";
import {
  AUTO_APPROVE_MAX_PER_PASS,
  eligibleForAutoApproval,
  selectAutoApprovals,
} from "@/lib/auto-approve-trigger";

const ready = (over: Record<string, unknown> = {}) => ({
  id: "app-1",
  bucket: "pending",
  complete: true,
  ...over,
});

describe("eligibility", () => {
  it("approves a complete, pending application with no screening", () => {
    // Nothing was ordered, so there is no adverse signal to wait for.
    expect(eligibleForAutoApproval(ready())).toEqual({ approve: true });
  });

  it("approves when screening came back clear", () => {
    expect(eligibleForAutoApproval(ready({ screeningStatus: "clear" })).approve).toBe(true);
    expect(eligibleForAutoApproval(ready({ screeningStatus: "passed" })).approve).toBe(true);
  });

  it("refuses anything not pending", () => {
    for (const bucket of ["approved", "rejected", "incomplete", "", null, undefined]) {
      expect(eligibleForAutoApproval(ready({ bucket })).approve).toBe(false);
    }
  });

  it("never approves a withdrawn application", () => {
    // The applicant explicitly pulled out; approving would bill someone who left.
    expect(eligibleForAutoApproval(ready({ withdrawnAt: "2026-08-01T00:00:00Z" }))).toEqual({
      approve: false,
      reason: "withdrawn",
    });
  });

  it("treats unknown completeness as incomplete", () => {
    // Absent is not a yes.
    for (const complete of [undefined, null, false, "yes"]) {
      expect(eligibleForAutoApproval(ready({ complete })).approve).toBe(false);
    }
  });

  it("waits while screening is still running", () => {
    for (const status of ["pending", "processing", "in_progress"]) {
      expect(eligibleForAutoApproval(ready({ screeningStatus: status }))).toEqual({
        approve: false,
        reason: "screening_pending",
      });
    }
  });

  it("refuses on an adverse or unrecognised screening result", () => {
    // "consider" exists precisely BECAUSE a human should look; an unknown value gets the same
    // treatment rather than being read as a pass.
    for (const status of ["consider", "failed", "suspended", "wat"]) {
      expect(eligibleForAutoApproval(ready({ screeningStatus: status }))).toEqual({
        approve: false,
        reason: "screening_adverse",
      });
    }
  });
});

describe("selecting a pass", () => {
  const rows = Array.from({ length: 9 }, (_, i) => ready({ id: `app-${i}` }));

  it("does nothing when the manager has not switched it on", () => {
    expect(selectAutoApprovals(rows, { enabled: false })).toEqual([]);
    expect(selectAutoApprovals(rows, {})).toEqual([]);
  });

  it("never writes from /demo", () => {
    expect(selectAutoApprovals(rows, { enabled: true, isDemo: true })).toEqual([]);
  });

  it("caps how many one pass approves", () => {
    // Switching this on with a backlog must not provision fifty accounts and fifty sets of
    // charges in a single page load. The rest come on the next pass.
    const picked = selectAutoApprovals(rows, { enabled: true });
    expect(picked).toHaveLength(AUTO_APPROVE_MAX_PER_PASS);
    expect(picked.map((r) => r.id)).toEqual(["app-0", "app-1", "app-2", "app-3", "app-4"]);
  });

  it("skips ineligible rows without consuming the cap on them", () => {
    const mixed = [
      ready({ id: "withdrawn", withdrawnAt: "2026-01-01" }),
      ready({ id: "ok-1" }),
      ready({ id: "adverse", screeningStatus: "consider" }),
      ready({ id: "ok-2" }),
    ];
    expect(selectAutoApprovals(mixed, { enabled: true }).map((r) => r.id)).toEqual(["ok-1", "ok-2"]);
  });

  it("returns nothing for an empty list", () => {
    expect(selectAutoApprovals([], { enabled: true })).toEqual([]);
  });
});
