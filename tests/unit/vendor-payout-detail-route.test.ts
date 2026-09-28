import { describe, expect, it, vi } from "vitest";

/**
 * Bug fix regression: `vendorPayoutDetailHref()` (src/lib/portal-detail-routes.ts)
 * builds `/vendor/financials/payouts/<id>` — the payout's own record page,
 * linked from the merged Payments list and from a paid invoice with a
 * matching `vendor_payouts` row (VD52/VD53). `src/lib/portals/vendor.ts`
 * registers only `income`/`invoices` as visible `financials` tabs (VD10/VD11
 * folded Payouts into the merged list), so "payouts" never appears in
 * `meta.tabs` — the old `!meta.tabs.some(...)` guard in
 * `render-portal-section.tsx` 404'd every payout detail link before
 * `VendorPayoutRecordPage` ever rendered. This drives the real
 * `renderPortalSection` (not a source-shape assertion) so it fails again if
 * that guard regresses.
 */

class RedirectError extends Error {
  constructor(public readonly to: string) {
    super(`NEXT_REDIRECT ${to}`);
  }
}
class NotFoundError extends Error {
  constructor() {
    super("NEXT_NOT_FOUND");
  }
}

vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new RedirectError(to);
  },
  notFound: () => {
    throw new NotFoundError();
  },
}));

const { renderPortalSection } = await import("@/lib/render-portal-section");

describe("vendor payout detail route (/vendor/financials/payouts/<id>)", () => {
  it("resolves a payout record with the flag-on detail-only tab, never 404ing", async () => {
    const el = await renderPortalSection("vendor", "financials", ["payouts", "payout-1"]);
    expect(el).toBeTruthy();
  });

  it("resolves a payout record's own detail tab too (…/payouts/<id>/communication)", async () => {
    const el = await renderPortalSection("vendor", "financials", ["payouts", "payout-1", "communication"]);
    expect(el).toBeTruthy();
  });

  it("still 404s a financials tab id that is neither a real nav tab nor the payouts detail-only id", async () => {
    await expect(renderPortalSection("vendor", "financials", ["bogus-tab"])).rejects.toThrow("NEXT_NOT_FOUND");
  });

  it("still redirects the bare (recordless) payouts tab to Settings › Payouts — unaffected by the detail-only bypass", async () => {
    try {
      await renderPortalSection("vendor", "financials", ["payouts"]);
      throw new Error("expected a redirect");
    } catch (error) {
      expect(error).toBeInstanceOf(RedirectError);
      expect((error as RedirectError).to).toBe("/vendor/profile?tab=payouts");
    }
  });

  it("still resolves the real invoices tab and its own record page", async () => {
    const bare = await renderPortalSection("vendor", "financials", ["invoices", "inv-1"]);
    expect(bare).toBeTruthy();
  });
});
