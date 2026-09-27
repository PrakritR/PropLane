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

const resolveConnectDestinationIfReady = vi.fn();
vi.mock("@/lib/stripe-connect", () => ({
  resolveConnectDestinationIfReady: (...args: unknown[]) => resolveConnectDestinationIfReady(...args),
}));

vi.mock("@/lib/stripe-platform-hold.server", () => ({
  creditHoldFromPaymentIntent: vi.fn().mockResolvedValue({ credited: false }),
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
  AUTOPAY_MAX_ATTEMPTS,
  AUTOPAY_RECURRING_KINDS,
  chargeAutopay,
  claimRun,
  listAutopayDueCharges,
  listFailedAutopayRunsEligibleForRetry,
  resolveResidentAutopayHousehold,
  retryAutopayRun,
} from "@/lib/resident-autopay.server";

/** Noon Pacific on the given calendar day — one instant whose Pacific date is unambiguous on any test machine. */
function pacificNoon(ymd: string): Date {
  return new Date(`${ymd}T12:00:00-07:00`);
}

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
    limit() {
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
                resident_email: r.row_data.residentEmail,
                manager_user_id: r.row_data.managerUserId,
                kind: r.row_data.kind,
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
                _selected: false,
                eq(col: string, val: unknown) {
                  builder._preds.push([col, val]);
                  return builder;
                },
                select() {
                  builder._selected = true;
                  return builder;
                },
                then(resolve: (r: { data: Record<string, unknown>[] | null; error: null }) => void) {
                  const matched = runs.filter((r) => builder._preds.every(([c, v]) => r[c] === v));
                  for (const row of matched) Object.assign(row, patch);
                  resolve({ data: builder._selected ? matched.map((r) => ({ id: r.id })) : null, error: null });
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
    const today = pacificNoon("2026-09-28");
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
        propertyId: "prop_1",
        paymentMethodId: "pm_1",
      },
    ]);
  });

  it("lists a charge whose run date has already passed (missed pass, late enrollment) — the run row, not the date, guards double charging", async () => {
    const today = pacificNoon("2026-10-03");
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
          run_days_before_due: 0,
        },
      ],
      portal_household_charge_records: [{ id: "hc_due", row_data: dueOct1 }],
    });

    expect((await listAutopayDueCharges(db, today)).map((d) => d.chargeId)).toEqual(["hc_due"]);
  });

  it("does not list a charge that already has a run row, whatever its status", async () => {
    const today = pacificNoon("2026-10-03");
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
          run_days_before_due: 0,
        },
      ],
      portal_household_charge_records: [{ id: "hc_due", row_data: dueOct1 }],
      resident_autopay_runs: [{ id: "run_1", charge_id: "hc_due", status: "failed", attempt: 1 }],
    });

    expect(await listAutopayDueCharges(db, today)).toEqual([]);
  });

  it("decides the run day in Pacific time: 23:30 Pacific on Sep 30 (06:30 UTC Oct 1) is still Sep 30", async () => {
    const lateSep30Pacific = new Date("2026-10-01T06:30:00Z");
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
          run_days_before_due: 0,
        },
      ],
      portal_household_charge_records: [{ id: "hc_due", row_data: dueOct1 }],
    });

    expect(await listAutopayDueCharges(db, lateSep30Pacific)).toEqual([]);
  });

  it("excludes a one-off charge kind even when enrolled and due today", async () => {
    const today = pacificNoon("2026-09-28");
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
    const today = pacificNoon("2026-09-20");
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
    resolveConnectDestinationIfReady.mockResolvedValue("acct_123");
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
    expect(args.metadata.autopay_attempt).toBe("1");
    // One PaymentIntent per (run, attempt): a lost response never becomes a second debit.
    expect(paymentIntentsCreate.mock.calls[0][1]).toEqual({ idempotencyKey: "autopay:run_1:1" });
  });

  it("keys the retry attempt's PaymentIntent separately and records the attempt in metadata", async () => {
    const rentCharge = charge();
    loadHouseholdChargesForCheckout.mockResolvedValue({
      ok: true,
      managerUserId: "mgr_1",
      loaded: [{ id: "hc_1", charge: rentCharge, managerUserId: "mgr_1", propertyFeePayer: null, propertyFeeWaiverCode: null }],
    });
    resolveHouseholdChargeFeePayer.mockResolvedValue({ ok: true, feePayer: "resident", managerTier: "pro" });
    resolveConnectDestinationIfReady.mockResolvedValue("acct_123");
    paymentMethodsRetrieve.mockResolvedValue({ type: "us_bank_account" });
    paymentIntentsCreate.mockResolvedValue({ id: "pi_456", status: "processing" });

    const { db } = makeFakeDb({ profiles: { res_1: { stripe_customer_id: "cus_1" } } });
    const result = await chargeAutopay(db, {
      id: "run_1",
      chargeId: "hc_1",
      residentUserId: "res_1",
      residentEmail: "resident@example.com",
      managerId: "mgr_1",
      paymentMethodId: "pm_bank_1",
      attempt: 2,
    });

    expect(result.ok).toBe(true);
    expect(paymentIntentsCreate.mock.calls[0][0].metadata.autopay_attempt).toBe("2");
    expect(paymentIntentsCreate.mock.calls[0][1]).toEqual({ idempotencyKey: "autopay:run_1:2" });
  });

  it("charges the platform (hold) when the manager has no ready Connect account", async () => {
    const rentCharge = charge();
    loadHouseholdChargesForCheckout.mockResolvedValue({
      ok: true,
      managerUserId: "mgr_1",
      loaded: [{ id: "hc_1", charge: rentCharge, managerUserId: "mgr_1", propertyFeePayer: null, propertyFeeWaiverCode: null }],
    });
    resolveHouseholdChargeFeePayer.mockResolvedValue({ ok: true, feePayer: "resident", managerTier: "pro" });
    resolveConnectDestinationIfReady.mockResolvedValue(null);
    paymentMethodsRetrieve.mockResolvedValue({ type: "us_bank_account" });
    paymentIntentsCreate.mockResolvedValue({ id: "pi_hold", status: "succeeded" });

    const { db } = makeFakeDb({
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

    expect(result.ok).toBe(true);
    const args = paymentIntentsCreate.mock.calls[0][0];
    expect(args.transfer_data).toBeUndefined();
    expect(args.application_fee_amount).toBeUndefined();
    expect(args.metadata.platform_hold).toBe("1");
  });
});

