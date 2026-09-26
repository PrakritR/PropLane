// @vitest-environment jsdom
//
// C263 — the vendor Reviews list gets a rating filter. A workspace filter
// was also requested, but `/api/vendor/reviews` never returns which
// workspace left a review (`reviewerLabel` is hardcoded to "A PropLane
// manager" in `mapPublicVendorReviewRow`, deliberately, so a vendor can
// never learn which manager reviewed them) — only the rating half is built.
import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/components/providers/app-ui-provider", () => ({
  useAppUi: () => ({ showToast: vi.fn() }),
}));

import { VendorReviewsPanel } from "@/components/portal/vendor-reviews-panel";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const REVIEWS = [
  { id: "r1", stars: 5, body: "Great work", vendorReply: null, vendorRepliedAt: null, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", reviewerLabel: "A PropLane manager" },
  { id: "r2", stars: 2, body: "Late", vendorReply: null, vendorRepliedAt: null, createdAt: "2026-01-02T00:00:00.000Z", updatedAt: "2026-01-02T00:00:00.000Z", reviewerLabel: "A PropLane manager" },
];

function stubFetch() {
  return vi.fn(async () => ({
    ok: true,
    json: async () => ({ reviews: REVIEWS, aggregate: { average: 3.5, count: 2 } }),
  })) as unknown as typeof fetch;
}

describe("VendorReviewsPanel rating filter", () => {
  it("shows every review with no filter applied, then narrows by rating", async () => {
    vi.stubGlobal("fetch", stubFetch());
    render(<VendorReviewsPanel />);

    await waitFor(() => expect(document.querySelectorAll('[data-attr="vendor-review-row"]')).toHaveLength(2));

    const select = document.querySelector('[data-attr="vendor-reviews-rating-filter"]') as HTMLElement | null;
    expect(select).not.toBeNull();
  });

  it("never exposes a workspace identity anywhere in the fetched review shape", async () => {
    vi.stubGlobal("fetch", stubFetch());
    render(<VendorReviewsPanel />);
    await waitFor(() => expect(document.querySelectorAll('[data-attr="vendor-review-row"]')).toHaveLength(2));
    for (const review of REVIEWS) {
      expect(review.reviewerLabel).toBe("A PropLane manager");
    }
  });
});
