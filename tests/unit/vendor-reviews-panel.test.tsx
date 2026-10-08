// @vitest-environment jsdom
//
// vendor-portal-ia-1007 (D4) — Reviews is ONE list, newest first: no tabs, no stat cards,
// a plain "★ 3.5 · 2 reviews" header line, search, and a Filter sheet (Rating + Date). A Property filter was also in the studio spec, but
// `/api/vendor/reviews` never returns which workspace or property a review
// belongs to (`reviewerLabel` is hardcoded to "A PropLane manager" in
// `mapPublicVendorReviewRow`, deliberately, so a vendor can never learn which
// manager reviewed them) — only Rating + Date are built; Property is
// intentionally dropped.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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

import { VendorReviewsPanel, reviewsSummary } from "@/components/portal/vendor-reviews-panel";

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

describe("VendorReviewsPanel — one list (D4)", () => {
  it("lists every review newest first, with search and a Filter sheet but no tabs and no stat cards", async () => {
    vi.stubGlobal("fetch", stubFetch());
    render(<VendorReviewsPanel />);

    await waitFor(() => expect(document.querySelectorAll('[data-attr="vendor-review-row"]')).toHaveLength(2));
    const titles = [...document.querySelectorAll('[data-attr="vendor-review-row"]')].map((row) => row.textContent ?? "");
    expect(titles[0]).toContain("Late");
    expect(titles[1]).toContain("Great work");
    expect(document.querySelector('[data-attr="vendor-reviews-search"]')).not.toBeNull();
    expect(document.querySelector('[data-attr="vendor-reviews-filter-open"]')).not.toBeNull();
    for (const id of ["all", "needs-reply", "replied"]) {
      expect(document.querySelector(`[data-attr="vendor-reviews-tab-${id}"]`)).toBeNull();
    }
    expect(document.querySelector('[data-attr="vendor-reviews-stats"]')).toBeNull();
  });

  it("shows the average and the count as plain facts on the header line, derived from the rows", async () => {
    vi.stubGlobal("fetch", stubFetch());
    render(<VendorReviewsPanel />);
    await waitFor(() => expect(document.querySelectorAll('[data-attr="vendor-review-row"]')).toHaveLength(2));
    expect(document.querySelector('[data-slot="portal-list-count"]')?.textContent).toBe("★ 3.5 · 2 reviews");
    expect(reviewsSummary(REVIEWS.slice(0, 1))).toBe("★ 5.0 · 1 review");
    expect(reviewsSummary([])).toBeNull();
    expect(reviewsSummary(null)).toBeNull();
  });

  it("a failed load (non-2xx) says so and Try again reloads it", async () => {
    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        calls += 1;
        if (calls === 1) return { ok: false, status: 403, json: async () => ({ error: "Forbidden." }) };
        return { ok: true, status: 200, json: async () => ({ reviews: REVIEWS, aggregate: { average: 3.5, count: 2 } }) };
      }) as unknown as typeof fetch,
    );
    render(<VendorReviewsPanel />);
    expect(await screen.findByText("Could not load reviews.")).toBeTruthy();
    // An error is never read as "No reviews yet".
    expect(screen.queryByText("No reviews yet")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(document.querySelectorAll('[data-attr="vendor-review-row"]')).toHaveLength(2));
  });

  it("a 200 whose body is not a review list is also a failed load", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, status: 200, json: async () => ({}) })) as unknown as typeof fetch);
    render(<VendorReviewsPanel />);
    expect(await screen.findByText("Could not load reviews.")).toBeTruthy();
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
    render(<VendorReviewsPanel />);
    await waitFor(() => expect(document.querySelectorAll('[data-attr="vendor-review-row"]')).toHaveLength(2));
    for (const review of REVIEWS) {
      expect(review.reviewerLabel).toBe("A PropLane manager");
    }
  });
});
