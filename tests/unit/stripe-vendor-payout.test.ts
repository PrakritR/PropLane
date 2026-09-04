import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/stripe", () => ({ getStripe: vi.fn() }));
vi.mock("@/lib/stripe-connect", () => ({
  retrieveManagerConnectAccountOrNull: vi.fn(),
  connectAccountTransfersActive: vi.fn(),
}));

import { getStripe } from "@/lib/stripe";
import { retrieveManagerConnectAccountOrNull, connectAccountTransfersActive } from "@/lib/stripe-connect";
import { payoutVendorForWorkOrder } from "@/lib/stripe-vendor-payout";

type Row = Record<string, unknown>;

/**
 * Minimal fake Supabase client covering vendor_payouts / work_order_bids /
 * profiles reads+writes.
 *
 * `bids` is the FULL bid list for the work order, not just the accepted one:
 * the payout distinguishes "no bidding happened" (fall back to the caller's
 * amount) from "bids exist but none is accepted" (anchor missing — pay
 * nothing), and it can only tell those apart by reading them all.
 *
 * `existingPayoutStatus` is the status of a payout row that already exists for
 * this work order, i.e. what the claim insert loses to.
 */
function fakeDb(opts: {
  bids?: Array<{ amount_cents: number | null; status: string | null }>;
  connectAccountId?: string | null;
  existingPayoutStatus?: "pending" | "paid" | "failed" | null;
}) {
  const inserted: Row[] = [];
  const updated: Row[] = [];
  /** `(column, value)` pairs each update was filtered on, per update. */
  const updateFilters: Array<Array<[string, unknown]>> = [];

  const client = {
    from(table: string) {
      if (table === "work_order_bids") {
        const builder: Record<string, unknown> = {
          select: () => builder,
          eq: () => builder,
          then: (resolve: (v: unknown) => unknown) =>
            Promise.resolve({ data: opts.bids ?? [], error: null }).then(resolve),
        };
        return builder;
      }
      if (table === "profiles") {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({ data: { stripe_connect_account_id: opts.connectAccountId ?? null }, error: null }),
            }),
          }),
        };
      }
      if (table === "vendor_payouts") {
        return {
          insert: (row: Row) => {
            const conflicted = opts.existingPayoutStatus != null;
            const builder: Record<string, unknown> = {
              select: () => builder,
              maybeSingle: async () => {
                if (conflicted) return { data: null, error: { message: "duplicate key" } };
                inserted.push(row);
                return { data: { id: "payout-1" }, error: null };
              },
            };
            return builder;
          },
          update: (row: Row) => {
            const filters: Array<[string, unknown]> = [];
            const record = () => {
              updated.push(row);
              updateFilters.push(filters);
            };
            const builder: Record<string, unknown> = {
              eq: (column: string, value: unknown) => {
                filters.push([column, value]);
                return builder;
              },
              select: () => builder,
              // The re-claim swap: it only matches when the stored row really is failed.
              maybeSingle: async () => {
                const wanted = filters.find(([c]) => c === "status")?.[1];
                if (wanted !== undefined && wanted !== opts.existingPayoutStatus) {
                  return { data: null, error: null };
                }
                record();
                return { data: { id: "payout-1" }, error: null };
              },
              // `finish()` awaits the update directly.
              then: (resolve: (v: unknown) => unknown) => {
                record();
                return Promise.resolve({ error: null }).then(resolve);
              },
            };
            return builder;
          },
        };
      }
      throw new Error(`unexpected table ${table}`);
    },
  };
  return { client, inserted, updated, updateFilters };
}