describe("retryAutopayRun", () => {
  it("refuses a retry before 3 days have passed", async () => {
    const { db } = makeFakeDb({});
    const result = await retryAutopayRun(db, { id: "run_1", updatedAt: new Date().toISOString(), attempt: 1 }, new Date());
    expect(result.retried).toBe(false);
  });

  it("allows exactly one retry (bumping the row's attempt), then refuses a second", async () => {
    const now = new Date("2026-01-10T00:00:00.000Z");
    const failedAt = new Date("2026-01-06T00:00:00.000Z").toISOString();
    const { db, runs } = makeFakeDb({
      resident_autopay_runs: [
        { id: "run_1", charge_id: "hc_1", status: "failed", attempt: 1, failure_reason: "declined", updated_at: failedAt },
      ],
    });

    const first = await retryAutopayRun(db, { id: "run_1", updatedAt: failedAt, attempt: 1 }, now);
    expect(first).toEqual({ retried: true, attempt: 2 });
    expect(runs[0]).toMatchObject({ status: "claimed", attempt: 2, failure_reason: null });

    // The webhook (or the sync path) fails the second attempt WITHOUT any
    // string tag — the attempt counter alone is what spends the retry.
    Object.assign(runs[0]!, { status: "failed", failure_reason: "declined again", updated_at: now.toISOString() });
    const second = await retryAutopayRun(
      db,
      { id: "run_1", updatedAt: now.toISOString(), attempt: AUTOPAY_MAX_ATTEMPTS },
      new Date("2026-01-20T00:00:00.000Z"),
    );
    expect(second.retried).toBe(false);
    expect(runs[0]!.status).toBe("failed");
  });

  it("reports retried: false when another pass already transitioned the row (no double claim)", async () => {
    const now = new Date("2026-01-10T00:00:00.000Z");
    const failedAt = new Date("2026-01-06T00:00:00.000Z").toISOString();
    const { db } = makeFakeDb({
      resident_autopay_runs: [{ id: "run_1", charge_id: "hc_1", status: "failed", attempt: 1, updated_at: failedAt }],
    });

    const first = await retryAutopayRun(db, { id: "run_1", updatedAt: failedAt, attempt: 1 }, now);
    expect(first.retried).toBe(true);
    // An overlapping invocation listed the same failed row a moment earlier.
    const overlapping = await retryAutopayRun(db, { id: "run_1", updatedAt: failedAt, attempt: 1 }, now);
    expect(overlapping.retried).toBe(false);
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
        { id: "run_eligible", charge_id: "hc_eligible", resident_user_id: "res_a", manager_id: "mgr_1", status: "failed", attempt: 1, failure_reason: "declined", updated_at: oldEnough },
        { id: "run_too_recent", charge_id: "hc_too_recent", resident_user_id: "res_x", manager_id: "mgr_1", status: "failed", attempt: 1, failure_reason: "declined", updated_at: tooRecent },
        // Spent its retry; the failure was recorded by the webhook with no tag at all.
        { id: "run_retried", charge_id: "hc_retried", resident_user_id: "res_b", manager_id: "mgr_1", status: "failed", attempt: 2, failure_reason: "declined", updated_at: oldEnough },
        { id: "run_paid", charge_id: "hc_paid", resident_user_id: "res_c", manager_id: "mgr_1", status: "failed", attempt: 1, failure_reason: "declined", updated_at: oldEnough },
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
    expect(candidates[0]).toMatchObject({ attempt: 1, updatedAt: oldEnough });
  });
});

