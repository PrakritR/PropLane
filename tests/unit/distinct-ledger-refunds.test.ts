import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
vi.mock("@/lib/reports/gl-posting", () => ({ postGlPaymentEntry: vi.fn(), postGlChargeEntry: vi.fn() }));
import { syncLedgerRefundEntry } from "@/lib/reports/ledger-sync";
describe("provider refund ledger identities", () => {
  it("retains two partial refunds and makes redelivery idempotent", async () => {
    const rows = new Map<string, { amount_cents: number }>();
    const db = { from: () => ({ upsert: (row: { stripe_refund_id: string; amount_cents: number }, options: { onConflict: string }) => {
      expect(options.onConflict).toBe("source_charge_id,entry_type,stripe_refund_id");
      rows.set(row.stripe_refund_id, row);
      return { select: () => ({ single: async () => ({ data: { id: row.stripe_refund_id }, error: null }) }) };
    } }) } as unknown as SupabaseClient;
    const input = { managerUserId: "11111111-1111-4111-8111-111111111111", sourceChargeId: "charge-a", categoryCode: "rent", amountCents: 1234, postedDate: "2026-10-02", stripeChargeId: "ch_a", stripeRefundId: "re_a" };
    await syncLedgerRefundEntry(db, input);
    await syncLedgerRefundEntry(db, { ...input, stripeRefundId: "re_b", amountCents: 456 });
    await syncLedgerRefundEntry(db, input);
    expect([...rows.values()].reduce((sum, row) => sum + row.amount_cents, 0)).toBe(1690);
    expect(rows.size).toBe(2);
  });
});