describe("payoutVendorForWorkOrder", () => {
  beforeEach(() => vi.clearAllMocks());

  it("anchors the transferred amount to the accepted bid, ignoring a forged caller amount", async () => {
    const { client, inserted, updated } = fakeDb({
      bids: [{ amount_cents: 20000, status: "accepted" }],
      connectAccountId: "acct_1",
    });
    vi.mocked(getStripe).mockReturnValue({
      transfers: { create: vi.fn().mockResolvedValue({ id: "tr_1" }) },
    } as never);
    vi.mocked(retrieveManagerConnectAccountOrNull).mockResolvedValue({ id: "acct_1" } as never);
    vi.mocked(connectAccountTransfersActive).mockReturnValue(true);

    await payoutVendorForWorkOrder(client as never, {
      workOrderId: "WO-1",
      managerUserId: "mgr-1",
      vendorUserId: "vendor-1",
      amountCents: 999_999, // forged/mismatched client-supplied amount — must be ignored
    });

    expect(inserted[0]!.amount_cents).toBe(20000);
    const stripe = vi.mocked(getStripe).mock.results[0]!.value;
    expect(stripe.transfers.create).toHaveBeenCalledWith(
      expect.objectContaining({ amount: 20000 }),
      expect.objectContaining({ idempotencyKey: "vendor-payout:WO-1" }),
    );
    expect(updated[0]).toMatchObject({ status: "paid", stripe_transfer_id: "tr_1" });
  });

  it("falls back to the caller-supplied amount when no bid was accepted (manual assignment)", async () => {
    const { client, inserted } = fakeDb({ bids: [], connectAccountId: "acct_1" });
    vi.mocked(getStripe).mockReturnValue({
      transfers: { create: vi.fn().mockResolvedValue({ id: "tr_2" }) },
    } as never);
    vi.mocked(retrieveManagerConnectAccountOrNull).mockResolvedValue({ id: "acct_1" } as never);
    vi.mocked(connectAccountTransfersActive).mockReturnValue(true);

    await payoutVendorForWorkOrder(client as never, {
      workOrderId: "WO-2",
      managerUserId: "mgr-1",
      vendorUserId: "vendor-1",
      amountCents: 15000,
    });

    expect(inserted[0]!.amount_cents).toBe(15000);
  });

  it("never calls Stripe when the payout claim insert loses the race (duplicate/concurrent request)", async () => {
    const { client } = fakeDb({
      bids: [{ amount_cents: 5000, status: "accepted" }],
      connectAccountId: "acct_1",
      existingPayoutStatus: "pending",
    });
    const transferCreate = vi.fn().mockResolvedValue({ id: "tr_3" });
    vi.mocked(getStripe).mockReturnValue({ transfers: { create: transferCreate } } as never);

    await payoutVendorForWorkOrder(client as never, {
      workOrderId: "WO-3",
      managerUserId: "mgr-1",
      vendorUserId: "vendor-1",
      amountCents: 5000,
    });

    expect(transferCreate).not.toHaveBeenCalled();
  });

  it("records a failed payout without transferring when the vendor has no Connect account", async () => {
    const { client, inserted, updated } = fakeDb({
      bids: [{ amount_cents: 5000, status: "accepted" }],
      connectAccountId: null,
    });
    const transferCreate = vi.fn();
    vi.mocked(getStripe).mockReturnValue({ transfers: { create: transferCreate } } as never);

    await payoutVendorForWorkOrder(client as never, {
      workOrderId: "WO-4",
      managerUserId: "mgr-1",
      vendorUserId: "vendor-1",
      amountCents: 5000,
    });

    expect(transferCreate).not.toHaveBeenCalled();
    expect(inserted[0]!.status).toBe("pending");
    expect(updated[0]).toMatchObject({ status: "failed" });
  });

  // PRP-231. A bid re-priced by an accept race lands here as "submitted", so
  // the accepted-bid lookup finds nothing. Falling back to the caller's number
  // would turn that data race into a payment nobody verified.
  it("pays nothing when the job was bid but no bid is accepted", async () => {
    const { client, inserted } = fakeDb({
      bids: [{ amount_cents: 20000, status: "submitted" }],
      connectAccountId: "acct_1",
    });
    const transferCreate = vi.fn();
    vi.mocked(getStripe).mockReturnValue({ transfers: { create: transferCreate } } as never);

    await payoutVendorForWorkOrder(client as never, {
      workOrderId: "WO-5",
      managerUserId: "mgr-1",
      vendorUserId: "vendor-1",
      amountCents: 999_999,
    });

    expect(inserted).toHaveLength(0);
    expect(transferCreate).not.toHaveBeenCalled();
  });

  // PRP-233. `vendor_payouts.work_order_id` is unique and the only caller fires
  // once, at approval — so a vendor who had not finished Stripe Connect at that
  // moment was left with a permanently "failed" row and no mechanism anywhere in
  // the product that would ever try again. A failed payout is now re-claimable.
  it("retries a failed payout once the vendor has connected Stripe", async () => {
    const { client, updated, updateFilters } = fakeDb({
      bids: [{ amount_cents: 20000, status: "accepted" }],
      connectAccountId: "acct_1",
      existingPayoutStatus: "failed",
    });
    const transferCreate = vi.fn().mockResolvedValue({ id: "tr_retry" });
    vi.mocked(getStripe).mockReturnValue({ transfers: { create: transferCreate } } as never);
    vi.mocked(retrieveManagerConnectAccountOrNull).mockResolvedValue({ id: "acct_1" } as never);
    vi.mocked(connectAccountTransfersActive).mockReturnValue(true);

    await payoutVendorForWorkOrder(client as never, {
      workOrderId: "WO-6",
      managerUserId: "mgr-1",
      vendorUserId: "vendor-1",
      amountCents: 20000,
    });

    // The re-claim is a compare-and-swap on the failed status, so two concurrent
    // re-drives still produce exactly one transfer.
    expect(updateFilters[0]).toContainEqual(["status", "failed"]);
    expect(updated[0]).toMatchObject({ status: "pending", failure_reason: null });
    expect(transferCreate).toHaveBeenCalledTimes(1);
    expect(updated.at(-1)).toMatchObject({ status: "paid", stripe_transfer_id: "tr_retry" });
  });

  /**
   * The manager's bookkeeping succeeds whether or not the transfer does, so the
   * outcome is the only way anything downstream can learn a vendor is owed
   * money. Before this the function returned void and the failure lived solely
   * in a vendor_payouts row with no surface (PRP-233).
   */
  it("reports the outcome so the caller can tell somebody", async () => {
    const paid = fakeDb({ bids: [{ amount_cents: 20000, status: "accepted" }], connectAccountId: "acct_1" });
    vi.mocked(getStripe).mockReturnValue({
      transfers: { create: vi.fn().mockResolvedValue({ id: "tr_ok" }) },
    } as never);
    vi.mocked(retrieveManagerConnectAccountOrNull).mockResolvedValue({ id: "acct_1" } as never);
    vi.mocked(connectAccountTransfersActive).mockReturnValue(true);
    await expect(
      payoutVendorForWorkOrder(paid.client as never, {
        workOrderId: "WO-OK",
        managerUserId: "mgr-1",
        vendorUserId: "vendor-1",
        amountCents: 20000,
      }),
    ).resolves.toEqual({ status: "paid", amountCents: 20000 });

    const noAccount = fakeDb({ bids: [{ amount_cents: 20000, status: "accepted" }], connectAccountId: null });
    const failed = await payoutVendorForWorkOrder(noAccount.client as never, {
      workOrderId: "WO-NOACCT",
      managerUserId: "mgr-1",
      vendorUserId: "vendor-1",
      amountCents: 20000,
    });
    expect(failed.status).toBe("failed");
    // The amount is carried so the notice can name what is owed.
    expect(failed.amountCents).toBe(20000);
    expect(failed.failureReason).toMatch(/has not connected a Stripe payout account/i);

    const nothingOwed = fakeDb({ bids: [{ amount_cents: 20000, status: "submitted" }], connectAccountId: "acct_1" });
    await expect(
      payoutVendorForWorkOrder(nothingOwed.client as never, {
        workOrderId: "WO-NOANCHOR",
        managerUserId: "mgr-1",
        vendorUserId: "vendor-1",
        amountCents: 20000,
      }),
    ).resolves.toMatchObject({ status: "skipped" });
  });

  it("does not re-claim a payout that already succeeded", async () => {
    const { client, updated } = fakeDb({
      bids: [{ amount_cents: 20000, status: "accepted" }],
      connectAccountId: "acct_1",
      existingPayoutStatus: "paid",
    });
    const transferCreate = vi.fn();
    vi.mocked(getStripe).mockReturnValue({ transfers: { create: transferCreate } } as never);

    await payoutVendorForWorkOrder(client as never, {
      workOrderId: "WO-7",
      managerUserId: "mgr-1",
      vendorUserId: "vendor-1",
      amountCents: 20000,
    });

    expect(transferCreate).not.toHaveBeenCalled();
    expect(updated).toHaveLength(0);
  });
});
