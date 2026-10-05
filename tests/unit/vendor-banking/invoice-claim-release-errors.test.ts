import { describe, expect, it, vi } from "vitest";

/**
 * A half-done release is never left for the next caller to tidy: nothing else runs the sweep (the
 * session has already fired its one `expired` event) and a retried payment goes through
 * `claim_vendor_invoice_payment`, whose unguarded insert would hit the (work order, invoice)
 * unique index. So every database failure here throws, and the webhook answers 500 and is
 * redelivered.
 */
vi.mock("server-only", () => ({}));

const { releaseInvoicePaymentClaim, readInvoicePaymentClaimId } = await import("@/lib/vendor-invoice-claim.server");

type Outcome = { data: unknown; error: { message: string } | null };

/** Returns `outcomes[table + mode]`, so one query in the chain can be made to fail. */
function failingDb(outcomes: Record<string, Outcome>) {
  return {
    from(table: string) {
      let mode = "select";
      const q: Record<string, unknown> = {
        select: () => q,
        update: () => ((mode = "update"), q),
        delete: () => ((mode = "delete"), q),
        eq: () => q,
        neq: () => q,
        maybeSingle: async () => outcomes[`${table}:${mode}`] ?? { data: null, error: null },
        then: (resolve: (v: Outcome) => unknown) =>
          Promise.resolve(outcomes[`${table}:${mode}`] ?? { data: null, error: null }).then(resolve),
      };
      return q;
    },
  };
}

describe("releaseInvoicePaymentClaim surfaces database failures", () => {
  it("throws when the compare-and-swap fails", async () => {
    const db = failingDb({ "vendor_invoices:update": { data: null, error: { message: "deadlock detected" } } });
    await expect(releaseInvoicePaymentClaim(db as never, "manager_1", "inv_1", "stripe")).rejects.toThrow(/deadlock detected/);
  });

  it("throws when the invoice re-read fails, rather than guessing the claim is free", async () => {
    const db = failingDb({ "vendor_invoices:select": { data: null, error: { message: "connection reset" } } });
    await expect(releaseInvoicePaymentClaim(db as never, "manager_1", "inv_1", "stripe")).rejects.toThrow(/connection reset/);
  });

  it("throws when the pending-payout sweep fails, so the caller retries instead of orphaning the row", async () => {
    const db = failingDb({
      "vendor_invoices:update": { data: { id: "inv_1" }, error: null },
      "vendor_invoices:select": { data: { payment_claim: null, status: "approved" }, error: null },
      "vendor_payouts:delete": { data: null, error: { message: "permission denied" } },
    });
    await expect(releaseInvoicePaymentClaim(db as never, "manager_1", "inv_1", "stripe")).rejects.toThrow(/permission denied/);
  });

  it("readInvoicePaymentClaimId throws rather than reporting a claim that may exist as missing", async () => {
    const db = failingDb({ "vendor_payouts:select": { data: null, error: { message: "connection reset" } } });
    await expect(readInvoicePaymentClaimId(db as never, "manager_1", "inv_1")).rejects.toThrow(/connection reset/);
  });
});
