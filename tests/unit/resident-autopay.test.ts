/**
 * Resident autopay (PLAN-0920-1051 Wave 1) — the money-critical unit surface:
 * due-charge selection (including the days-before-due math and the
 * recurring-only filter), the claim insert's double-charge guard, and that
 * `chargeAutopay` computes the SAME fee breakdown a manual checkout would for
 * an identical charge — never a forked calculation.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import type { HouseholdCharge } from "@/lib/household-charges";
import { residentServiceFeeBreakdown } from "@/lib/payment-policy";

vi.mock("@/lib/stripe-household-charge", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/stripe-household-charge")>();
  return { ...actual, markHouseholdChargePaidFromPaymentIntent: vi.fn().mockResolvedValue({ ok: true }) };
});

const loadHouseholdChargesForCheckout = vi.fn();
const resolveHouseholdChargeFeePayer = vi.fn();
vi.mock("@/lib/stripe-household-charge-checkout.server", () => ({
  loadHouseholdChargesForCheckout: (...args: unknown[]) => loadHouseholdChargesForCheckout(...args),
  resolveHouseholdChargeFeePayer: (...args: unknown[]) => resolveHouseholdChargeFeePayer(...args),
}));

const resolveAndValidateManagerConnectForPayments = vi.fn();
vi.mock("@/lib/stripe-connect", () => ({
  resolveAndValidateManagerConnectForPayments: (...args: unknown[]) => resolveAndValidateManagerConnectForPayments(...args),
}));

const paymentIntentsCreate = vi.fn();
const paymentMethodsRetrieve = vi.fn();
vi.mock("@/lib/stripe", () => ({
  getStripe: () => ({
    paymentMethods: { retrieve: (...args: unknown[]) => paymentMethodsRetrieve(...args) },
    paymentIntents: { create: (...args: unknown[]) => paymentIntentsCreate(...args) },
  }),
}));

vi.mock("@/lib/payment-reminder-delivery", () => ({
  deliverPaymentReminder: vi.fn().mockResolvedValue({ sent: true }),
  reminderHtmlFromText: (text: string) => `<p>${text}</p>`,
}));
vi.mock("@/lib/payment-automation-settings", () => ({
  loadManagerAutomationSettings: vi.fn().mockResolvedValue({
    paymentReminderDeliverViaEmail: true,
    paymentReminderDeliverViaSms: false,
    paymentReminderDeliverViaInbox: true,
  }),
  DEFAULT_MANAGER_AUTOMATION_SETTINGS: {
    paymentReminderDeliverViaEmail: true,
    paymentReminderDeliverViaSms: false,
    paymentReminderDeliverViaInbox: true,
  },
}));
vi.mock("@/lib/manager-outbound-identity.server", () => ({
  managerOutboundFromHeader: vi.fn().mockResolvedValue("PropLane <noreply@proplane.test>"),
}));

import {
  AUTOPAY_RECURRING_KINDS,
  chargeAutopay,
  claimRun,
  listAutopayDueCharges,
  listFailedAutopayRunsEligibleForRetry,
  retryAutopayRun,
} from "@/lib/resident-autopay.server";

function charge(overrides: Partial<HouseholdCharge> = {}): HouseholdCharge {
  return {
    id: "hc_1",
    createdAt: "2026-01-01T00:00:00.000Z",
    residentEmail: "resident@example.com",
    residentName: "Pat Resident",
    residentUserId: "res_1",
    propertyId: "prop_1",
    propertyLabel: "12 Main St",
    managerUserId: "mgr_1",
    kind: "rent",
    title: "Rent — October",
    amountLabel: "$1,510.00",
    balanceLabel: "$1,510.00",
    status: "pending",
    blocksLeaseUntilPaid: false,
    dueDateLabel: "October 1, 2026",
    ...overrides,
  };
}

/**
 * A generic fake Supabase query builder: `.eq()`/`.in()` accumulate row
 * predicates over the flattened row shape `rowView(row)` returns, in any
 * order, and the builder itself is awaitable (`then`) so callers can `await`
 * it directly or call `.maybeSingle()`/`.single()` on it. Enough surface for
 * every read `resident-autopay.server.ts` issues, without hand-coding one
 * bespoke chain shape per call site.
 */
