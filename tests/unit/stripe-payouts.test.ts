import { describe, expect, it } from "vitest";
import {
  computeInstantPayoutFeeCents,
  computeNextPayoutDate,
  estimateArrivalDate,
  feeCentsForMethod,
  fromStripePayoutSchedule,
  instantAllowed,
  matchServiceLabelForPayout,
  netCentsForPayout,
  normalizePayoutHistoryRow,
  normalizePayoutStatus,
  resolveSetupState,
  standardPayoutArrivalDate,
  toStripePayoutSchedule,
  validateCreatePayoutRequestBody,
  validatePayoutAgainstBalance,
  validateScheduleRequestBody,
} from "@/lib/stripe-payouts";

describe("computeInstantPayoutFeeCents / feeCentsForMethod", () => {
  it("charges a flat 1% with no minimum floor (Stripe Connect Instant Payouts has none)", () => {
    expect(computeInstantPayoutFeeCents(428_000)).toBe(4280); // $4,280.00 -> $42.80
    expect(computeInstantPayoutFeeCents(100)).toBe(1); // $1.00 -> 1 cent
    expect(computeInstantPayoutFeeCents(0)).toBe(0);
    expect(computeInstantPayoutFeeCents(-500)).toBe(0);
  });

  it("standard is always free; instant uses the 1% fee", () => {
    expect(feeCentsForMethod("standard", 428_000)).toBe(0);
    expect(feeCentsForMethod("instant", 428_000)).toBe(4280);
  });
});

describe("netCentsForPayout", () => {
  it("subtracts the fee and never goes negative", () => {
    expect(netCentsForPayout(428_000, 4280)).toBe(423_720);
    expect(netCentsForPayout(10, 50)).toBe(0);
  });
});

