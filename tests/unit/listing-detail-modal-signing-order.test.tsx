// @vitest-environment jsdom
/**
 * The lease-basics and bundle "Details" sheets on the public listing page
 * carry the same Apply CTA as the price card and sticky bar. When the
 * listing's resolved leasing pipeline is lease-first (`property.signingOrder`,
 * PLAN-0927), every one of those Apply CTAs must say "Sign lease" too — this
 * covers the `ListingDetailModal` end of that (the price-card/sticky-bar end
 * is covered by `listing-price-card-signing-order.test.tsx`).
 *
 * The room and bathroom/shared-space detail sheets show only "Schedule tour"
 * today (Apply already sits on the page's own card), so they carry no Apply
 * CTA to relabel.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { ListingDetailModal } from "@/components/marketing/listing-detail-tables-client";
import type { LeaseBasicRow } from "@/data/listing-rich-content";

vi.mock("@/lib/rental-application/data", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/rental-application/data")>();
  return { ...actual, getRoomUnavailabilityWindows: () => [] };
});

vi.mock("@/lib/supabase/browser", () => ({
  createSupabaseBrowserClient: () => ({
    auth: {
      getUser: async () => ({ data: { user: null } }),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => {} } } }),
    },
  }),
}));

afterEach(cleanup);

function leaseRow(overrides: Partial<LeaseBasicRow> = {}): LeaseBasicRow {
  return {
    id: "lease-application",
    icon: "📄",
    title: "Application",
    detail: "Processing",
    price: "$45",
    status: "Due with app",
    body: "Application fee: $45.",
    ...overrides,
  };
}

function renderLeaseModal(signingOrder?: "application_first" | null) {
  render(
    <ListingDetailModal
      state={{ kind: "lease", row: leaseRow() }}
      onClose={() => {}}
      listingPropertyId="mgr-test-alder"
      signingOrder={signingOrder}
    />,
  );
}

describe("listing detail modal — apply CTA follows signingOrder", () => {
  it("says Apply for an application-first listing (today's copy, unchanged)", () => {
    renderLeaseModal("application_first");
    const cta = document.querySelector('[data-attr="listing-text-apply"]');
    expect(cta).not.toBeNull();
    expect(cta!.textContent).toContain("Apply");
    expect(cta!.textContent).not.toContain("Sign lease");
  });

  it("says Apply when signingOrder is absent (every existing caller keeps compiling unchanged)", () => {
    renderLeaseModal(undefined);
    const cta = document.querySelector('[data-attr="listing-text-apply"]');
    expect(cta!.textContent).toContain("Apply");
  });

  it("never says Sign lease: a stale lease_first value still reads Apply", () => {
    renderLeaseModal("lease_first" as never);
    const cta = document.querySelector('[data-attr="listing-text-apply"]');
    expect(cta).not.toBeNull();
    expect(cta!.textContent).toContain("Apply");
    expect(cta!.textContent).not.toContain("Sign lease");
  });
});