function queryBuilder<T>(rows: T[], rowView: (row: T) => Record<string, unknown>) {
  let filtered = rows;
  const builder = {
    eq(col: string, val: unknown) {
      filtered = filtered.filter((r) => rowView(r)[col] === val);
      return builder;
    },
    in(col: string, vals: unknown[]) {
      filtered = filtered.filter((r) => vals.includes(rowView(r)[col]));
      return builder;
    },
    async maybeSingle() {
      return { data: filtered[0] ?? null, error: null };
    },
    async single() {
      return filtered[0] ? { data: filtered[0], error: null } : { data: null, error: { message: "not found" } };
    },
    then(resolve: (r: { data: T[]; error: null }) => void) {
      resolve({ data: filtered, error: null });
    },
  };
  return builder;
}

/** A minimal fake Supabase client keyed by table name, generic enough for every read/write these functions issue. */
function makeFakeDb(tables: {
  resident_autopay_settings?: Record<string, unknown>[];
  portal_household_charge_records?: { id: string; row_data: HouseholdCharge }[];
  resident_autopay_runs?: Record<string, unknown>[];
  profiles?: Record<string, Record<string, unknown>>;
}) {
  const settings = tables.resident_autopay_settings ?? [];
  const charges = tables.portal_household_charge_records ?? [];
  const runs = tables.resident_autopay_runs ?? [];
  const profiles = tables.profiles ?? {};
  const inserted: Record<string, unknown>[] = [];

  return {
    db: {
      from(table: string) {
        if (table === "resident_autopay_settings") {
          return { select: () => queryBuilder(settings, (r) => r) };
        }
        if (table === "portal_household_charge_records") {
          return {
            select: () =>
              queryBuilder(charges, (r) => ({
                id: r.id,
                resident_user_id: r.row_data.residentUserId,
                status: r.row_data.status,
              })),
          };
        }
        if (table === "resident_autopay_runs") {
          return {
            select: () => queryBuilder(runs, (r) => r),
            insert: (row: Record<string, unknown>) => ({
              select: () => ({
                single: async () => {
                  const exists = runs.some((r) => r.charge_id === row.charge_id);
                  if (exists) {
                    return { data: null, error: { code: "23505", message: "duplicate key value violates unique constraint" } };
                  }
                  const saved = { id: `run_${runs.length + 1}`, ...row, updated_at: new Date().toISOString() };
                  runs.push(saved);
                  inserted.push(saved);
                  return { data: { id: saved.id }, error: null };
                },
              }),
            }),
            update: (patch: Record<string, unknown>) => {
              const builder = {
                _preds: [] as Array<[string, unknown]>,
                eq(col: string, val: unknown) {
                  builder._preds.push([col, val]);
                  return builder;
                },
                then(resolve: (r: { error: null }) => void) {
                  const row = runs.find((r) => builder._preds.every(([c, v]) => r[c] === v));
                  if (row) Object.assign(row, patch);
                  resolve({ error: null });
                },
              };
              return builder;
            },
          };
        }
        if (table === "profiles") {
          return { select: () => queryBuilder(Object.entries(profiles).map(([id, v]) => ({ id, ...v })), (r) => r) };
        }
        throw new Error(`fake db: unexpected table ${table}`);
      },
    } as never,
    inserted,
    runs,
  };
}

describe("AUTOPAY_RECURRING_KINDS", () => {
  it("covers rent and utilities only", () => {
    expect([...AUTOPAY_RECURRING_KINDS].sort()).toEqual(["rent", "utilities"]);
    expect(AUTOPAY_RECURRING_KINDS.has("application_fee")).toBe(false);
    expect(AUTOPAY_RECURRING_KINDS.has("security_deposit")).toBe(false);
  });
});

