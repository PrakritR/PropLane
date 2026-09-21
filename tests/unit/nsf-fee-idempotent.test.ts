/**
 * `handlePaymentIntentFailed` (src/lib/stripe-webhook-financials.ts) creates an NSF fee
 * for a declined payment. Stripe redelivers webhooks, so the same
 * `payment_intent.payment_failed` event can arrive twice for the same failed charge.
 * The NSF fee id is now deterministic (`nsfFeeIdForCharge`, no `Date.now()`), and the
 * handler reads that id before writing so a redelivery skips creating a second fee.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type Stripe from "stripe";
import type { HouseholdCharge } from "@/lib/household-charges";

vi.mock("@/lib/manager-billing-settings", () => ({
  loadManagerBillingSettings: vi.fn().mockResolvedValue({ nsfFeeEnabled: true, nsfFeeAmountCents: 3500 }),
}));
vi.mock("@/lib/reports/ledger-sync", () => ({
  syncLedgerChargeEntry: vi.fn().mockResolvedValue(undefined),
  syncLedgerRefundEntry: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/analytics/posthog", () => ({ track: vi.fn() }));
vi.mock("@/lib/test-workspaces/effects.server", () => ({
  captureTestWorkspaceEffectForUser: vi.fn().mockResolvedValue({ captured: false }),
}));
vi.mock("@/lib/domain-action-events.server", () => ({
  emitHouseholdChargeTransition: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/webhooks/deliver.server", () => ({
  enqueueWebhookEvent: vi.fn().mockResolvedValue(undefined),
}));

import { handlePaymentIntentFailed } from "@/lib/stripe-webhook-financials";
import { nsfFeeIdForCharge } from "@/lib/nsf-fees";

const MANAGER_ID = "mgr-nsf-1";
const CHARGE_ID = "hc_rent_1";
const RESIDENT_EMAIL = "resident@example.com";

function makeCharge(): HouseholdCharge {
  return {
    id: CHARGE_ID,
    createdAt: new Date().toISOString(),
    residentEmail: RESIDENT_EMAIL,
    residentName: "Resident One",
    residentUserId: null,
    propertyId: "prop-1",
    propertyLabel: "Test House",
    managerUserId: MANAGER_ID,
    kind: "rent",
    title: "Rent — October",
    amountLabel: "$1000.00",
    balanceLabel: "$1000.00",
    status: "pending",
    blocksLeaseUntilPaid: false,
  };
}

/** Minimal in-memory `portal_household_charge_records` table — enough for
 *  `handlePaymentIntentFailed` and the real (unmocked) `createNsfFeeForFailedPayment`
 *  read/write path to run against, across two webhook deliveries. */
function makeDb() {
  const rows = new Map<string, Record<string, unknown>>();
  function selectBuilder(id: string | null) {
    return {
      eq(_col: string, value: string) {
        return selectBuilder(value);
      },
      maybeSingle: async () => ({ data: id ? (rows.get(id) ?? null) : null, error: null }),
    };
  }
  return {
    rows,
    from(table: string) {
      if (table !== "portal_household_charge_records") {
        return {
          select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }),
          upsert: async () => ({ data: null, error: null }),
        };
      }
      return {
        select() {
          return selectBuilder(null);
        },
        upsert: async (row: Record<string, unknown>) => {
          rows.set(row.id as string, row);
          return { data: null, error: null };
        },
      };
    },
  };
}

function makePaymentIntent(): Stripe.PaymentIntent {
  return {
    id: "pi_test_1",
    object: "payment_intent",
    metadata: { charge_id: CHARGE_ID },
    last_payment_error: { message: "Your card was declined." },
  } as unknown as Stripe.PaymentIntent;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("NSF fee idempotency", () => {
  it("creates exactly one NSF charge across a redelivered failed-payment webhook", async () => {
    const db = makeDb();
    db.rows.set(CHARGE_ID, {
      id: CHARGE_ID,
      manager_user_id: MANAGER_ID,
      resident_email: RESIDENT_EMAIL,
      status: "pending",
      row_data: makeCharge(),
      updated_at: new Date().toISOString(),
    });

    await handlePaymentIntentFailed(db as never, makePaymentIntent());
    await handlePaymentIntentFailed(db as never, makePaymentIntent());

    const nsfFeeId = nsfFeeIdForCharge(CHARGE_ID);
    expect(db.rows.has(nsfFeeId)).toBe(true);
    const nsfRows = [...db.rows.values()].filter((r) => (r.row_data as HouseholdCharge).kind === "nsf_fee");
    expect(nsfRows).toHaveLength(1);
  });
});