describe("instantAllowed", () => {
  it("blocks a bank that isn't Instant-eligible regardless of amount", () => {
    const result = instantAllowed({ amountCents: 100, instantAvailableCents: 100_000, bankInstantEligible: false });
    expect(result).toEqual({ allowed: false, reason: expect.stringMatching(/isn't eligible/i) });
  });

  it("blocks an amount above instant_available — ACH rent still clearing is never instant", () => {
    const result = instantAllowed({ amountCents: 150_000, instantAvailableCents: 115_000, bankInstantEligible: true });
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/\$1,150\.00 now/);
  });

  it("allows an amount at or under instant_available on an eligible bank", () => {
    expect(instantAllowed({ amountCents: 115_000, instantAvailableCents: 115_000, bankInstantEligible: true })).toEqual({
      allowed: true,
      reason: null,
    });
  });

  it("rejects a zero or negative amount", () => {
    expect(instantAllowed({ amountCents: 0, instantAvailableCents: 100, bankInstantEligible: true }).allowed).toBe(
      false,
    );
  });
});

describe("arrival estimate", () => {
  it("instant has no calendar date", () => {
    expect(estimateArrivalDate("instant")).toBeNull();
  });

  it("standard lands 3 business days out, skipping weekends", () => {
    // Wednesday 2026-09-23 UTC -> +3 business days = Monday 2026-09-28
    const wed = new Date("2026-09-23T12:00:00.000Z");
    expect(standardPayoutArrivalDate(wed)).toBe("2026-09-28");
    expect(estimateArrivalDate("standard", wed)).toBe("2026-09-28");
  });

  it("crossing a weekend still lands on a business day", () => {
    // Thursday -> +3 business days = Tuesday (Fri, Mon, Tue)
    const thu = new Date("2026-09-24T00:00:00.000Z");
    expect(standardPayoutArrivalDate(thu)).toBe("2026-09-29");
  });
});

describe("schedule mapping", () => {
  it("round-trips weekly with an anchor", () => {
    const stripeShape = toStripePayoutSchedule({ interval: "weekly", weeklyAnchor: "friday" });
    expect(stripeShape).toEqual({ interval: "weekly", weekly_anchor: "friday" });
    expect(fromStripePayoutSchedule(stripeShape)).toEqual({ interval: "weekly", weeklyAnchor: "friday" });
  });

  it("round-trips monthly with an anchor day", () => {
    const stripeShape = toStripePayoutSchedule({ interval: "monthly", monthlyAnchor: 15 });
    expect(stripeShape).toEqual({ interval: "monthly", monthly_anchor: 15 });
    expect(fromStripePayoutSchedule(stripeShape)).toEqual({ interval: "monthly", monthlyAnchor: 15 });
  });

  it("round-trips manual and daily", () => {
    expect(fromStripePayoutSchedule(toStripePayoutSchedule({ interval: "manual" }))).toEqual({ interval: "manual" });
    expect(fromStripePayoutSchedule(toStripePayoutSchedule({ interval: "daily" }))).toEqual({ interval: "daily" });
  });

  it("defaults an unrecognized/missing Stripe schedule to daily", () => {
    expect(fromStripePayoutSchedule(null)).toEqual({ interval: "daily" });
    expect(fromStripePayoutSchedule({ interval: "weird" })).toEqual({ interval: "daily" });
  });

  it("falls back to friday for a weekly schedule with a bad anchor", () => {
    expect(fromStripePayoutSchedule({ interval: "weekly", weekly_anchor: "nope" })).toEqual({
      interval: "weekly",
      weeklyAnchor: "friday",
    });
  });
});

describe("computeNextPayoutDate", () => {
  it("is null for manual", () => {
    expect(computeNextPayoutDate({ interval: "manual" })).toBeNull();
  });

  it("daily is tomorrow", () => {
    const now = new Date("2026-09-20T10:00:00.000Z");
    expect(computeNextPayoutDate({ interval: "daily" }, now)).toBe("2026-09-21");
  });

  it("weekly lands on the next occurrence of the anchor day, not today even if today matches", () => {
    // 2026-09-25 is a Friday.
    const friday = new Date("2026-09-25T10:00:00.000Z");
    expect(computeNextPayoutDate({ interval: "weekly", weeklyAnchor: "friday" }, friday)).toBe("2026-10-02");
  });

  it("weekly from a Wednesday lands on the coming Friday", () => {
    const wed = new Date("2026-09-23T10:00:00.000Z");
    expect(computeNextPayoutDate({ interval: "weekly", weeklyAnchor: "friday" }, wed)).toBe("2026-09-25");
  });

  it("monthly rolls to next month once the anchor day has passed", () => {
    const now = new Date("2026-09-20T10:00:00.000Z");
    expect(computeNextPayoutDate({ interval: "monthly", monthlyAnchor: 1 }, now)).toBe("2026-10-01");
    expect(computeNextPayoutDate({ interval: "monthly", monthlyAnchor: 25 }, now)).toBe("2026-09-25");
  });
});

describe("resolveSetupState", () => {
  it("needs identity before details are submitted", () => {
    expect(
      resolveSetupState({
        detailsSubmitted: false,
        currentlyDue: [],
        pendingVerification: [],
        hasExternalAccount: false,
      }),
    ).toEqual({ identity: "needed", bank: "needed", ready: false });
  });

  it("needs bank when there is no external account, independent of identity", () => {
    const state = resolveSetupState({
      detailsSubmitted: true,
      currentlyDue: [],
      pendingVerification: [],
      hasExternalAccount: false,
    });
    expect(state).toEqual({ identity: "done", bank: "needed", ready: false });
  });

  it("is pending when identity is submitted but Stripe is still verifying", () => {
    const state = resolveSetupState({
      detailsSubmitted: true,
      currentlyDue: [],
      pendingVerification: ["individual.verification.document"],
      hasExternalAccount: true,
    });
    expect(state).toEqual({ identity: "pending", bank: "done", ready: false });
  });

  it("is ready only when both identity and bank are done", () => {
    const state = resolveSetupState({
      detailsSubmitted: true,
      currentlyDue: [],
      pendingVerification: [],
      hasExternalAccount: true,
    });
    expect(state).toEqual({ identity: "done", bank: "done", ready: true });
  });

  it("a currently-due external_account requirement means bank is needed even with an account on file", () => {
    const state = resolveSetupState({
      detailsSubmitted: true,
      currentlyDue: ["external_account"],
      pendingVerification: [],
      hasExternalAccount: true,
    });
    expect(state.bank).toBe("needed");
    expect(state.identity).toBe("done");
  });
});

describe("normalizePayoutStatus", () => {
  it("passes through ordinary statuses", () => {
    expect(normalizePayoutStatus("paid")).toBe("paid");
    expect(normalizePayoutStatus("in_transit")).toBe("in_transit");
    expect(normalizePayoutStatus("canceled")).toBe("canceled");
  });

  it("relabels a bank-return failure code as returned", () => {
    expect(normalizePayoutStatus("failed", "account_closed")).toBe("returned");
    expect(normalizePayoutStatus("failed", "debit_not_authorized")).toBe("returned");
  });

  it("keeps an ordinary failure as failed", () => {
    expect(normalizePayoutStatus("failed", "insufficient_funds")).toBe("failed");
    expect(normalizePayoutStatus("failed", null)).toBe("failed");
  });

  it("falls back to pending for an unrecognized status", () => {
    expect(normalizePayoutStatus("something_new")).toBe("pending");
  });
});

describe("normalizePayoutHistoryRow", () => {
  it("normalizes a DB row into the contract shape, computing netCents", () => {
    const item = normalizePayoutHistoryRow({
      id: "row-1",
      amount_cents: "428000",
      fee_cents: 4280,
      method: "instant",
      status: "paid",
      destination_last4: "4421",
      created_at: "2026-09-12T16:12:00.000Z",
      arrival_date: null,
      initiated_in_app: true,
      failure_message: null,
    });
    expect(item).toEqual({
      id: "row-1",
      amountCents: 428_000,
      feeCents: 4280,
      netCents: 423_720,
      method: "instant",
      status: "paid",
      destinationLast4: "4421",
      createdAt: "2026-09-12T16:12:00.000Z",
      arrivalDate: null,
      initiatedInApp: true,
      failureMessage: null,
      serviceLabel: null,
    });
  });

  it("attaches a resolved service label when given one", () => {
    const item = normalizePayoutHistoryRow(
      {
        id: "row-2",
        amount_cents: 64_000,
        status: "paid",
        created_at: "2026-09-16T00:00:00.000Z",
      },
      { serviceLabel: "5257 Brooklyn Ave · Kitchen leak" },
    );
    expect(item.serviceLabel).toBe("5257 Brooklyn Ave · Kitchen leak");
  });

  it("falls back to pending for a status the contract does not recognize", () => {
    const item = normalizePayoutHistoryRow({
      id: "row-3",
      amount_cents: 100,
      status: "weird",
      created_at: "2026-09-16T00:00:00.000Z",
    });
    expect(item.status).toBe("pending");
  });
});

describe("matchServiceLabelForPayout", () => {
  const payout = { amountCents: 115_000, createdAt: "2026-09-05T14:00:00.000Z" };

  it("matches a single unambiguous candidate by amount within the settlement window", () => {
    const label = matchServiceLabelForPayout(payout, [
      { workOrderId: "WO-1", amountCents: 115_000, updatedAt: "2026-09-05T13:00:00.000Z", label: "4709a 8th Ave · Water heater" },
    ]);
    expect(label).toBe("4709a 8th Ave · Water heater");
  });

  it("refuses to guess when more than one candidate matches", () => {
    const label = matchServiceLabelForPayout(payout, [
      { workOrderId: "WO-1", amountCents: 115_000, updatedAt: "2026-09-05T13:00:00.000Z", label: "A" },
      { workOrderId: "WO-2", amountCents: 115_000, updatedAt: "2026-09-04T13:00:00.000Z", label: "B" },
    ]);
    expect(label).toBeNull();
  });

  it("ignores a candidate that settled after the payout", () => {
    const label = matchServiceLabelForPayout(payout, [
      { workOrderId: "WO-1", amountCents: 115_000, updatedAt: "2026-09-06T13:00:00.000Z", label: "A" },
    ]);
    expect(label).toBeNull();
  });

  it("ignores a candidate outside the 14-day settlement window", () => {
    const label = matchServiceLabelForPayout(payout, [
      { workOrderId: "WO-1", amountCents: 115_000, updatedAt: "2026-08-01T13:00:00.000Z", label: "A" },
    ]);
    expect(label).toBeNull();
  });

  it("returns null when no candidate matches the amount", () => {
    const label = matchServiceLabelForPayout(payout, [
      { workOrderId: "WO-1", amountCents: 999, updatedAt: "2026-09-05T13:00:00.000Z", label: "A" },
    ]);
    expect(label).toBeNull();
  });
});

describe("validateCreatePayoutRequestBody", () => {
  it("accepts a valid standard request", () => {
    expect(validateCreatePayoutRequestBody({ amountCents: 5000, method: "standard" })).toEqual({
      ok: true,
      input: { amountCents: 5000, method: "standard" },
    });
  });

  it("rejects a zero or negative amount", () => {
    expect(validateCreatePayoutRequestBody({ amountCents: 0, method: "standard" }).ok).toBe(false);
    expect(validateCreatePayoutRequestBody({ amountCents: -5, method: "standard" }).ok).toBe(false);
  });

  it("rejects a missing/invalid method", () => {
    expect(validateCreatePayoutRequestBody({ amountCents: 5000, method: "fast" }).ok).toBe(false);
    expect(validateCreatePayoutRequestBody({ amountCents: 5000 }).ok).toBe(false);
  });

  it("rejects a non-object body", () => {
    expect(validateCreatePayoutRequestBody(null).ok).toBe(false);
    expect(validateCreatePayoutRequestBody("nope").ok).toBe(false);
  });
});

describe("validatePayoutAgainstBalance", () => {
  const setup = { ready: true };
  const balance = { availableCents: 100_000, instantAvailableCents: 40_000, bankInstantEligible: true };

  it("refuses when setup isn't ready, before checking amounts", () => {
    const result = validatePayoutAgainstBalance(
      { amountCents: 100, method: "standard" },
      balance,
      { ready: false },
    );
    expect(result).toEqual({ ok: false, error: expect.stringMatching(/setting up payouts/i) });
  });

  it("422s a standard amount over the available balance", () => {
    const result = validatePayoutAgainstBalance({ amountCents: 150_000, method: "standard" }, balance, setup);
    expect(result.ok).toBe(false);
  });

  it("allows a standard amount at the available balance", () => {
    expect(validatePayoutAgainstBalance({ amountCents: 100_000, method: "standard" }, balance, setup)).toEqual({
      ok: true,
    });
  });

  it("422s an instant amount over instant_available even though it's under available", () => {
    const result = validatePayoutAgainstBalance({ amountCents: 60_000, method: "instant" }, balance, setup);
    expect(result.ok).toBe(false);
  });

  it("422s instant on an ineligible bank regardless of amount", () => {
    const result = validatePayoutAgainstBalance(
      { amountCents: 100, method: "instant" },
      { ...balance, bankInstantEligible: false },
      setup,
    );
    expect(result.ok).toBe(false);
  });
});

describe("validateScheduleRequestBody", () => {
  it("accepts weekly with a valid anchor", () => {
    expect(validateScheduleRequestBody({ interval: "weekly", weeklyAnchor: "monday" })).toEqual({
      ok: true,
      schedule: { interval: "weekly", weeklyAnchor: "monday" },
    });
  });

  it("rejects weekly without a valid anchor", () => {
    expect(validateScheduleRequestBody({ interval: "weekly" }).ok).toBe(false);
    expect(validateScheduleRequestBody({ interval: "weekly", weeklyAnchor: "someday" }).ok).toBe(false);
  });

  it("accepts monthly with a day 1-31", () => {
    expect(validateScheduleRequestBody({ interval: "monthly", monthlyAnchor: 31 })).toEqual({
      ok: true,
      schedule: { interval: "monthly", monthlyAnchor: 31 },
    });
  });

  it("rejects monthly with an out-of-range day", () => {
    expect(validateScheduleRequestBody({ interval: "monthly", monthlyAnchor: 32 }).ok).toBe(false);
    expect(validateScheduleRequestBody({ interval: "monthly", monthlyAnchor: 0 }).ok).toBe(false);
  });

  it("accepts manual and daily with no extra fields", () => {
    expect(validateScheduleRequestBody({ interval: "manual" })).toEqual({ ok: true, schedule: { interval: "manual" } });
    expect(validateScheduleRequestBody({ interval: "daily" })).toEqual({ ok: true, schedule: { interval: "daily" } });
  });

  it("rejects an invalid interval", () => {
    expect(validateScheduleRequestBody({ interval: "yearly" }).ok).toBe(false);
  });
});
