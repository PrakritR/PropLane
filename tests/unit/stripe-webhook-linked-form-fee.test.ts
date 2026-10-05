/**
 * A linked form's fee is real money charged to whoever submits the form. When that payer closes the tab before
 * returning, the Stripe webhook is the only thing that records it: it must mark the request paid (bound to the
 * checkout's own metadata), book the money in the ledger, and do both exactly once however often Stripe redelivers.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createLinkedFormFakeDb, type LinkedFormFakeDb } from "../helpers/linked-form-fake-db";

const state = vi.hoisted(() => ({ db: null as unknown, event: null as unknown }));
const spies = vi.hoisted(() => ({
  syncLedgerPaymentEntry: vi.fn(async () => undefined),
  enrichLedgerFromCheckoutSession: vi.fn(async () => undefined),
  creditHoldFromPaidSession: vi.fn(async () => ({ credited: true })),
  track: vi.fn(),
}));

vi.mock("next/headers", () => ({ headers: async () => ({ get: () => "sig" }) }));
vi.mock("@/lib/stripe", () => ({ getStripe: () => ({ webhooks: { constructEvent: () => state.event } }) }));
vi.mock("@/lib/supabase/service", () => ({ createSupabaseServiceRoleClient: () => state.db }));
vi.mock("@/lib/test-workspaces/effects.server", () => ({ captureTestWorkspaceEffectForUser: async () => ({ captured: false }) }));
vi.mock("@/lib/reports/ledger-sync", () => ({ syncLedgerPaymentEntry: spies.syncLedgerPaymentEntry }));
vi.mock("@/lib/stripe-ledger-fees", () => ({ enrichLedgerFromCheckoutSession: spies.enrichLedgerFromCheckoutSession }));
vi.mock("@/lib/stripe-platform-hold.server", () => ({ creditHoldFromPaidSession: spies.creditHoldFromPaidSession }));
vi.mock("@/lib/analytics/posthog", () => ({ track: spies.track }));

import { POST as webhook } from "@/app/api/stripe/webhook/route";
import { LINKED_FORM_FEE_PURPOSE } from "@/lib/linked-form-fee.server";

const REQUEST_ID = "44444444-4444-4444-8444-444444444444";
const SESSION_ID = "cs_test_linkedfee0001";

function seed(overrides: Record<string, unknown> = {}): LinkedFormFakeDb {
  return createLinkedFormFakeDb({
    application_form_requests: [
      {
        id: REQUEST_ID,
        manager_user_id: "11111111-1111-4111-8111-111111111111",
        application_id: "PROPLANE-APP00001",
        form_kind: "application",
        form_id: "cosigner-form",
        status: "shared",
        fee_cents: 4500,
        fee_session_id: null,
        fee_paid_at: null,
        fee_paid_by_user_id: null,
        ...overrides,
      },
    ],
    manager_application_records: [
      {
        id: "PROPLANE-APP00001",
        manager_user_id: "11111111-1111-4111-8111-111111111111",
        property_id: "property-1",
        assigned_property_id: null,
        resident_email: "ava@example.com",
        row_data: { id: "PROPLANE-APP00001", name: "Ava Lee", email: "ava@example.com", property: "12 Alder St" },
      },
    ],
    portal_household_charge_records: [],
  });
}

function metadata(over: Record<string, string> = {}): Record<string, string> {
  return {
    purpose: LINKED_FORM_FEE_PURPOSE,
    linked_form_request_id: REQUEST_ID,
    payer_user_id: "22222222-2222-4222-8222-222222222222",
    manager_user_id: "11111111-1111-4111-8111-111111111111",
    property_id: "property-1",
    resident_email: "mom@example.com",
    fee_cents: "4500",
    ...over,
  };
}

function deliver(meta: Record<string, string>, over: Record<string, unknown> = {}, type = "checkout.session.completed") {
  state.event = {
    id: "evt_1",
    type,
    data: { object: { id: SESSION_ID, mode: "payment", payment_status: "paid", status: "complete", metadata: meta, ...over } },
  };
  return webhook(new Request("http://localhost/api/stripe/webhook", { method: "POST", body: "{}" }));
}

const requestRow = () => (state.db as LinkedFormFakeDb).tables.application_form_requests![0]!;
const chargeRows = () => (state.db as LinkedFormFakeDb).tables.portal_household_charge_records!;

beforeEach(() => {
  vi.stubEnv("STRIPE_WEBHOOK_SECRET", "whsec_test");
  Object.values(spies).forEach((spy) => spy.mockClear());
  state.db = seed();
});

describe("the Stripe webhook settles a paid linked-form fee", () => {
  it("marks the request paid by the payer even though nobody returned to the page", async () => {
    const res = await deliver(metadata());
    expect(res.status).toBe(200);
    expect(requestRow()).toMatchObject({
      fee_session_id: SESSION_ID,
      fee_paid_by_user_id: "22222222-2222-4222-8222-222222222222",
    });
    expect(requestRow().fee_paid_at).toBeTruthy();
    // It does not finish the form: only the paid person's own submit does that.
    expect(requestRow().status).toBe("shared");
  });

  it("books the money in the ledger and the platform hold, as other income and never as the applicant's own fee", async () => {
    await deliver(metadata());
    expect(chargeRows()).toHaveLength(1);
    expect(chargeRows()[0]).toMatchObject({ id: `hc_linked_form_fee_${SESSION_ID}`, kind: "other_cost", status: "paid" });
    expect(spies.syncLedgerPaymentEntry).toHaveBeenCalledTimes(1);
    const [, charge, , sessionId] = spies.syncLedgerPaymentEntry.mock.calls[0] as unknown as [unknown, Record<string, unknown>, string, string];
    expect(charge).toMatchObject({
      managerUserId: "11111111-1111-4111-8111-111111111111",
      residentUserId: "22222222-2222-4222-8222-222222222222",
      amountLabel: "$45.00",
      kind: "other_cost",
      applicationId: "PROPLANE-APP00001",
      propertyLabel: "12 Alder St",
    });
    expect(sessionId).toBe(SESSION_ID);
    expect(spies.creditHoldFromPaidSession).toHaveBeenCalledTimes(1);
  });

  it("is idempotent: a redelivery changes nothing and books no second payment date", async () => {
    await deliver(metadata());
    const firstPaidAt = requestRow().fee_paid_at;
    const firstBookedAt = (chargeRows()[0]!.row_data as { paidAt: string }).paidAt;
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect((await deliver(metadata())).status).toBe(200);
    expect(requestRow().fee_paid_at).toBe(firstPaidAt);
    expect(chargeRows()).toHaveLength(1);
    expect((chargeRows()[0]!.row_data as { paidAt: string }).paidAt).toBe(firstBookedAt);
  });

  it("is paid-sticky: a later session never re-attributes or unpays the request", async () => {
    await deliver(metadata());
    state.event = null;
    await deliver(metadata({ payer_user_id: "33333333-3333-4333-8333-333333333333" }), { id: "cs_test_linkedfee0002" });
    expect(requestRow()).toMatchObject({ fee_session_id: SESSION_ID, fee_paid_by_user_id: "22222222-2222-4222-8222-222222222222" });
    // The second payment was real money, so it is still booked on its own session.
    expect(chargeRows().map((row) => row.id).sort()).toEqual([`hc_linked_form_fee_${SESSION_ID}`, "hc_linked_form_fee_cs_test_linkedfee0002"]);
  });

  it("settles an ACH payment only once the bank debit has actually cleared", async () => {
    await deliver(metadata(), { payment_status: "unpaid" });
    expect(requestRow().fee_paid_at).toBeNull();
    expect(chargeRows()).toHaveLength(0);
    await deliver(metadata(), {}, "checkout.session.async_payment_succeeded");
    expect(requestRow().fee_paid_at).toBeTruthy();
    expect(chargeRows()).toHaveLength(1);
  });

  it("refuses a session whose metadata does not match the stored request", async () => {
    // Another manager claimed on the session.
    expect((await deliver(metadata({ manager_user_id: "99999999-9999-4999-8999-999999999999" }))).status).not.toBe(200);
    expect(requestRow().fee_paid_at).toBeNull();
    // A request id that does not exist.
    await deliver(metadata({ linked_form_request_id: "55555555-5555-4555-8555-555555555555" }));
    expect(requestRow().fee_paid_at).toBeNull();
    // A payment that does not cover the request's fee.
    await deliver(metadata({ fee_cents: "100" }));
    expect(requestRow().fee_paid_at).toBeNull();
    // No payer bound.
    await deliver(metadata({ payer_user_id: "" }));
    expect(requestRow().fee_paid_at).toBeNull();
    expect(chargeRows()).toHaveLength(0);
    expect(spies.syncLedgerPaymentEntry).not.toHaveBeenCalled();
  });

  it("records a payment against a fee that was never resolved, at the amount actually paid", async () => {
    state.db = seed({ fee_cents: null });
    await deliver(metadata());
    expect(requestRow()).toMatchObject({ fee_cents: 4500, fee_session_id: SESSION_ID });
  });
});
