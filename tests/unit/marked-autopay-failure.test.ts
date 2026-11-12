import { beforeEach, describe, expect, it, vi } from "vitest";

const recordAutopayDecline = vi.fn();
vi.mock("@/lib/resident-autopay.server", () => ({
  notifyAutopayDeclined: vi.fn(),
  recordAutopayDecline: (...a: unknown[]) => recordAutopayDecline(...a),
  runAttempt: (raw: unknown) => {
    const n = Number(raw);
    return Number.isFinite(n) && n >= 1 ? Math.round(n) : 1;
  },
}));

import { handleMarkedAutopayPaymentIntentFailed } from "@/lib/stripe-webhook-financials";

const RUN = { id: "run_1", charge_id: "hc_1", manager_id: "mgr_1", attempt: 1, stripe_payment_intent_id: null as string | null, status: "claimed" };

function fakeDb(run: typeof RUN | null) {
  return {
    from(table: string) {
      if (table === "resident_autopay_runs") {
        return { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: run, error: null }) }) }) };
      }
      return { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { row_data: { id: "hc_1" } }, error: null }) }) }) };
    },
  } as never;
}

function intent(overrides: Record<string, unknown> = {}) {
  return {
    id: "pi_1", currency: "usd", transfer_data: null, application_fee_amount: null,
    last_payment_error: { message: "Your card was declined." },
    metadata: {
      source_arbitration_v: "1", purpose: "household_charge", autopay_run_id: "run_1", autopay_attempt: "1",
      charge_id: "hc_1", manager_user_id: "mgr_1",
    },
    ...overrides,
  } as never;
}

const stripeWith = (status: string) =>
  ({ paymentIntents: { retrieve: async () => ({ id: "pi_1", status, last_payment_error: { message: "Insufficient funds." } }) } }) as never;

describe("a declined MARKED autopay PaymentIntent fails the run (it used to stay claimed forever)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    recordAutopayDecline.mockResolvedValue(true);
  });

  it("records the decline against the run with the live PaymentIntent's reason", async () => {
    await handleMarkedAutopayPaymentIntentFailed(fakeDb(RUN), stripeWith("requires_payment_method"), intent());
    expect(recordAutopayDecline).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      runId: "run_1", attempt: 1, paymentIntentId: "pi_1", chargeId: "hc_1", managerId: "mgr_1", reason: "Insufficient funds.",
    }));
  });

  it("accepts a run that already failed on this same PaymentIntent (the synchronous path got there first)", async () => {
    await handleMarkedAutopayPaymentIntentFailed(
      fakeDb({ ...RUN, status: "failed", stripe_payment_intent_id: "pi_1" }), stripeWith("requires_payment_method"), intent());
    expect(recordAutopayDecline).toHaveBeenCalledTimes(1); // idempotent inside recordAutopayDecline
  });

  it("records nothing when the live PaymentIntent is not failed (a stale event for an intent still in flight or paid)", async () => {
    for (const status of ["processing", "succeeded", "requires_action"]) {
      await handleMarkedAutopayPaymentIntentFailed(fakeDb(RUN), stripeWith(status), intent());
    }
    expect(recordAutopayDecline).not.toHaveBeenCalled();
  });

  it("ignores a redelivered failure for an earlier attempt", async () => {
    await handleMarkedAutopayPaymentIntentFailed(fakeDb({ ...RUN, attempt: 2 }), stripeWith("requires_payment_method"), intent());
    expect(recordAutopayDecline).not.toHaveBeenCalled();
  });

  it("fails the delivery (so it is retried and reviewed) when the intent does not match the run", async () => {
    await expect(handleMarkedAutopayPaymentIntentFailed(
      fakeDb({ ...RUN, stripe_payment_intent_id: "pi_other" }), stripeWith("requires_payment_method"), intent()),
    ).rejects.toThrow(/differs from its persisted run/);
    recordAutopayDecline.mockResolvedValue(false);
    await expect(handleMarkedAutopayPaymentIntentFailed(fakeDb(RUN), stripeWith("requires_payment_method"), intent()))
      .rejects.toThrow(/could not be recorded/);
  });

  it("refuses an intent with a Connect destination or application fee, as before", async () => {
    await expect(handleMarkedAutopayPaymentIntentFailed(fakeDb(RUN), stripeWith("requires_payment_method"),
      intent({ transfer_data: { destination: "acct_1" } }))).rejects.toThrow(/lacks frozen claim terms/);
  });
});