describe("listAutopayDueCharges", () => {
  it("lists an enrolled resident's recurring charge due today, minus days-before-due", async () => {
    const today = new Date(2026, 8, 28); // Sep 28, 2026 local
    const dueOct1 = charge({ id: "hc_due", dueDateLabel: "October 1, 2026" });
    const { db } = makeFakeDb({
      resident_autopay_settings: [
        {
          id: "s1",
          resident_user_id: "res_1",
          manager_id: "mgr_1",
          household_key: "resident@example.com|prop_1",
          enabled: true,
          payment_method_id: "pm_1",
          run_days_before_due: 3, // Oct 1 - 3 = Sep 28
        },
      ],
      portal_household_charge_records: [{ id: "hc_due", row_data: dueOct1 }],
    });

    const due = await listAutopayDueCharges(db, today);
    expect(due).toEqual([
      {
        chargeId: "hc_due",
        residentUserId: "res_1",
        residentEmail: "resident@example.com",
        managerId: "mgr_1",
        paymentMethodId: "pm_1",
      },
    ]);
  });

  it("excludes a one-off charge kind even when enrolled and due today", async () => {
    const today = new Date(2026, 8, 28);
    const feeCharge = charge({ id: "hc_fee", kind: "other_cost", dueDateLabel: "September 28, 2026" });
    const { db } = makeFakeDb({
      resident_autopay_settings: [
        {
          id: "s1",
          resident_user_id: "res_1",
          manager_id: "mgr_1",
          household_key: "resident@example.com|prop_1",
          enabled: true,
          payment_method_id: "pm_1",
          run_days_before_due: 0,
        },
      ],
      portal_household_charge_records: [{ id: "hc_fee", row_data: feeCharge }],
    });

    const due = await listAutopayDueCharges(db, today);
    expect(due).toEqual([]);
  });

  it("does not list a charge not yet due (days-before math not yet reached)", async () => {
    const today = new Date(2026, 8, 20); // Sep 20
    const dueOct1 = charge({ id: "hc_due", dueDateLabel: "October 1, 2026" });
    const { db } = makeFakeDb({
      resident_autopay_settings: [
        {
          id: "s1",
          resident_user_id: "res_1",
          manager_id: "mgr_1",
          household_key: "resident@example.com|prop_1",
          enabled: true,
          payment_method_id: "pm_1",
          run_days_before_due: 3, // eligible Sep 28, not Sep 20
        },
      ],
      portal_household_charge_records: [{ id: "hc_due", row_data: dueOct1 }],
    });

    expect(await listAutopayDueCharges(db, today)).toEqual([]);
  });
});

describe("claimRun", () => {
  it("is idempotent: a second claim for the same charge is skipped", async () => {
    const { db } = makeFakeDb({});
    const first = await claimRun(db, { chargeId: "hc_1", residentUserId: "res_1", managerId: "mgr_1" });
    expect(first.claimed).toBe(true);

    const second = await claimRun(db, { chargeId: "hc_1", residentUserId: "res_1", managerId: "mgr_1" });
    expect(second.claimed).toBe(false);
  });
});

describe("chargeAutopay — fee-payer parity with a manual checkout", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("computes the exact same fee breakdown residentServiceFeeBreakdown gives a manual checkout for the same charge", async () => {
    const rentCharge = charge();
    loadHouseholdChargesForCheckout.mockResolvedValue({
      ok: true,
      managerUserId: "mgr_1",
      loaded: [{ id: "hc_1", charge: rentCharge, managerUserId: "mgr_1", propertyFeePayer: null, propertyFeeWaiverCode: null }],
    });
    resolveHouseholdChargeFeePayer.mockResolvedValue({ ok: true, feePayer: "resident", managerTier: "pro" });
    resolveAndValidateManagerConnectForPayments.mockResolvedValue({ ok: true, accountId: "acct_123" });
    paymentMethodsRetrieve.mockResolvedValue({ type: "us_bank_account" });
    paymentIntentsCreate.mockResolvedValue({ id: "pi_123", status: "succeeded" });

    const { db } = makeFakeDb({
      profiles: { res_1: { stripe_customer_id: "cus_1" } },
    });

    const result = await chargeAutopay(db, {
      id: "run_1",
      chargeId: "hc_1",
      residentUserId: "res_1",
      residentEmail: "resident@example.com",
      managerId: "mgr_1",
      paymentMethodId: "pm_bank_1",
    });

    expect(result.ok).toBe(true);

    // Independently computed the same way a manual ACH checkout would.
    const expectedFee = residentServiceFeeBreakdown(151_000, "ach", "resident");

    expect(paymentIntentsCreate).toHaveBeenCalledTimes(1);
    const args = paymentIntentsCreate.mock.calls[0][0];
    expect(args.amount).toBe(expectedFee.totalCents);
    expect(args.application_fee_amount).toBe(expectedFee.applicationFeeCents);
    expect(args.transfer_data).toEqual({ destination: "acct_123" });
    expect(args.off_session).toBe(true);
    expect(args.confirm).toBe(true);
    expect(args.customer).toBe("cus_1");
    expect(args.payment_method).toBe("pm_bank_1");
    expect(args.metadata.autopay_run_id).toBe("run_1");
    expect(args.metadata.charge_id).toBe("hc_1");
  });

  it("fails the run and records a reason when the manager has no ready Connect account", async () => {
    const rentCharge = charge();
    loadHouseholdChargesForCheckout.mockResolvedValue({
      ok: true,
      managerUserId: "mgr_1",
      loaded: [{ id: "hc_1", charge: rentCharge, managerUserId: "mgr_1", propertyFeePayer: null, propertyFeeWaiverCode: null }],
    });
    resolveHouseholdChargeFeePayer.mockResolvedValue({ ok: true, feePayer: "resident", managerTier: "pro" });
    resolveAndValidateManagerConnectForPayments.mockResolvedValue({
      ok: false,
      code: "NO_ACCOUNT",
      error: "This property manager has not connected Stripe payouts yet.",
    });

    const { db, runs } = makeFakeDb({
      resident_autopay_runs: [{ id: "run_1", charge_id: "hc_1", status: "claimed", updated_at: new Date().toISOString() }],
      profiles: { res_1: { stripe_customer_id: "cus_1" } },
    });

    const result = await chargeAutopay(db, {
      id: "run_1",
      chargeId: "hc_1",
      residentUserId: "res_1",
      residentEmail: "resident@example.com",
      managerId: "mgr_1",
      paymentMethodId: "pm_bank_1",
    });

    expect(result.ok).toBe(false);
    expect(paymentIntentsCreate).not.toHaveBeenCalled();
    expect(runs.find((r) => r.id === "run_1")?.status).toBe("failed");
  });
});

