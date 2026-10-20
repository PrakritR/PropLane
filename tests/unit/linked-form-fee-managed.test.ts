/** A linked-form fee on a PropLane-managed workspace is allocated in the party ledger, never credited to a manager hold. */
import { beforeEach, describe, expect, it, vi } from "vitest";

const managed = vi.hoisted(() => ({ value: null as unknown, throws: false }));
const capture = vi.hoisted(() => vi.fn());
const holdByPi = vi.hoisted(() => vi.fn());
vi.mock("server-only", () => ({}));
vi.mock("@/lib/managed-finance/resolve.server", () => ({
  resolveManagedForProperties: async () => { if (managed.throws) throw new Error("read failed"); return managed.value; },
}));
vi.mock("@/lib/managed-finance/capture.server", () => ({ creditManagedCapture: capture }));
vi.mock("@/lib/stripe-platform-hold.server", () => ({ findPlatformHoldByPaymentIntent: holdByPi }));

import { creditManagedLinkedFormFee, LINKED_FORM_FEE_PURPOSE } from "@/lib/linked-form-fee.server";

const policy = { id: "pol-1", status: "active", signedAt: "2026-01-01T00:00:00Z" };
const session = (over: Record<string, unknown> = {}, meta: Record<string, string> = {}) => ({
  id: "cs_form_1", status: "complete", payment_status: "paid", payment_intent: "pi_form_1", amount_total: 4_644,
  metadata: {
    purpose: LINKED_FORM_FEE_PURPOSE, property_id: "p-1", resident_email: "Mom@Example.com", fee_cents: "4500",
    manager_payout_cents: "4500", hold_amount_cents: "4500", ...meta,
  },
  ...over,
}) as never;
const stripe = () => ({ paymentIntents: { retrieve: vi.fn(async () => ({ id: "pi_form_1", status: "succeeded", latest_charge: "ch_form_1" })) } }) as never;

beforeEach(() => {
  managed.value = { workspaceId: "ws-1", policy }; managed.throws = false;
  capture.mockReset().mockResolvedValue({ status: "created", journalId: "j-1" });
  holdByPi.mockReset().mockResolvedValue(null);
});

describe("creditManagedLinkedFormFee", () => {
  it("allocates the paid fee in the ledger as other income and tells the webhook not to credit a hold", async () => {
    expect(await creditManagedLinkedFormFee({} as never, stripe(), session())).toBe(true);
    expect(capture).toHaveBeenCalledTimes(1);
    expect(capture.mock.calls[0]![2]).toMatchObject({
      policy, paymentIntentId: "pi_form_1", stripeChargeId: "ch_form_1", grossCents: 4_644,
      components: [{
        id: "hc_linked_form_fee_cs_form_1", kind: "other_cost", liabilityClass: "income", principalCents: 4_500, recipientNetCents: 4_500,
        propertyId: "p-1", residentEmail: "mom@example.com",
      }],
    });
  });

  it("a self-serve workspace is left to the hold path", async () => {
    managed.value = null;
    expect(await creditManagedLinkedFormFee({} as never, stripe(), session())).toBe(false);
    expect(capture).not.toHaveBeenCalled();
  });

  it("a fee the session DESTINATION-charged to the manager is never allocated on the platform ledger", async () => {
    // The managed policy became effective between checkout and settlement (days, for a bank payment). The money
    // went straight to the manager's Connect account, so crediting owner_payable here would owe the owner money
    // PropLane never held.
    expect(await creditManagedLinkedFormFee({} as never, stripe(), session({}, { platform_capture: "0" }))).toBe(false);
    expect(capture).not.toHaveBeenCalled();
    // Belt and braces for a session created before the metadata existed: the PaymentIntent itself says so.
    const transferred = { paymentIntents: { retrieve: vi.fn(async () => ({ id: "pi_form_1", status: "succeeded", latest_charge: "ch_form_1", transfer_data: { destination: "acct_1" } })) } } as never;
    expect(await creditManagedLinkedFormFee({} as never, transferred, session())).toBe(false);
    expect(capture).not.toHaveBeenCalled();
    // A fee the session captured on the platform balance still allocates.
    expect(await creditManagedLinkedFormFee({} as never, stripe(), session({}, { platform_capture: "1" }))).toBe(true);
  });

  it("a fee already credited as a hold stays a hold", async () => {
    holdByPi.mockResolvedValue({ id: "hold-1" });
    expect(await creditManagedLinkedFormFee({} as never, stripe(), session())).toBe(false);
    expect(capture).not.toHaveBeenCalled();
  });

  it("is a no-op for another purpose, an unpaid session, or a form with no house", async () => {
    expect(await creditManagedLinkedFormFee({} as never, stripe(), session({}, { purpose: "household_charge" }))).toBe(false);
    expect(await creditManagedLinkedFormFee({} as never, stripe(), session({ payment_status: "unpaid" }))).toBe(false);
    expect(await creditManagedLinkedFormFee({} as never, stripe(), session({}, { property_id: "" }))).toBe(false);
    expect(capture).not.toHaveBeenCalled();
  });

  it("fails closed: an unreadable workspace, a missing charge or inconsistent amounts throw so Stripe redelivers", async () => {
    managed.throws = true;
    await expect(creditManagedLinkedFormFee({} as never, stripe(), session())).rejects.toThrow();
    managed.throws = false;
    const noCharge = { paymentIntents: { retrieve: vi.fn(async () => ({ id: "pi_form_1", status: "succeeded", latest_charge: null })) } } as never;
    await expect(creditManagedLinkedFormFee({} as never, noCharge, session())).rejects.toThrow(/Charge/);
    await expect(creditManagedLinkedFormFee({} as never, stripe(), session({}, { hold_amount_cents: "9999" }))).rejects.toThrow(/reconcile/);
    expect(capture).not.toHaveBeenCalled();
  });

  it("a ledger refusal fails the delivery and never falls back to a hold", async () => {
    capture.mockRejectedValue(new Error("busy"));
    await expect(creditManagedLinkedFormFee({} as never, stripe(), session())).rejects.toThrow("busy");
  });
});
