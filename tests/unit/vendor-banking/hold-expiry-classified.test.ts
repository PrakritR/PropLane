import { beforeEach, describe, expect, it, vi } from "vitest";

const deliver = vi.fn().mockResolvedValue({ ok: true, recipientCount: 1 });
vi.mock("@/lib/portal-inbox-delivery", () => ({ deliverPortalInboxMessage: (...a: unknown[]) => deliver(...a) }));
const submitVendorRefund = vi.fn();
vi.mock("@/lib/vendor-banking/central-refund.server", () => ({ submitVendorRefund: (...a: unknown[]) => submitVendorRefund(...a) }));

import { expireVendorHolds, listExpiredVendorHolds } from "@/lib/vendor-banking/hold-expiry.server";

type Row = Record<string, unknown>;

/** Fake that APPLIES the .in/.is/.lt/.eq filters so the listing predicate is really exercised. */
function makeDb(holds: Row[], payouts: Row[], extra: { invoices?: Row[]; profiles?: Row[] } = {}) {
  return {
    from(table: string) {
      const filters: Array<(r: Row) => boolean> = [];
      const rows = table === "platform_payment_holds" ? holds : table === "vendor_payouts" ? payouts
        : table === "vendor_invoices" ? extra.invoices ?? [] : table === "profiles" ? extra.profiles ?? [] : [];
      const q: Record<string, unknown> = {
        select: () => q,
        eq: (c: string, v: unknown) => (filters.push((r) => r[c] === v), q),
        in: (c: string, v: unknown[]) => (filters.push((r) => v.includes(r[c])), q),
        is: (c: string, v: unknown) => (filters.push((r) => (r[c] ?? null) === v), q),
        lt: (c: string, v: string) => (filters.push((r) => String(r[c]) < v), q),
        limit: () => q,
        maybeSingle: () => Promise.resolve({ data: (rows.filter((r) => filters.every((f) => f(r)))[0]) ?? null, error: null }),
        then: (resolve: (v: unknown) => unknown) =>
          Promise.resolve(resolve({ data: rows.filter((r) => filters.every((f) => f(r))), error: null })),
      };
      return q;
    },
  };
}

const daysAgo = (d: number) => new Date(Date.now() - d * 86400000).toISOString();
const hold = (over: Row): Row => ({
  id: "h", source: "vendor_invoice", status: "classified_held", created_at: daysAgo(100), owner_user_id: "v1",
  owner_role: "vendor", amount_cents: 1000, source_id: "inv_1", stripe_charge_id: "ch_1", stripe_transfer_id: null, ...over,
});

describe("vendor hold expiry covers classified_held", () => {
  beforeEach(() => { submitVendorRefund.mockReset(); deliver.mockClear(); });

  it("lists held + classified_held, skips transferred, transfer-id and young holds", async () => {
    const db = makeDb(
      [
        hold({ id: "a", status: "held" }),
        hold({ id: "b", status: "classified_held" }),
        hold({ id: "c", status: "transferred" }),
        hold({ id: "d", stripe_transfer_id: "tr_1" }),
        hold({ id: "e", created_at: daysAgo(10) }),
        hold({ id: "f", status: "refunded" }),
      ],
      [],
    );
    const rows = await listExpiredVendorHolds(db as never);
    expect(rows.map((r) => r.id).sort()).toEqual(["a", "b"]);
  });

  it("refunds a classified_held hold once through the central rail, keyed by hold id (idempotent re-run)", async () => {
    submitVendorRefund.mockResolvedValue({ ok: true, status: "succeeded", replay: false });
    const db = makeDb([hold({ id: "b" })], [{ id: "p1", platform_hold_id: "b", vendor_user_id: "v1" }]);
    const stripe = { refunds: { create: vi.fn() } };
    const first = await expireVendorHolds(stripe as never, db as never);
    expect(first).toMatchObject({ checked: 1, returned: 1, failed: 0 });
    expect(submitVendorRefund).toHaveBeenCalledTimes(1);
    expect(submitVendorRefund.mock.calls[0]![2]).toMatchObject({ payoutId: "p1", vendorUserId: "v1", clientKey: "hold-expiry-b" });
    expect(stripe.refunds.create).not.toHaveBeenCalled();
    // Re-run: same key every time, so the rail replays instead of refunding twice.
    await expireVendorHolds(stripe as never, db as never);
    expect(submitVendorRefund.mock.calls[1]![2]).toMatchObject({ clientKey: "hold-expiry-b" });
  });

  it("reports a failure when there is no payout row or the rail refuses", async () => {
    const db = makeDb([hold({ id: "b" })], []);
    const r1 = await expireVendorHolds({} as never, db as never);
    expect(r1.failed).toBe(1);
    submitVendorRefund.mockResolvedValue({ ok: false, status: 409, error: "nope" });
    const db2 = makeDb([hold({ id: "b" })], [{ id: "p1", platform_hold_id: "b", vendor_user_id: "v1" }]);
    const r2 = await expireVendorHolds({} as never, db2 as never);
    expect(r2).toMatchObject({ returned: 0, failed: 1 });
  });

  it("sends the returned-unclaimed notice to manager and vendor with the GROSS amount, deduped by hold id", async () => {
    submitVendorRefund.mockResolvedValue({ ok: true, status: "succeeded", replay: false, grossCents: 1030 });
    const db = makeDb(
      [hold({ id: "b", amount_cents: 1000 })],
      [{ id: "p1", platform_hold_id: "b", vendor_user_id: "v1" }],
      {
        invoices: [{ id: "inv_1", manager_user_id: "m1", invoice_number: "42" }],
        profiles: [{ id: "m1", email: "m@x.test" }, { id: "v1", email: "v@x.test" }],
      },
    );
    await expireVendorHolds({} as never, db as never);
    // The rail is asked for the full remaining gross (no requestedGrossCents cap).
    expect(submitVendorRefund.mock.calls[0]![2]).not.toHaveProperty("requestedGrossCents");
    expect(submitVendorRefund.mock.calls[0]![2]).toMatchObject({ initiatedBy: "hold_expiry" });
    expect(deliver).toHaveBeenCalledTimes(2);
    const byId = Object.fromEntries(deliver.mock.calls.map((c) => [(c[1] as Row).messageId, c[1] as Row]));
    expect(byId["hold-expiry:b:manager"]).toMatchObject({ toUserIds: ["m1"], subject: "A held vendor payment was returned to you" });
    expect(String(byId["hold-expiry:b:manager"]!.text)).toContain("$10.30");
    expect(byId["hold-expiry:b:vendor"]).toMatchObject({ toUserIds: ["v1"] });
    // Re-run (replayed refund): same deterministic ids, so the delivery layer appends each once.
    submitVendorRefund.mockResolvedValue({ ok: true, status: "succeeded", replay: true, grossCents: 1030 });
    await expireVendorHolds({} as never, db as never);
    const ids = deliver.mock.calls.map((c) => (c[1] as Row).messageId);
    expect(new Set(ids).size).toBe(2);
  });

  it("no notices when the rail refuses", async () => {
    submitVendorRefund.mockResolvedValue({ ok: false, status: 409, error: "nope" });
    const db = makeDb([hold({ id: "b" })], [{ id: "p1", platform_hold_id: "b", vendor_user_id: "v1" }]);
    await expireVendorHolds({} as never, db as never);
    expect(deliver).not.toHaveBeenCalled();
  });
});