describe("resolveResidentAutopayHousehold", () => {
  const twoTenancies = [
    { id: "hc_b_oct", row_data: charge({ id: "hc_b_oct", propertyId: "prop_b", dueDateLabel: "October 1, 2026" }) },
    { id: "hc_a_nov", row_data: charge({ id: "hc_a_nov", propertyId: "prop_a", dueDateLabel: "November 1, 2026" }) },
    { id: "hc_a_sep", row_data: charge({ id: "hc_a_sep", propertyId: "prop_a", dueDateLabel: "September 1, 2026", status: "paid", balanceLabel: "$0.00" }) },
  ];

  it("picks the property of the soonest-due unpaid recurring charge when none is named, and the same one every call", async () => {
    const { db } = makeFakeDb({ portal_household_charge_records: twoTenancies });
    const first = await resolveResidentAutopayHousehold(db, { residentEmail: "resident@example.com", managerId: "mgr_1" });
    const again = await resolveResidentAutopayHousehold(db, { residentEmail: "resident@example.com", managerId: "mgr_1" });
    expect(first).toMatchObject({ propertyId: "prop_b", householdKey: "resident@example.com|prop_b" });
    expect(first?.nextCharge?.id).toBe("hc_b_oct");
    expect(again).toEqual(first);
  });

  it("breaks a due-date tie by propertyId ascending", async () => {
    const { db } = makeFakeDb({
      portal_household_charge_records: [
        { id: "hc_z", row_data: charge({ id: "hc_z", propertyId: "prop_z", dueDateLabel: "October 1, 2026" }) },
        { id: "hc_a", row_data: charge({ id: "hc_a", propertyId: "prop_a", dueDateLabel: "October 1, 2026" }) },
      ],
    });
    const household = await resolveResidentAutopayHousehold(db, { residentEmail: "resident@example.com", managerId: "mgr_1" });
    expect(household?.propertyId).toBe("prop_a");
  });

  it("honours a named propertyId the resident actually holds a recurring charge for, and refuses one they do not", async () => {
    const { db } = makeFakeDb({ portal_household_charge_records: twoTenancies });
    const named = await resolveResidentAutopayHousehold(db, {
      residentEmail: "resident@example.com",
      managerId: "mgr_1",
      propertyId: "prop_a",
    });
    expect(named).toMatchObject({ propertyId: "prop_a", householdKey: "resident@example.com|prop_a" });
    expect(named?.nextCharge?.id).toBe("hc_a_nov");

    const foreign = await resolveResidentAutopayHousehold(db, {
      residentEmail: "resident@example.com",
      managerId: "mgr_1",
      propertyId: "prop_someone_elses",
    });
    expect(foreign).toBeNull();
  });

  it("never previews a charge that already has a run row — the sweep will not pick it up", async () => {
    const { db } = makeFakeDb({
      portal_household_charge_records: twoTenancies,
      resident_autopay_runs: [{ id: "run_1", charge_id: "hc_b_oct", status: "failed", attempt: 1 }],
    });
    const household = await resolveResidentAutopayHousehold(db, { residentEmail: "resident@example.com", managerId: "mgr_1" });
    expect(household?.propertyId).toBe("prop_b");
    expect(household?.nextCharge).toBeNull();
  });

  it("treats a Postgres invalid-uuid rejection (a malformed manager_id, e.g. a legacy non-UUID fixture id) as no household instead of throwing", async () => {
    // A resident profile can carry a manager_id that isn't a real UUID (data
    // corruption, or a pre-migration legacy id). manager_user_id is a `uuid`
    // column, so Postgres rejects the whole query with 22P02 rather than
    // returning zero rows. GET /api/resident/autopay must surface the same
    // "no household" response every other not-yet-linked resident gets, not
    // a 500 (Night QA finding #1: resident/move-in 500s twice per load).
    const db = {
      from(table: string) {
        if (table === "portal_household_charge_records") {
          return {
            select: () => ({
              eq: () => ({
                eq: () => ({
                  in: () => ({
                    limit: async () => ({
                      data: null,
                      error: { code: "22P02", message: 'invalid input syntax for type uuid: "AXIS-TESTRSID"' },
                    }),
                  }),
                }),
              }),
            }),
          };
        }
        throw new Error(`unexpected table ${table}`);
      },
    };
    const household = await resolveResidentAutopayHousehold(db as never, {
      residentEmail: "resident@example.com",
      managerId: "AXIS-TESTRSID",
    });
    expect(household).toBeNull();
  });
});
