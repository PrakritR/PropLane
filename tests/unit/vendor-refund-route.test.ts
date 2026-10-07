import { afterEach, describe, expect, it, vi } from "vitest";

const { submitVendorRefund, getStripe } = vi.hoisted(() => ({ submitVendorRefund: vi.fn(), getStripe: vi.fn(() => ({})) }));
vi.mock("@/lib/vendor-banking/central-refund.server", () => ({ submitVendorRefund, readVendorRefundFunds: vi.fn() }));
vi.mock("@/lib/stripe", () => ({ getStripe }));
vi.mock("@/lib/auth/vendor-api-access", () => ({
  requireVendorApiAccess: vi.fn(async () => ({ ok: true, actor: { userId: "vendor-1" } })),
}));
vi.mock("@/lib/supabase/service", () => ({ createSupabaseServiceRoleClient: vi.fn(() => ({})) }));
vi.mock("@/lib/analytics/posthog", () => ({ track: vi.fn() }));

import { POST } from "@/app/api/vendor/payouts/[id]/refund/route";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

function post(body: unknown, headers: Record<string, string> = {}) {
  return POST(
    new Request("http://localhost/api/vendor/payouts/p1/refund", { method: "POST", headers, body: JSON.stringify(body) }),
    { params: Promise.resolve({ id: "p1" }) },
  );
}

describe("POST /api/vendor/payouts/[id]/refund (central rail)", () => {
  it("stays behind VENDOR_REFUNDS_ENABLED: off -> 409 before the rail or Stripe", async () => {
    vi.stubEnv("VENDOR_BANKING_ENABLED", "1");
    const res = await post({ amountCents: 1000 }, { "Idempotency-Key": "client-key-0001" });
    expect(res.status).toBe(409);
    expect(submitVendorRefund).not.toHaveBeenCalled();
  });

  it("on: the signed-in vendor id (never the body) and the Idempotency-Key reach the rail", async () => {
    vi.stubEnv("VENDOR_BANKING_ENABLED", "1");
    vi.stubEnv("VENDOR_REFUNDS_ENABLED", "1");
    submitVendorRefund.mockResolvedValue({ ok: true, status: "pending", requestId: "r1", grossCents: 1000, feeShareCents: 30, netDebitCents: 970, replay: false });
    const res = await post({ amountCents: 1000, reason: "Duplicate payment", vendorUserId: "someone-else" }, { "Idempotency-Key": "client-key-0001" });
    expect(res.status).toBe(200);
    expect(submitVendorRefund).toHaveBeenCalledWith(expect.anything(), expect.anything(), {
      payoutId: "p1", vendorUserId: "vendor-1", requestedGrossCents: 1000, reason: "Duplicate payment", clientKey: "client-key-0001",
    });
  });

  it("passes a rail refusal through with its status and code", async () => {
    vi.stubEnv("VENDOR_BANKING_ENABLED", "1");
    vi.stubEnv("VENDOR_REFUNDS_ENABLED", "1");
    submitVendorRefund.mockResolvedValue({ ok: false, status: 409, code: "REFUND_WITHDRAWN", error: "This money has already been withdrawn." });
    const res = await post({ amountCents: 1000 }, { "Idempotency-Key": "client-key-0001" });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: "REFUND_WITHDRAWN" });
  });

  it("rejects a fractional or negative amount", async () => {
    vi.stubEnv("VENDOR_BANKING_ENABLED", "1");
    vi.stubEnv("VENDOR_REFUNDS_ENABLED", "1");
    expect((await post({ amountCents: 10.5 }, { "Idempotency-Key": "client-key-0001" })).status).toBe(400);
    expect((await post({ amountCents: -5 }, { "Idempotency-Key": "client-key-0001" })).status).toBe(400);
    expect(submitVendorRefund).not.toHaveBeenCalled();
  });
});
