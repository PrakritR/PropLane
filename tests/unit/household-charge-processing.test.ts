import { describe, expect, it, vi } from "vitest";
import type Stripe from "stripe";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  householdChargeCheckoutProcessing,
  markHouseholdChargeProcessingFromStripeSession,
  revertHouseholdChargeProcessingFromStripeSession,
} from "@/lib/stripe-household-charge";

vi.mock("@/lib/test-workspaces/effects.server", () => ({
  captureTestWorkspaceEffectForUser: vi.fn().mockResolvedValue({ captured: false }),
}));

function session(overrides: Partial<Stripe.Checkout.Session>): Stripe.Checkout.Session {
  return {
    id: "cs_test_1",
    status: "complete",
    payment_status: "unpaid",
    metadata: { purpose: "household_charge", charge_ids: "ch_1" },
    ...overrides,
  } as unknown as Stripe.Checkout.Session;
}

/** Chainable mock over one charge row; records upserts. */
function mockDb(charge: Record<string, unknown> | null) {
  const upserts: Array<Record<string, unknown>> = [];
  const chain: Record<string, unknown> = {};
  chain.select = () => chain;
  chain.eq = () => chain;
  chain.maybeSingle = async () => ({
    data: charge ? { id: "ch_1", status: (charge as { status?: string }).status, row_data: charge } : null,
  });
  const db = {
    from: () => ({
      ...chain,
      upsert: async (row: Record<string, unknown>) => {
        upserts.push(row);
        return { error: null };
      },
    }),
  } as unknown as SupabaseClient;
  return { db, upserts };
}

const BASE_CHARGE = {
  id: "ch_1",
  residentEmail: "res@example.com",
  managerUserId: "mgr_1",
  residentUserId: "res_1",
  propertyId: "prop_1",
  kind: "rent",
  title: "Rent",
  amountLabel: "$2,000.00",
  balanceLabel: "$2,000.00",
};

describe("ACH clearing-window status transitions", () => {
  it("detects a submitted-but-unsettled checkout session", () => {
    expect(householdChargeCheckoutProcessing(session({}))).toBe(true);
    expect(householdChargeCheckoutProcessing(session({ payment_status: "paid" } as never))).toBe(false);
  });

  it("pending → processing when the ACH debit is submitted", async () => {
    const { db, upserts } = mockDb({ ...BASE_CHARGE, status: "pending" });
    const result = await markHouseholdChargeProcessingFromStripeSession(db, session({}));
    expect(result.ok).toBe(true);
    expect(upserts).toHaveLength(1);
    expect(upserts[0]!.status).toBe("processing");
    expect((upserts[0]!.row_data as { status: string }).status).toBe("processing");
  });

  it("never downgrades a paid charge to processing", async () => {
    const { db, upserts } = mockDb({ ...BASE_CHARGE, status: "paid" });
    const result = await markHouseholdChargeProcessingFromStripeSession(db, session({}));
    expect(result.ok).toBe(false);
    expect(upserts).toHaveLength(0);
  });

  it("only marks processing for genuinely unsettled sessions", async () => {
    const { db, upserts } = mockDb({ ...BASE_CHARGE, status: "pending" });
    const result = await markHouseholdChargeProcessingFromStripeSession(
      db,
      session({ payment_status: "paid" } as never),
    );
    expect(result.ok).toBe(false);
    expect(upserts).toHaveLength(0);
  });

  it("async_payment_failed reverts processing → pending (payable again)", async () => {
    const { db, upserts } = mockDb({ ...BASE_CHARGE, status: "processing" });
    const result = await revertHouseholdChargeProcessingFromStripeSession(db, session({}));
    expect(result.ok).toBe(true);
    expect(upserts[0]!.status).toBe("pending");
  });

  it("revert never touches charges the failed-intent handler already marked failed (no double transition)", async () => {
    const { db, upserts } = mockDb({ ...BASE_CHARGE, status: "failed" });
    const result = await revertHouseholdChargeProcessingFromStripeSession(db, session({}));
    expect(result.ok).toBe(false);
    expect(upserts).toHaveLength(0);
  });
});
