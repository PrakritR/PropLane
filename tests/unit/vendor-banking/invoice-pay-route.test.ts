import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Route-level auth coverage for POST /api/vendor/invoices/[id]/pay
 * (VD48/49's in-app manager payment): only a manager may start this
 * checkout, and only for an invoice billed to THEM — a vendor calling this
 * route (even for their own invoice) must be refused, and the flag-off path
 * must 404 before any auth/DB work runs. Uses the real
 * `assertManagerFinancialsAccess` (no DB call on the non-manager branch) and
 * the real route handler; only the auth context resolver and the checkout
 * starter are mocked.
 */

const flagState = vi.hoisted(() => ({ enabled: true }));
vi.mock("@/lib/vendor-banking/flag", () => ({ vendorBankingEnabled: () => flagState.enabled }));

const state = vi.hoisted(() => ({
  auth: null as { role: string; userId: string; email: string; db: unknown } | null,
}));
vi.mock("@/lib/reports/auth", async (orig) => {
  const actual = await orig<typeof import("@/lib/reports/auth")>();
  return {
    ...actual,
    getReportsAuthContext: async () => state.auth,
  };
});

const startVendorInvoicePayCheckout = vi.hoisted(() =>
  vi.fn(async () => ({ ok: true as const, clientSecret: "cs_test_secret", sessionId: "cs_1", invoiceCents: 10_000, platformFeeCents: 300 })),
);
vi.mock("@/lib/vendor-invoice-pay.server", () => ({ startVendorInvoicePayCheckout }));

async function callPay() {
  const { POST } = await import("@/app/api/vendor/invoices/[id]/pay/route");
  return POST(new Request("https://example.com/api/vendor/invoices/inv-1/pay", { method: "POST" }), {
    params: Promise.resolve({ id: "inv-1" }),
  });
}

describe("POST /api/vendor/invoices/[id]/pay auth", () => {
  beforeEach(() => {
    flagState.enabled = true;
    startVendorInvoicePayCheckout.mockClear();
  });

  it("404s when VENDOR_BANKING_ENABLED is off, before touching auth or the DB", async () => {
    flagState.enabled = false;
    state.auth = { role: "manager", userId: "manager_1", email: "m@test.proplane.local", db: {} };
    const res = await callPay();
    expect(res.status).toBe(404);
    expect(startVendorInvoicePayCheckout).not.toHaveBeenCalled();
  });

  it("401s an unauthenticated caller", async () => {
    state.auth = null;
    const res = await callPay();
    expect(res.status).toBe(401);
    expect(startVendorInvoicePayCheckout).not.toHaveBeenCalled();
  });

  it("403s a vendor caller — a vendor can never pay through this route, even their own invoice", async () => {
    state.auth = { role: "vendor", userId: "vendor_1", email: "v@test.proplane.local", db: {} };
    const res = await callPay();
    const json = await res.json();
    expect(res.status).toBe(403);
    expect(json.error).toBe("Forbidden.");
    expect(startVendorInvoicePayCheckout).not.toHaveBeenCalled();
  });

  it("403s a resident caller", async () => {
    state.auth = { role: "resident", userId: "resident_1", email: "r@test.proplane.local", db: {} };
    const res = await callPay();
    expect(res.status).toBe(403);
    expect(startVendorInvoicePayCheckout).not.toHaveBeenCalled();
  });

  it("lets a manager through — the checkout starter itself scopes the invoice to that manager's own id (never trusts the body)", async () => {
    state.auth = { role: "manager", userId: "manager_1", email: "m@test.proplane.local", db: {} };
    const res = await callPay();
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.clientSecret).toBe("cs_test_secret");
    expect(startVendorInvoicePayCheckout).toHaveBeenCalledWith(
      {},
      expect.objectContaining({ invoiceId: "inv-1", managerUserId: "manager_1" }),
    );
  });
});
