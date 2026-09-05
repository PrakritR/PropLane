import { beforeEach, describe, expect, it, vi } from "vitest";

// vi.mock factories are hoisted above these declarations, so the spies have to
// be created inside vi.hoisted or the factory sees them uninitialised.
const { invoiceItemCreate, invoiceCreate, invoiceFinalize, purchaseSku } = vi.hoisted(() => ({
  invoiceItemCreate: vi.fn(),
  invoiceCreate: vi.fn(),
  invoiceFinalize: vi.fn(),
  purchaseSku: vi.fn(),
}));

vi.mock("@/lib/stripe", () => ({
  getStripe: () => ({
    invoiceItems: { create: invoiceItemCreate },
    invoices: { create: invoiceCreate, finalizeInvoice: invoiceFinalize },
  }),
}));

vi.mock("@/lib/manager-access-server", () => ({ getManagerPurchaseSku: purchaseSku }));

import { invoiceManagerCommsUsage } from "@/lib/comms-billing/stripe-invoicing.server";

const USAGE = [
  { id: "evt-1", meter: "sms_outbound_segment", quantity: 10, total_cents: 30 },
  { id: "evt-2", meter: "ai_agent_turn", quantity: 2, total_cents: 30 },
];

function db(opts: { usage?: typeof USAGE; hasCard?: boolean; updateError?: string } = {}) {
  const updates: Record<string, unknown>[] = [];
  const from = vi.fn((table: string) => {
    if (table === "manager_comms_usage_events") {
      return {
        select: () => ({
          eq: () => ({
            is: () => ({
              order: () => ({
                limit: async () => ({ data: opts.usage ?? USAGE, error: null }),
              }),
            }),
          }),
        }),
        update: (patch: Record<string, unknown>) => {
          updates.push(patch);
          const err = opts.updateError ? { message: opts.updateError } : null;
          // Each link must be BOTH awaitable and chainable: the code does
          // .update().eq().is().select() to claim, .update().eq() to stamp the
          // item id, and .update().eq().is() to release a failed claim.
          const result = { data: err ? null : [{ id: "evt" }], error: err };
          const leaf = {
            select: async () => result,
            then: (res: (v: typeof result) => unknown) => res(result),
          };
          return { eq: () => ({ ...leaf, is: () => leaf }) };
        },
      };
    }
    return {
      select: () => ({
        eq: () => ({
          maybeSingle: async () => ({
            data: { has_default_payment_method: opts.hasCard ?? true },
          }),
        }),
      }),
      update: () => ({ eq: async () => ({ error: null }) }),
    };
  });
  return { client: { from } as never, updates };
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.COMMS_PAYG_BILLING_ENABLED = "1";
  purchaseSku.mockResolvedValue({ stripeCustomerId: "cus_123" });
  invoiceItemCreate.mockImplementation(async (_a, _b) => ({ id: `ii_${invoiceItemCreate.mock.calls.length}` }));
  invoiceCreate.mockResolvedValue({ id: "in_1" });
  invoiceFinalize.mockResolvedValue({ id: "in_1" });
});

describe("invoiceManagerCommsUsage", () => {
  it("bills each usage event once and finalizes one invoice", async () => {
    const { client, updates } = db();
    const res = await invoiceManagerCommsUsage(client, "mgr-1");
    expect(res).toMatchObject({ ok: true, invoiced: true, invoiceId: "in_1", itemCount: 2, totalCents: 60 });
    expect(invoiceItemCreate).toHaveBeenCalledTimes(2);
    expect(invoiceFinalize).toHaveBeenCalledWith("in_1", { auto_advance: true });
    // Claimed BEFORE the charge, then stamped with the item id after. The claim
    // is what stops a 24h-expired idempotency key double-charging next run.
    expect(updates.some((u) => u.billed_at)).toBe(true);
    expect(updates.some((u) => u.stripe_invoice_item_id)).toBe(true);
    // Every item is attached to THIS invoice, so a pending subscription
    // proration on the customer is never swept into a usage invoice.
    for (const call of invoiceItemCreate.mock.calls) {
      expect(call[0]).toMatchObject({ invoice: "in_1" });
    }
  });

  it("keys each invoice item on the usage event id, so a retry cannot double-charge", async () => {
    const { client } = db();
    await invoiceManagerCommsUsage(client, "mgr-1");
    const keys = invoiceItemCreate.mock.calls.map((c) => c[1]?.idempotencyKey);
    expect(keys).toEqual(["proplane_comms_usage_evt-1", "proplane_comms_usage_evt-2"]);
  });

  it("charges nothing when there is no card on file", async () => {
    const { client } = db({ hasCard: false });
    const res = await invoiceManagerCommsUsage(client, "mgr-1");
    expect(res).toEqual({ ok: true, invoiced: false, reason: "no_payment_method" });
    expect(invoiceItemCreate).not.toHaveBeenCalled();
  });

  it("charges nothing when the manager has no Stripe customer", async () => {
    purchaseSku.mockResolvedValue({ stripeCustomerId: null });
    const { client } = db();
    const res = await invoiceManagerCommsUsage(client, "mgr-1");
    expect(res).toEqual({ ok: true, invoiced: false, reason: "no_customer" });
    expect(invoiceItemCreate).not.toHaveBeenCalled();
  });

  it("is inert while the feature flag is off", async () => {
    process.env.COMMS_PAYG_BILLING_ENABLED = "0";
    const { client } = db();
    const res = await invoiceManagerCommsUsage(client, "mgr-1");
    expect(res).toEqual({ ok: true, invoiced: false, reason: "payg_disabled" });
    expect(invoiceItemCreate).not.toHaveBeenCalled();
  });

  it("stops if a charge cannot be recorded, rather than risking a re-bill", async () => {
    const { client } = db({ updateError: "db down" });
    const res = await invoiceManagerCommsUsage(client, "mgr-1");
    expect(res.ok).toBe(false);
    // The claim failed, so nothing was charged at all — the safe direction.
    expect(invoiceItemCreate).not.toHaveBeenCalled();
    expect(invoiceFinalize).not.toHaveBeenCalled();
  });

  it("does not invoice a manager with no outstanding usage", async () => {
    const { client } = db({ usage: [] });
    const res = await invoiceManagerCommsUsage(client, "mgr-1");
    expect(res).toEqual({ ok: true, invoiced: false, reason: "no_usage" });
  });
});
