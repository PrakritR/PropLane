import { describe, expect, it } from "vitest";
import {
  canEditVendorReview,
  computeVendorReviewAggregate,
  evaluateVendorReviewEligibility,
  normalizeVendorReviewBody,
  normalizeVendorReviewStars,
  redactVendorReviewForViewer,
  VENDOR_REVIEW_BODY_MAX_LENGTH,
  vendorReviewWorkspaceLabel,
} from "@/lib/vendor-reviews";

describe("evaluateVendorReviewEligibility", () => {
  const base = {
    workOrderBucket: "completed",
    workOrderManagerUserId: "manager-1",
    workOrderVendorUserId: "vendor-1",
    actorManagerUserId: "manager-1",
  };

  it("allows a completed service owned by the actor's workspace, with a linked vendor", () => {
    const result = evaluateVendorReviewEligibility(base);
    expect(result).toEqual({ ok: true, vendorUserId: "vendor-1" });
  });

  it("refuses a service that is not completed", () => {
    const result = evaluateVendorReviewEligibility({ ...base, workOrderBucket: "scheduled" });
    expect(result).toEqual({ ok: false, status: 400, error: "Only a completed service can be reviewed." });
  });

  it("refuses a service that has no work order (unknown manager id)", () => {
    const result = evaluateVendorReviewEligibility({ ...base, workOrderManagerUserId: null });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(404);
  });

  it("refuses a service owned by a different workspace", () => {
    const result = evaluateVendorReviewEligibility({ ...base, workOrderManagerUserId: "manager-2" });
    expect(result).toEqual({
      ok: false,
      status: 403,
      error: "This service belongs to a different workspace.",
    });
  });

  it("refuses a completed service with no linked vendor", () => {
    const result = evaluateVendorReviewEligibility({ ...base, workOrderVendorUserId: null });
    expect(result).toEqual({
      ok: false,
      status: 400,
      error: "No vendor is linked to this service yet.",
    });
  });
});

describe("canEditVendorReview", () => {
  // C158: reverses the prior 14-day manager edit window — a posted review can
  // never be edited, at any age.
  it("refuses an edit the moment a review is created", () => {
    const now = new Date("2026-09-25T12:00:00.000Z");
    expect(canEditVendorReview(now.toISOString(), now)).toBe(false);
  });

  it("refuses an edit well within the old 14-day boundary", () => {
    const created = new Date("2026-09-01T00:00:00.000Z");
    const now = new Date(created.getTime() + 14 * 24 * 60 * 60 * 1000);
    expect(canEditVendorReview(created.toISOString(), now)).toBe(false);
  });

  it("refuses an edit long after the old 14-day window", () => {
    const created = new Date("2026-09-01T00:00:00.000Z");
    const now = new Date(created.getTime() + 14 * 24 * 60 * 60 * 1000 + 1000);
    expect(canEditVendorReview(created.toISOString(), now)).toBe(false);
  });

  it("fails closed on an unparsable timestamp", () => {
    expect(canEditVendorReview("not-a-date")).toBe(false);
  });
});

describe("computeVendorReviewAggregate", () => {
  it("returns null average and zero count for no reviews", () => {
    expect(computeVendorReviewAggregate([])).toEqual({ average: null, count: 0 });
  });

  it("averages and rounds to one decimal", () => {
    expect(computeVendorReviewAggregate([5, 4, 4])).toEqual({ average: 4.3, count: 3 });
  });

  it("handles a single review", () => {
    expect(computeVendorReviewAggregate([3])).toEqual({ average: 3, count: 1 });
  });
});

describe("cross-workspace review redaction", () => {
  it("labels the viewer's own workspace plainly", () => {
    expect(vendorReviewWorkspaceLabel("manager-1", "manager-1")).toBe("Your workspace");
  });

  it("redacts a different workspace to a generic label", () => {
    expect(vendorReviewWorkspaceLabel("manager-2", "manager-1")).toBe("A PropLane manager");
  });

  it("redacts when the viewer has no workspace context at all", () => {
    expect(vendorReviewWorkspaceLabel("manager-2", null)).toBe("A PropLane manager");
  });

  it("strips the raw manager id from a review outside the viewer's workspace", () => {
    const review = { id: "r1", managerUserId: "manager-2", stars: 5 };
    const redacted = redactVendorReviewForViewer(review, "manager-1");
    expect(redacted.isOwnWorkspace).toBe(false);
    expect(redacted.reviewerLabel).toBe("A PropLane manager");
    expect(redacted.managerUserId).toBe("");
  });

  it("keeps the manager id on the viewer's own workspace review", () => {
    const review = { id: "r1", managerUserId: "manager-1", stars: 5 };
    const redacted = redactVendorReviewForViewer(review, "manager-1");
    expect(redacted.isOwnWorkspace).toBe(true);
    expect(redacted.reviewerLabel).toBe("Your workspace");
    expect(redacted.managerUserId).toBe("manager-1");
  });
});

describe("normalizeVendorReviewStars / normalizeVendorReviewBody", () => {
  it("accepts integers 1 through 5", () => {
    for (const n of [1, 2, 3, 4, 5]) expect(normalizeVendorReviewStars(n)).toBe(n);
  });

  it("rejects out-of-range or non-numeric input", () => {
    expect(normalizeVendorReviewStars(0)).toBeNull();
    expect(normalizeVendorReviewStars(6)).toBeNull();
    expect(normalizeVendorReviewStars("great")).toBeNull();
    expect(normalizeVendorReviewStars(undefined)).toBeNull();
  });

  it("trims and truncates the review body to the max length", () => {
    expect(normalizeVendorReviewBody("  hello  ")).toBe("hello");
    expect(normalizeVendorReviewBody("x".repeat(VENDOR_REVIEW_BODY_MAX_LENGTH + 50)).length).toBe(
      VENDOR_REVIEW_BODY_MAX_LENGTH,
    );
  });
});
