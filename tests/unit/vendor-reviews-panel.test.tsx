// @vitest-environment jsdom
//
// C263 / VD21 (2026-09-27) — the vendor Reviews list gets a Services-style
// top bar: All / Needs reply / Replied sections, search, and a Filter sheet
// (Rating + Date). A Property filter was also in the studio spec, but
// `/api/vendor/reviews` never returns which workspace or property a review
// belongs to (`reviewerLabel` is hardcoded to "A PropLane manager" in
// `mapPublicVendorReviewRow`, deliberately, so a vendor can never learn which
// manager reviewed them) — only Rating + Date are built; Property is
// intentionally dropped.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const read = (rel: string) => readFileSync(join(process.cwd(), rel), "utf8");

vi.mock("@/components/providers/app-ui-provider", () => ({
  useAppUi: () => ({ showToast: vi.fn() }),
  useOptionalAppUi: () => ({ showToast: vi.fn() }),
  useConfirm: () => async () => true,
}));
vi.mock("next/navigation", () => ({
  usePathname: () => "/vendor/reviews/all",
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
}));

import { VendorReviewsPanel } from "@/components/portal/vendor-reviews-panel";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const REVIEWS = [
  { id: "r1", stars: 5, body: "Great work", vendorReply: null, vendorRepliedAt: null, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", reviewerLabel: "A PropLane manager" },
  { id: "r2", stars: 2, body: "Late", vendorReply: "Sorry, will do better.", vendorRepliedAt: "2026-01-03T00:00:00.000Z", createdAt: "2026-01-02T00:00:00.000Z", updatedAt: "2026-01-02T00:00:00.000Z", reviewerLabel: "A PropLane manager" },
];

function stubFetch() {
  return vi.fn(async () => ({
    ok: true,
    json: async () => ({ reviews: REVIEWS, aggregate: { average: 3.5, count: 2 } }),
  })) as unknown as typeof fetch;
}

describe("VendorReviewsPanel — top bar (VD21)", () => {
  it("shows the All / Needs reply / Replied sections with real counts and a search + Filter sheet", async () => {
    vi.stubGlobal("fetch", stubFetch());
    render(<VendorReviewsPanel tabId="all" />);

    await waitFor(() => expect(document.querySelectorAll('[data-attr="vendor-review-row"]')).toHaveLength(2));
    expect(document.querySelector('[data-attr="vendor-reviews-tab-all"]')).not.toBeNull();
    expect(document.querySelector('[data-attr="vendor-reviews-tab-needs-reply"]')).not.toBeNull();
    expect(document.querySelector('[data-attr="vendor-reviews-tab-replied"]')).not.toBeNull();
    expect(document.querySelector('[data-attr="vendor-reviews-search"]')).not.toBeNull();
    expect(document.querySelector('[data-attr="vendor-reviews-filter-open"]')).not.toBeNull();
  });

  it("only shows the still-unreplied review on the Needs reply tab", async () => {
    vi.stubGlobal("fetch", stubFetch());
    render(<VendorReviewsPanel tabId="needs-reply" />);
    await waitFor(() => expect(document.querySelectorAll('[data-attr="vendor-review-row"]')).toHaveLength(1));
    expect(screen.getByText("Great work")).toBeTruthy();
  });

  it("only shows the already-replied review on the Replied tab", async () => {
    vi.stubGlobal("fetch", stubFetch());
    render(<VendorReviewsPanel tabId="replied" />);
    await waitFor(() => expect(document.querySelectorAll('[data-attr="vendor-review-row"]')).toHaveLength(1));
    expect(screen.getByText("Late")).toBeTruthy();
  });

  it("draws the header stats strip from the rows: Average rating, Reviews, Needs reply, Response rate", async () => {
    vi.stubGlobal("fetch", stubFetch());
    render(<VendorReviewsPanel tabId="all" />);
    await waitFor(() => expect(document.querySelectorAll('[data-attr="vendor-review-row"]')).toHaveLength(2));
    const stat = (id: string) => document.querySelector(`[data-attr="vendor-reviews-stat-${id}"]`)?.textContent ?? "";
    expect(stat("average")).toContain("Average rating");
    expect(stat("average")).toContain("3.5 ★");
    expect(stat("count")).toContain("2");
    expect(stat("needs-reply")).toContain("1");
    expect(stat("response-rate")).toContain("50%");
  });

  it("has a Rating field (plus From/To date) in the Filter sheet — never a Property field (privacy: no workspace/property link on this route)", () => {
    const source = read("src/components/portal/vendor-reviews-panel.tsx");
    expect(source).toContain('sectionId="rating"');
    expect(source).toContain('label="From"');
    expect(source).toContain('label="To"');
    expect(source).not.toContain('label="Property"');
    expect(source).toContain("filterFieldCount={3}");
  });

  it("never exposes a workspace identity anywhere in the fetched review shape", async () => {
    vi.stubGlobal("fetch", stubFetch());
    render(<VendorReviewsPanel tabId="all" />);
    await waitFor(() => expect(document.querySelectorAll('[data-attr="vendor-review-row"]')).toHaveLength(2));
    for (const review of REVIEWS) {
      expect(review.reviewerLabel).toBe("A PropLane manager");
    }
  });
});
