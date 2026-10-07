import { afterEach, describe, expect, it, vi } from "vitest";

const { refundVendorPayout, getStripe } = vi.hoisted(() => ({ refundVendorPayout: vi.fn(), getStripe: vi.fn() }));
vi.mock("@/lib/vendor-banking/refund.server", () => ({ refundVendorPayout }));
vi.mock("@/lib/stripe", () => ({ getStripe }));
vi.mock("@/lib/auth/vendor-api-access", () => ({
  requireVendorApiAccess: vi.fn(async () => ({ ok: true, actor: { userId: "vendor-1" } })),
}));
vi.mock("@/lib/supabase/service", () => ({ createSupabaseServiceRoleClient: vi.fn(() => ({})) }));

import { POST } from "@/app/api/vendor/payouts/[id]/refund/route";
import { vendorRefundsEnabled } from "@/lib/vendor-banking/flag";

afterEach(() => {
  delete process.env.VENDOR_REFUNDS_ENABLED;
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe("vendor refund to a manager is paused until it runs on the central refund rail", () => {
  it("is off by default", () => {
    expect(vendorRefundsEnabled()).toBe(false);
  });

  it("refuses with 409 before any Stripe call", async () => {
    vi.stubEnv("VENDOR_BANKING_ENABLED", "1");
    const res = await POST(
      new Request("http://localhost/api/vendor/payouts/p1/refund", { method: "POST", body: JSON.stringify({ amountCents: 1000 }) }),
      { params: Promise.resolve({ id: "p1" }) },
    );
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: "VENDOR_REFUND_PAUSED" });
    expect(getStripe).not.toHaveBeenCalled();
    expect(refundVendorPayout).not.toHaveBeenCalled();
  });

  it("only an explicit opt-in turns it back on", () => {
    process.env.VENDOR_REFUNDS_ENABLED = "1";
    expect(vendorRefundsEnabled()).toBe(true);
  });
});
