/**
 * The durable coordinator every general charge refund goes through.
 *
 * The defect it exists for: a refund that comes back `pending` — normal for a bank-funded charge
 * on the destination and managed rails — was treated as a failure by all three initiators, while
 * only a synchronous `succeeded` wrote `refundedCents`. So a pending refund left the charge
 * reading un-refunded forever with its whole amount still offered as refundable, and the attempt
 * counter the Stripe idempotency key was built from lived in unlocked row JSON.
 *
 * What these assert: the reservation is acknowledged before the provider call, the provider key
 * is the reserved attempt's id, no money is written here, a replay never sends a second refund,
 * a lost answer is recorded as uncertain and never releases the budget, and a terminal rail
 * refusal — which happens before any provider call — does release it.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeDb, type Row } from "../helpers/fake-table-db";

const rail = vi.hoisted(() => ({
  refundPaidHouseholdCharge: vi.fn(),
  resolveHouseholdChargeRefundRail: vi.fn(),
  ReviewError: class HouseholdChargeRefundReviewError extends Error {
    readonly status = 409;
  },
}));

vi.mock("@/lib/household-charge-refund-rail.server", () => ({
  refundPaidHouseholdCharge: rail.refundPaidHouseholdCharge,
  resolveHouseholdChargeRefundRail: rail.resolveHouseholdChargeRefundRail,
  HouseholdChargeRefundReviewError: rail.ReviewError,
}));

const { runHouseholdChargeRefund, householdRefundAttemptIdFromPlatformKey, householdRefundPlatformAttemptKey } =
  await import("@/lib/household-charge-refund-coordinator.server");

const OWNER = "mgr-1";
const CHARGE = "chg-1";

function seeded(options: { refundedCents?: number; paidCents?: number } = {}) {
  return createFakeDb({
    portal_household_charge_records: [{
      id: CHARGE, manager_user_id: OWNER, status: "paid",
      row_data: { kind: "rent", residentEmail: "r@example.invalid",
        ...(options.refundedCents == null ? {} : { refundedCents: options.refundedCents }) },
    }],
    ledger_entries: [{
      source_charge_id: CHARGE, entry_type: "payment", stripe_charge_id: "ch_1",
      amount_cents: options.paidCents ?? 90_000,
    }],
  });
}

const run = (db: ReturnType<typeof seeded>, over: Partial<Parameters<typeof runHouseholdChargeRefund>[2]> = {}) =>
  runHouseholdChargeRefund({} as never, db as never, {
    ownerUserId: OWNER, chargeId: CHARGE, stripeChargeId: "ch_1", amountCents: 30_000,
    operationKey: "op-1", basis: { kind: "charge_refund" }, ...over,
  });

const attempts = (db: ReturnType<typeof seeded>): Row[] => db.tables.household_charge_refund_attempts ?? [];
const charge = (db: ReturnType<typeof seeded>) => db.tables.portal_household_charge_records![0]!.row_data as Row;

beforeEach(() => {
  vi.clearAllMocks();
  rail.resolveHouseholdChargeRefundRail.mockResolvedValue({ rail: "destination" });
  rail.refundPaidHouseholdCharge.mockResolvedValue({ refundId: "re_1", status: "pending", rail: "destination" });
});

describe("reserving before the provider", () => {
  it("reserves, sends on the attempt's own key, and reports pending", async () => {
    const db = seeded();
    const outcome = await run(db);

    expect(outcome).toMatchObject({ kind: "pending", refundId: "re_1" });
    const attempt = attempts(db)[0]!;
    expect(attempt).toMatchObject({
      operation_key: "op-1", source_charge_id: CHARGE, manager_user_id: OWNER,
      amount_cents: 30_000, baseline_refunded_cents: 0, paid_cents: 90_000,
      rail: "destination", status: "pending", provider_refund_id: "re_1", projected_at: null,
    });
    expect(rail.refundPaidHouseholdCharge).toHaveBeenCalledWith(expect.anything(), expect.anything(),
      expect.objectContaining({
        idempotencyKey: householdRefundPlatformAttemptKey(attempt.id as string),
        metadata: expect.objectContaining({ household_refund_attempt: attempt.id }),
      }));
  });

  it("writes no money onto the charge — only the webhook's binding may", async () => {
    const db = seeded();
    rail.refundPaidHouseholdCharge.mockResolvedValue({ refundId: "re_1", status: "succeeded", rail: "destination" });
    const outcome = await run(db);

    // Even a synchronous provider `succeeded` is reported as pending: terminal accounting needs
    // re-read evidence, which only `handleStripeRefund` has.
    expect(outcome.kind).toBe("pending");
    expect(charge(db)).not.toHaveProperty("refundedCents");
  });

  it("records the historical refunded figure as the baseline and bills only what remains", async () => {
    const db = seeded({ refundedCents: 60_000 });
    expect(await run(db, { amountCents: 30_000 })).toMatchObject({ kind: "pending" });
    expect(attempts(db)[0]).toMatchObject({ baseline_refunded_cents: 60_000, amount_cents: 30_000 });
    expect(charge(db).refundedCents).toBe(60_000);
  });

  it("refuses an amount beyond the payment's available balance, and sends nothing", async () => {
    const db = seeded({ refundedCents: 80_000 });
    expect(await run(db, { amountCents: 30_000 })).toMatchObject({ kind: "review" });
    expect(rail.refundPaidHouseholdCharge).not.toHaveBeenCalled();
    expect(attempts(db)).toHaveLength(0);
  });

  it("refuses a second unresolved reservation for the same source", async () => {
    const db = seeded();
    expect(await run(db, { operationKey: "op-1", amountCents: 30_000 })).toMatchObject({ kind: "pending" });
    rail.refundPaidHouseholdCharge.mockClear();
    // A different operation for the same charge while the first is still unresolved.
    expect(await run(db, { operationKey: "op-2", amountCents: 30_000 })).toMatchObject({ kind: "review" });
    expect(rail.refundPaidHouseholdCharge).not.toHaveBeenCalled();
    expect(attempts(db)).toHaveLength(1);
  });

  it("refuses an owner or a provider charge the payment evidence does not name", async () => {
    const db = seeded();
    expect(await run(db, { ownerUserId: "someone-else" })).toMatchObject({ kind: "review" });
    expect(await run(db, { stripeChargeId: "ch_other" })).toMatchObject({ kind: "review" });
    expect(await run(db, { chargeId: "chg-other" })).toMatchObject({ kind: "review" });
    expect(rail.refundPaidHouseholdCharge).not.toHaveBeenCalled();
  });
});

describe("replay and uncertainty", () => {
  it("reports uncertainty if the provider stamp is not acknowledged", async () => {
    const db = createFakeDb({
      portal_household_charge_records: [{ id: CHARGE, manager_user_id: OWNER, status: "paid", row_data: { kind: "rent" } }],
      ledger_entries: [{ source_charge_id: CHARGE, entry_type: "payment", stripe_charge_id: "ch_1", amount_cents: 90_000 }],
    }, { failWrite: (table, mode) => table === "household_charge_refund_attempts" && mode === "update" ? { message: "write failed" } : null });
    expect(await run(db)).toMatchObject({ kind: "unknown" });
    expect(rail.refundPaidHouseholdCharge).toHaveBeenCalledTimes(1);
  });

  it("does not overwrite a terminal webhook that wins the provider-stamp race", async () => {
    const db = seeded();
    rail.refundPaidHouseholdCharge.mockImplementationOnce(async () => {
      attempts(db)[0]!.status = "succeeded";
      attempts(db)[0]!.provider_refund_id = "re_1";
      return { refundId: "re_1", status: "succeeded", rail: "destination" };
    });
    expect(await run(db)).toMatchObject({ kind: "unknown" });
    expect(attempts(db)[0]).toMatchObject({ status: "succeeded", provider_refund_id: "re_1" });
  });
  it("only the freshly inserted reservation can call the provider concurrently", async () => {
    const db = seeded();
    let finish!: (result: { refundId: string; status: string; rail: string }) => void;
    rail.refundPaidHouseholdCharge.mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
    const first = run(db);
    await vi.waitFor(() => expect(rail.refundPaidHouseholdCharge).toHaveBeenCalledTimes(1));
    expect(await run(db)).toMatchObject({ kind: "unknown" });
    expect(rail.refundPaidHouseholdCharge).toHaveBeenCalledTimes(1);
    finish({ refundId: "re_1", status: "pending", rail: "destination" });
    expect(await first).toMatchObject({ kind: "pending" });
  });
  it("never sends on replay of a reserved operation whose provider outcome is unknown", async () => {
    const db = seeded();
    rail.refundPaidHouseholdCharge.mockRejectedValueOnce(new Error("lost response"));
    await expect(run(db)).rejects.toThrow();
    attempts(db)[0]!.status = "reserved";
    rail.refundPaidHouseholdCharge.mockClear();
    expect(await run(db)).toMatchObject({ kind: "unknown" });
    expect(rail.refundPaidHouseholdCharge).not.toHaveBeenCalled();
  });
  it("resumes the same operation instead of sending a second provider refund", async () => {
    const db = seeded();
    await run(db);
    rail.refundPaidHouseholdCharge.mockClear();

    const replay = await run(db);
    expect(replay).toMatchObject({ kind: "pending", refundId: "re_1" });
    expect(rail.refundPaidHouseholdCharge).not.toHaveBeenCalled();
    expect(attempts(db)).toHaveLength(1);
  });

  it("refuses the same operation key used for a different basis", async () => {
    const db = seeded();
    await run(db);
    rail.refundPaidHouseholdCharge.mockClear();

    expect(await run(db, { amountCents: 10_000 })).toMatchObject({ kind: "review" });
    expect(await run(db, { basis: { kind: "charge_refund", note: "changed" } })).toMatchObject({ kind: "review" });
    expect(rail.refundPaidHouseholdCharge).not.toHaveBeenCalled();
  });

  it("allows an independent later operation for the same amount once the first is terminal", async () => {
    const db = seeded();
    await run(db, { operationKey: "op-1", amountCents: 30_000 });
    // The webhook settled the first attempt and projected its money.
    attempts(db)[0]!.status = "succeeded";
    attempts(db)[0]!.projected_at = "2026-11-09T00:00:00.000Z";
    (charge(db) as Row).refundedCents = 30_000;

    expect(await run(db, { operationKey: "op-2", amountCents: 30_000 })).toMatchObject({ kind: "pending" });
    expect(attempts(db)).toHaveLength(2);
    expect(attempts(db)[1]).toMatchObject({ baseline_refunded_cents: 30_000, amount_cents: 30_000 });
  });

  it("records a lost provider answer as uncertain and never releases the budget", async () => {
    const db = seeded();
    rail.refundPaidHouseholdCharge.mockRejectedValue(new Error("socket hang up"));

    await expect(run(db)).rejects.toThrow("socket hang up");
    expect(attempts(db)[0]).toMatchObject({ status: "unknown", provider_refund_id: null });
    expect(charge(db)).not.toHaveProperty("refundedCents");
  });

  it("records a provider-reported failure as uncertain, leaving the release to verified evidence", async () => {
    const db = seeded();
    rail.refundPaidHouseholdCharge.mockResolvedValue({ refundId: "re_bad", status: "failed", rail: "destination" });

    expect(await run(db)).toMatchObject({ kind: "unknown", refundId: "re_bad" });
    expect(attempts(db)[0]).toMatchObject({ status: "unknown", provider_refund_id: "re_bad" });
  });

  it("releases the reservation when the rail refuses before any provider call", async () => {
    const db = seeded();
    rail.refundPaidHouseholdCharge.mockRejectedValue(
      new rail.ReviewError("This payment was taken before the new payment system; its refund needs review."));

    expect(await run(db)).toMatchObject({ kind: "review", message: expect.stringContaining("needs review") });
    // Terminal, and the budget is free again — otherwise no later refund of this charge is possible.
    expect(attempts(db)[0]).toMatchObject({ status: "failed", provider_refund_id: null });
    rail.refundPaidHouseholdCharge.mockResolvedValue({ refundId: "re_2", status: "pending", rail: "destination" });
    expect(await run(db, { operationKey: "op-later" })).toMatchObject({ kind: "pending" });
  });

  it("reports the rail's own terminal refusal without reserving anything", async () => {
    const db = seeded();
    rail.resolveHouseholdChargeRefundRail.mockRejectedValue(new rail.ReviewError("ambiguous recipient allocations"));

    expect(await run(db)).toMatchObject({ kind: "review", message: "ambiguous recipient allocations" });
    expect(attempts(db)).toHaveLength(0);
    expect(rail.refundPaidHouseholdCharge).not.toHaveBeenCalled();
  });
});

describe("the central rail's way back to the household attempt", () => {
  it("stamps the platform key before the provider call, because the rail drops caller metadata", async () => {
    const db = seeded();
    rail.resolveHouseholdChargeRefundRail.mockResolvedValue({ rail: "central", holdId: "hold-1", ownerUserId: OWNER });
    rail.refundPaidHouseholdCharge.mockImplementation(async () => {
      // By the time the provider is asked, the binding is already durable.
      expect(attempts(db)[0]!.platform_attempt_key).toBe(householdRefundPlatformAttemptKey(attempts(db)[0]!.id as string));
      return { refundId: "re_central", status: "pending", rail: "central" };
    });

    expect(await run(db)).toMatchObject({ kind: "pending", refundId: "re_central" });
    expect(attempts(db)[0]).toMatchObject({ rail: "central" });
  });

  it("resolves a platform attempt key back to its household attempt, and nothing else", () => {
    expect(householdRefundAttemptIdFromPlatformKey("household-refund:abc")).toBe("abc");
    expect(householdRefundAttemptIdFromPlatformKey("household-refund:")).toBeNull();
    expect(householdRefundAttemptIdFromPlatformKey("deposit-return:abc")).toBeNull();
    expect(householdRefundAttemptIdFromPlatformKey(null)).toBeNull();
    expect(householdRefundAttemptIdFromPlatformKey(undefined)).toBeNull();
  });

  it("reports uncertainty if the platform binding cannot be stamped, and sends nothing", async () => {
    const db = createFakeDb({
      portal_household_charge_records: [{ id: CHARGE, manager_user_id: OWNER, status: "paid", row_data: { kind: "rent" } }],
      ledger_entries: [{ source_charge_id: CHARGE, entry_type: "payment", stripe_charge_id: "ch_1", amount_cents: 90_000 }],
    }, {
      rpc: (name) => name === "stamp_household_charge_refund_platform_key"
        ? { data: null, error: { message: "lost" } } : undefined,
    });
    rail.resolveHouseholdChargeRefundRail.mockResolvedValue({ rail: "central", holdId: "hold-1", ownerUserId: OWNER });

    expect(await run(db)).toMatchObject({ kind: "unknown" });
    expect(rail.refundPaidHouseholdCharge).not.toHaveBeenCalled();
  });
});