describe("retryAutopayRun", () => {
  it("refuses a retry before 3 days have passed", async () => {
    const { db } = makeFakeDb({});
    const result = await retryAutopayRun(
      db,
      { id: "run_1", updatedAt: new Date().toISOString(), failureReason: "declined" },
      new Date(),
    );
    expect(result.retried).toBe(false);
  });

  it("allows exactly one retry, then refuses a second", async () => {
    const now = new Date("2026-01-10T00:00:00.000Z");
    const failedAt = new Date("2026-01-06T00:00:00.000Z").toISOString();
    const { db } = makeFakeDb({
      resident_autopay_runs: [{ id: "run_1", charge_id: "hc_1", status: "failed", updated_at: failedAt }],
    });

    const first = await retryAutopayRun(db, { id: "run_1", updatedAt: failedAt, failureReason: "declined" }, now);
    expect(first.retried).toBe(true);

    // After chargeAutopay's attempt:2 failure path would tag the reason.
    const second = await retryAutopayRun(
      db,
      { id: "run_1", updatedAt: now.toISOString(), failureReason: "[retry] declined again" },
      new Date("2026-01-20T00:00:00.000Z"),
    );
    expect(second.retried).toBe(false);
  });
});

describe("listFailedAutopayRunsEligibleForRetry", () => {
  it("only returns failed runs old enough, never retried, still enrolled, and still unpaid", async () => {
    const now = new Date("2026-01-10T00:00:00.000Z");
    const oldEnough = new Date("2026-01-06T00:00:00.000Z").toISOString();
    const tooRecent = new Date("2026-01-09T12:00:00.000Z").toISOString();

    const eligibleCharge = charge({ id: "hc_eligible", residentEmail: "a@example.com", propertyId: "prop_a" });
    const alreadyRetriedCharge = charge({ id: "hc_retried", residentEmail: "b@example.com", propertyId: "prop_b" });
    const paidCharge = charge({ id: "hc_paid", residentEmail: "c@example.com", propertyId: "prop_c", status: "paid", balanceLabel: "$0.00" });

    const { db } = makeFakeDb({
      resident_autopay_runs: [
        { id: "run_eligible", charge_id: "hc_eligible", resident_user_id: "res_a", manager_id: "mgr_1", status: "failed", failure_reason: "declined", updated_at: oldEnough },
        { id: "run_too_recent", charge_id: "hc_too_recent", resident_user_id: "res_x", manager_id: "mgr_1", status: "failed", failure_reason: "declined", updated_at: tooRecent },
        { id: "run_retried", charge_id: "hc_retried", resident_user_id: "res_b", manager_id: "mgr_1", status: "failed", failure_reason: "[retry] declined", updated_at: oldEnough },
        { id: "run_paid", charge_id: "hc_paid", resident_user_id: "res_c", manager_id: "mgr_1", status: "failed", failure_reason: "declined", updated_at: oldEnough },
      ],
      portal_household_charge_records: [
        { id: "hc_eligible", row_data: eligibleCharge },
        { id: "hc_retried", row_data: alreadyRetriedCharge },
        { id: "hc_paid", row_data: paidCharge },
      ],
      resident_autopay_settings: [
        { resident_user_id: "res_a", household_key: "a@example.com|prop_a", enabled: true, payment_method_id: "pm_a" },
        { resident_user_id: "res_b", household_key: "b@example.com|prop_b", enabled: true, payment_method_id: "pm_b" },
        { resident_user_id: "res_c", household_key: "c@example.com|prop_c", enabled: true, payment_method_id: "pm_c" },
      ],
    });

    const candidates = await listFailedAutopayRunsEligibleForRetry(db, now);
    expect(candidates.map((c) => c.chargeId)).toEqual(["hc_eligible"]);
  });
});
