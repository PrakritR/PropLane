import { beforeEach, describe, expect, it, vi } from "vitest";

const { auth, identity, invoicesList } = vi.hoisted(() => ({
  auth: vi.fn(),
  identity: vi.fn(),
  invoicesList: vi.fn(),
}));
vi.mock("@/lib/manager-route-guard.server", () => ({ requireManagerRouteUser: auth }));
vi.mock("@/lib/manager-stripe-customer.server", () => ({ loadManagerBillingIdentity: identity }));
vi.mock("@/lib/stripe", () => ({
  getStripe: () => ({ invoices: { list: invoicesList }, paymentIntents: { retrieve: vi.fn() } }),
}));

import { GET } from "@/app/api/manager/invoices/route";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("GET /api/manager/invoices", () => {
  it("403s a non-manager without touching Stripe", async () => {
    auth.mockResolvedValue(null);

    const res = await GET();

    expect(res.status).toBe(403);
    expect(identity).not.toHaveBeenCalled();
    expect(invoicesList).not.toHaveBeenCalled();
  });

  it("lists Stripe invoices and paid credit purchases, newest first, with server-minted URLs", async () => {
    auth.mockResolvedValue({
      userId: "mgr-1",
      db: {
        from: () => ({
          select: () => ({
            eq: () => ({
              order: () => ({
                limit: async () => ({
                  data: [
                    {
                      id: "credit-1",
                      credit_cents: 2000,
                      status: "paid",
                      created_at: "2026-09-20T00:00:00Z",
                      receipt_url: "https://stripe.example/receipt/credit-1",
                      stripe_payment_intent_id: null,
                    },
                    {
                      id: "credit-pending",
                      credit_cents: 1000,
                      status: "pending",
                      created_at: "2026-09-19T00:00:00Z",
                      receipt_url: null,
                      stripe_payment_intent_id: null,
                    },
                  ],
                  error: null,
                }),
              }),
            }),
          }),
        }),
      },
    });
    identity.mockResolvedValue({ customerId: "cus_1" });
    invoicesList.mockResolvedValue({
      data: [
        {
          id: "in_1",
          created: Math.floor(Date.parse("2026-09-01T00:00:00Z") / 1000),
          total: 20000,
          status: "paid",
          hosted_invoice_url: "https://stripe.example/invoice/in_1",
          invoice_pdf: null,
        },
      ],
    });

    const res = await GET();
    const body = (await res.json()) as { invoices: { id: string; totalCents: number; status: string; url: string | null }[] };

    expect(res.status).toBe(200);
    // Pending credit purchases never appear as a paid invoice row.
    expect(body.invoices.map((row) => row.id)).toEqual(["credit-1", "in_1"]);
    expect(body.invoices[0]).toMatchObject({ totalCents: 2000, status: "Paid · credit", url: "https://stripe.example/receipt/credit-1" });
    expect(body.invoices[1]).toMatchObject({ totalCents: 20000, status: "Paid", url: "https://stripe.example/invoice/in_1" });
  });
});
