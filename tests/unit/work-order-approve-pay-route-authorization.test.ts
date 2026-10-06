import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/reports/auth", () => ({
  getReportsAuthContext: vi.fn(async () => ({ role: "manager", userId: "owner", email: "owner@example.com", db: {} })),
  assertManagerFinancialsAccess: vi.fn(async () => ({ ok: true })),
}));
vi.mock("@/lib/work-order-approve-pay.server", () => ({
  approveAndPayWorkOrder: vi.fn(async () => ({ ok: true, workOrder: { id: "wo-owned" }, expenseEntryIds: [] })),
  findBlockingVendorPayout: vi.fn(),
}));

import { POST } from "@/app/api/portal/work-orders/approve-pay/route";
import { approveAndPayWorkOrder } from "@/lib/work-order-approve-pay.server";

describe("approve-pay route funding boundary", () => {
  it("cannot inject the webhook-only settle path from authenticated JSON", async () => {
    const response = await POST(new Request("http://localhost/api/portal/work-orders/approve-pay", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workOrder: { id: "wo-owned" }, category: "plumbing", settleOnly: true,
        verifiedSessionId: "cs_forged", paymentChannel: "balance" }),
    }));
    expect(response.status).toBe(200);
    expect(approveAndPayWorkOrder).toHaveBeenCalledWith(expect.anything(), expect.anything(),
      expect.objectContaining({ settleOnly: false, paymentChannel: "balance" }));
    const forwarded = vi.mocked(approveAndPayWorkOrder).mock.calls[0]?.[2];
    expect(forwarded).not.toHaveProperty("verifiedSessionId");
  });
});
