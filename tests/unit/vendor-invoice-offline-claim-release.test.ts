import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The offline rail claims the invoice and then settles it. Settle genuinely refuses ('Bill
 * mismatch', 'Payment claim mismatch') and genuinely faults, and no money has moved when it does
 * — so the claim has to go back. Left behind, `payment_claim='offline'` made the invoice
 * unpayable by every rail and unschedulable and undeletable too.
 */
const claimInvoicePayment = vi.hoisted(() => vi.fn(async () => undefined));
const settleInvoicePayment = vi.hoisted(() => vi.fn(async () => undefined));
const authorizeOutgoingInvoice = vi.hoisted(() => vi.fn(async () => ({ id: "inv_1", bill_id: null, vendor_user_id: "vendor_1" })));
vi.mock("@/lib/vendor-invoice-settlement.server", () => ({
  claimInvoicePayment,
  settleInvoicePayment,
  authorizeOutgoingInvoice,
}));

const recordVendorServiceFeeRevenue = vi.hoisted(() => vi.fn());
vi.mock("@/lib/vendor-banking/platform-revenue.server", () => ({
  recordVendorServiceFeeRevenue: (...a: unknown[]) => recordVendorServiceFeeRevenue(...a),
}));

const releaseInvoicePaymentClaim = vi.hoisted(() => vi.fn(async () => true));
vi.mock("@/lib/vendor-invoice-claim.server", () => ({ releaseInvoicePaymentClaim }));
vi.mock("@/lib/reports/gl-posting", () => ({ postGlBillVoided: vi.fn() }));

vi.mock("@/lib/reports/auth", () => ({
  getReportsAuthContext: async () => ({ db: {}, userId: "manager_1", role: "manager", email: "m@x.test" }),
  assertManagerFinancialsAccess: async () => ({ ok: true }),
}));

import { POST } from "@/app/api/vendor/invoices/[id]/outgoing/route";
import { VendorInvoicePaymentRefusal } from "@/lib/vendor-invoices";

const call = () =>
  POST(
    new Request("https://x.test/api/vendor/invoices/inv_1/outgoing", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "offline", date: "2026-10-01T12:00:00-07:00", method: "Check" }),
    }),
    { params: Promise.resolve({ id: "inv_1" }) },
  );

beforeEach(() => {
  vi.clearAllMocks();
  claimInvoicePayment.mockImplementation(async () => undefined);
  settleInvoicePayment.mockImplementation(async () => undefined);
  releaseInvoicePaymentClaim.mockImplementation(async () => true);
});

describe("offline invoice payment", () => {
  it("records the payment and keeps the claim when settle succeeds", async () => {
    const res = await call();
    expect(res.status).toBe(200);
    expect(settleInvoicePayment).toHaveBeenCalledOnce();
    expect(releaseInvoicePaymentClaim).not.toHaveBeenCalled();
    // Offline/manual settles carry NO service fee: nothing is booked as PropLane revenue.
    expect(recordVendorServiceFeeRevenue).not.toHaveBeenCalled();
    expect(settleInvoicePayment.mock.calls[0]).toEqual([expect.anything(), "manager_1", "inv_1", "offline", expect.any(String), "Check"]);
  });

  it("releases the claim when settle REFUSES, and still answers 409", async () => {
    settleInvoicePayment.mockImplementation(async () => {
      throw new VendorInvoicePaymentRefusal("Bill mismatch");
    });
    const res = await call();
    expect(res.status).toBe(409);
    expect(releaseInvoicePaymentClaim).toHaveBeenCalledWith({}, "manager_1", "inv_1", "offline");
  });

  it("releases the claim when settle FAULTS, and still answers 500", async () => {
    settleInvoicePayment.mockImplementation(async () => {
      throw new Error("connection reset");
    });
    const res = await call();
    expect(res.status).toBe(500);
    expect(releaseInvoicePaymentClaim).toHaveBeenCalledWith({}, "manager_1", "inv_1", "offline");
  });

  it("a release that itself fails never hides the settle error", async () => {
    settleInvoicePayment.mockImplementation(async () => {
      throw new Error("connection reset");
    });
    releaseInvoicePaymentClaim.mockImplementation(async () => {
      throw new Error("could not release");
    });
    const res = await call();
    expect(res.status).toBe(500);
    expect(((await res.json()) as { error: string }).error).toContain("connection reset");
  });
});
