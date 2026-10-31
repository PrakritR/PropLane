import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
const state = vi.hoisted(() => ({ session: {} as Record<string, unknown>, record: vi.fn() }));
vi.mock("@/lib/rate-limit", () => ({ clientIpFrom: () => "test", rateLimit: async () => ({ ok: true }) }));
vi.mock("@/lib/stripe", () => ({ getStripe: () => ({ checkout: { sessions: { retrieve: async () => state.session } } }) }));
vi.mock("@/lib/manager-purchase-from-session", () => ({ checkoutSessionIndicatesPaidPurchase: (s: { status: string; payment_status: string }) => s.status === "complete" && ["paid", "no_payment_required"].includes(s.payment_status), recordPaidManagerCheckoutSession: state.record }));
import { GET } from "@/app/api/auth/manager-checkout-preview/route";
afterEach(() => vi.clearAllMocks());
describe("manager checkout preview payment", () => {
  it("rejects a complete but unpaid session without recording it", async () => {
    state.session = { status: "complete", payment_status: "unpaid" };
    expect((await GET(new Request("https://example.test?session_id=cs_test"))).status).toBe(400);
    expect(state.record).not.toHaveBeenCalled();
  });
  it("accepts complete paid sessions with matching signup details", async () => {
    state.session = { status: "complete", payment_status: "paid", metadata: { manager_id: "manager", email: "owner@example.test", tier: "pro" } };
    expect((await GET(new Request("https://example.test?session_id=cs_test"))).status).toBe(200);
    expect(state.record).toHaveBeenCalledTimes(1);
  });
});
