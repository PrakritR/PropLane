import { describe, expect, it, vi } from "vitest";
import type Stripe from "stripe";
import { createLinkedFormFakeDb } from "../helpers/linked-form-fake-db";
import type { LinkedFormRequestRow } from "@/lib/application-linked-form-requests.server";

vi.mock("@/lib/application-fee-checkout.server", () => ({
  resolveApplicationFeeProperty: vi.fn(),
  resolveApplicationFeeItemization: vi.fn(),
}));

vi.mock("@/lib/reports/ledger-sync", () => ({ syncLedgerPaymentEntry: vi.fn(async () => undefined) }));

import {
  LINKED_FORM_FEE_PURPOSE,
  linkedFormFeeOwed,
  linkedFormFeeUnresolved,
  verifyLinkedFormFeePayment,
} from "@/lib/linked-form-fee.server";

const REQUEST_ID = "44444444-4444-4444-8444-444444444444";

function request(overrides: Partial<LinkedFormRequestRow> = {}): LinkedFormRequestRow {
  return {
    id: REQUEST_ID,
    manager_user_id: "manager-1",
    application_id: "PROPLANE-APP00001",
    applicant_user_id: "applicant-1",
    helper_user_id: "helper-1",
    rule_id: "r",
    form_kind: "application",
    form_id: "cosigner-form",
    source_question_label: "",
    source_answer_label: "",
    needed_before_review: true,
    status: "shared",
    filled_by_user_id: null,
    completed_submission_ref: null,
    completed_at: null,
    fee_cents: 4500,
    fee_session_id: null,
    fee_paid_at: null,
    fee_paid_by_user_id: null,
    expires_at: new Date(Date.now() + 86_400_000).toISOString(),
    ...overrides,
  };
}

function stripeWith(session: Partial<Stripe.Checkout.Session>): Stripe {
  return { checkout: { sessions: { retrieve: async () => session } } } as unknown as Stripe;
}

const paidSession = (metadata: Record<string, string>): Partial<Stripe.Checkout.Session> => ({
  id: "cs_test_abcdefghij",
  payment_status: "paid",
  status: "complete",
  metadata,
});

describe("a linked form's fee is the submitter's", () => {
  it("is owed only while the form has a fee and it is unpaid", () => {
    expect(linkedFormFeeOwed(request())).toBe(true);
    expect(linkedFormFeeOwed(request({ fee_cents: 0 }))).toBe(false);
    expect(linkedFormFeeOwed(request({ fee_cents: null }))).toBe(false);
    // ...but an application form with no stored fee is UNRESOLVED, never "free": the submit gate re-resolves it.
    expect(linkedFormFeeUnresolved(request({ fee_cents: null }))).toBe(true);
    expect(linkedFormFeeUnresolved(request({ fee_cents: 0 }))).toBe(false);
    expect(linkedFormFeeUnresolved(request({ form_kind: "move_in", fee_cents: null }))).toBe(false);
    expect(linkedFormFeeOwed(request({ fee_paid_at: new Date().toISOString() }))).toBe(false);
  });

  it("records a payment only for this request, by the person who paid", async () => {
    const db = createLinkedFormFakeDb({ application_form_requests: [{ ...request() }] });
    const meta = { purpose: LINKED_FORM_FEE_PURPOSE, linked_form_request_id: REQUEST_ID, payer_user_id: "helper-1", fee_cents: "4500" };
    const result = await verifyLinkedFormFeePayment(db, stripeWith(paidSession(meta)), { request: request(), payerUserId: "helper-1", sessionId: "cs_test_abcdefghij" });
    expect(result).toEqual({ ok: true, paid: true });
    expect(db.tables.application_form_requests![0]).toMatchObject({ fee_paid_by_user_id: "helper-1", fee_session_id: "cs_test_abcdefghij" });
    expect(db.tables.application_form_requests![0]!.fee_paid_at).toBeTruthy();
    // The payer's own return books the same ledger charge the webhook would, once, keyed on the session.
    expect(db.tables.portal_household_charge_records).toHaveLength(1);
    expect(db.tables.portal_household_charge_records![0]).toMatchObject({ id: "hc_linked_form_fee_cs_test_abcdefghij", kind: "other_cost", status: "paid" });
  });

  it("refuses a session that belongs to another request, another payer, or another purpose", async () => {
    const base = { purpose: LINKED_FORM_FEE_PURPOSE, linked_form_request_id: REQUEST_ID, payer_user_id: "helper-1", fee_cents: "4500" };
    const cases: Array<Record<string, string>> = [
      { ...base, linked_form_request_id: "55555555-5555-4555-8555-555555555555" },
      { ...base, payer_user_id: "someone-else" },
      { ...base, purpose: "rental_application_fee" },
    ];
    for (const metadata of cases) {
      const db = createLinkedFormFakeDb({ application_form_requests: [{ ...request() }] });
      const result = await verifyLinkedFormFeePayment(db, stripeWith(paidSession(metadata)), { request: request(), payerUserId: "helper-1", sessionId: "cs_test_abcdefghij" });
      expect(result).toMatchObject({ ok: false, status: 400 });
      expect(db.tables.application_form_requests![0]!.fee_paid_at).toBeNull();
    }
  });

  it("does not record an unpaid session, and refuses one that paid less than the fee", async () => {
    const meta = { purpose: LINKED_FORM_FEE_PURPOSE, linked_form_request_id: REQUEST_ID, payer_user_id: "helper-1", fee_cents: "4500" };
    const db = createLinkedFormFakeDb({ application_form_requests: [{ ...request() }] });
    const unpaid = await verifyLinkedFormFeePayment(db, stripeWith({ ...paidSession(meta), payment_status: "unpaid", status: "open" }), { request: request(), payerUserId: "helper-1", sessionId: "cs_test_abcdefghij" });
    expect(unpaid).toEqual({ ok: true, paid: false });
    expect(db.tables.application_form_requests![0]!.fee_paid_at).toBeNull();

    const short = await verifyLinkedFormFeePayment(db, stripeWith(paidSession({ ...meta, fee_cents: "100" })), { request: request(), payerUserId: "helper-1", sessionId: "cs_test_abcdefghij" });
    expect(short).toMatchObject({ ok: false, status: 409 });
    expect(db.tables.application_form_requests![0]!.fee_paid_at).toBeNull();
  });

  it("rejects a malformed session id before calling Stripe", async () => {
    const retrieve = vi.fn();
    const stripe = { checkout: { sessions: { retrieve } } } as unknown as Stripe;
    const db = createLinkedFormFakeDb({});
    expect(await verifyLinkedFormFeePayment(db, stripe, { request: request(), payerUserId: "helper-1", sessionId: "../etc" })).toMatchObject({ ok: false, status: 400 });
    expect(retrieve).not.toHaveBeenCalled();
  });
});
