/**
 * MONEY: a resident enters a waive code on the pay-before-signing step. A valid LEASE (or BOTH) code cancels the
 * lease fee exactly like the manager's per-lease waiver and drops it out of the at-signing total; every refusal
 * leaves the fee owed and spends nothing; the use cap is atomic.
 *
 * The code tables and both redeem functions are REAL Postgres (the migrations replayed into PGlite); the lease and
 * charge tables are the in-memory fake the lease-fee suite already uses.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fakeSupabaseClient, type Row } from "./helpers/fake-supabase-tables";

vi.mock("@/lib/household-charge-payment-eligibility.server", () => ({
  enrichHouseholdChargesFromPropertyRecords: async (_db: unknown, charges: Array<Record<string, unknown>>) =>
    charges.map((c) => ({ ...c, axisPaymentsEnabledSnapshot: true, managerStripeConnectReadySnapshot: true })),
  enrichHouseholdChargesFromPropertyRecordsResult: async (_db: unknown, charges: Array<Record<string, unknown>>) => ({
    charges: charges.map((c) => ({ ...c, axisPaymentsEnabledSnapshot: true, managerStripeConnectReadySnapshot: true })),
    lookupFailed: false,
  }),
}));
vi.mock("@/lib/reports/ledger-sync", () => ({ syncLedgerChargeEntry: vi.fn(async () => undefined) }));
vi.mock("@/lib/payment-reminder-lifecycle.server", () => ({
  cancelFuturePaymentRemindersForCharge: vi.fn(async () => undefined),
  restoreFuturePaymentRemindersForCharge: vi.fn(async () => undefined),
}));
vi.mock("@/lib/auth/manager-lease-scope", () => ({
  managerCanAccessLeaseRecord: async (_db: unknown, userId: string, record: { manager_user_id: string | null }) =>
    record.manager_user_id === userId,
}));

import { checkResidentAtSigningGate } from "@/lib/lease-at-signing.server";
import { redeemLeaseFeeWaiverCode, reinstateLeaseFee, waiveLeaseFee } from "@/lib/lease-fee-waiver.server";

const MANAGER = "11111111-1111-4111-8111-111111111111";
const OTHER_MANAGER = "33333333-3333-4333-8333-333333333333";
const RESIDENT = "22222222-2222-4222-8222-222222222222";
const STRANGER = "44444444-4444-4444-8444-444444444444";
const EMAIL = "signer@example.com";
const LEASE_ID = "lease-1";
const FEE_CHARGE = "hc_app_app_signer_lease_fee";

const MIGRATIONS = [
  "20260726190000_application_fee_waiver_codes.sql",
  "20260909210000_scope_application_fee_waiver_codes_to_property.sql",
  "20261003210000_waive_codes_applies_to_and_property_limits.sql",
];
const PG_TABLES = new Set(["manager_application_fee_waiver_codes", "application_fee_waiver_redemptions"]);

let pg: PGlite;
let tables: Record<string, Row[]>;
/** "fail" = the charge write errors; "lost-race" = the status precondition matches no row. */
let chargeWriteMode: null | "fail" | "lost-race" = null;
let failLeaseWrites = false;

/** The slice of the PostgREST builder the redemption path uses, answered by real Postgres. */
class PgQuery implements PromiseLike<{ data: Row[] | null; error: { message: string } | null }> {
  private columns = "*";
  private filters: { col: string; val: unknown }[] = [];
  constructor(private readonly table: string) {}
  select(columns = "*") {
    this.columns = columns;
    return this;
  }
  eq(col: string, val: unknown) {
    this.filters.push({ col, val });
    return this;
  }
  limit() {
    return this;
  }
  private async run(): Promise<{ data: Row[] | null; error: { message: string } | null }> {
    const where = this.filters.map((f, i) => `${f.col} = $${i + 1}`).join(" and ");
    try {
      const res = await pg.query<Row>(
        `select ${this.columns} from public.${this.table}${where ? ` where ${where}` : ""}`,
        this.filters.map((f) => f.val),
      );
      return { data: res.rows, error: null };
    } catch (e) {
      return { data: null, error: { message: e instanceof Error ? e.message : String(e) } };
    }
  }
  async maybeSingle() {
    const { data, error } = await this.run();
    return { data: data?.[0] ?? null, error };
  }
  then<T1 = { data: Row[] | null; error: { message: string } | null }, T2 = never>(
    onfulfilled?: ((v: { data: Row[] | null; error: { message: string } | null }) => T1 | PromiseLike<T1>) | null,
    onrejected?: ((r: unknown) => T2 | PromiseLike<T2>) | null,
  ) {
    return this.run().then(onfulfilled, onrejected);
  }
}

function makeDb() {
  const fake = fakeSupabaseClient(tables);
  return {
    from(table: string) {
      if (PG_TABLES.has(table)) return new PgQuery(table);
      if (chargeWriteMode && table === "portal_household_charge_records") {
        const real = fake.from(table);
        const answer =
          chargeWriteMode === "fail"
            ? { data: null, error: { message: "write failed" } }
            : { data: [], error: null };
        return Object.assign(real, {
          update: () => ({ eq: () => ({ or: () => ({ select: async () => answer }) }) }),
        });
      }
      if (failLeaseWrites && table === "portal_lease_pipeline_records") {
        const real = fake.from(table);
        return Object.assign(real, { update: () => ({ eq: async () => ({ error: { message: "lease write failed" } }) }) });
      }
      return fake.from(table);
    },
    async rpc(name: string, args: Record<string, unknown>) {
      const keys = Object.keys(args);
      const named = keys.map((k, i) => `${k} => $${i + 1}`).join(", ");
      try {
        const res = await pg.query<Row>(`select * from public.${name}(${named})`, keys.map((k) => args[k]));
        return { data: res.rows, error: null };
      } catch (e) {
        return { data: null, error: { message: e instanceof Error ? e.message : String(e) } };
      }
    },
  } as never;
}

async function seedCode(opts: {
  code: string;
  appliesTo?: string;
  propertyIds?: string[] | null;
  maxUses?: number | null;
  status?: string;
  expiresAt?: string | null;
  managerUserId?: string;
}): Promise<string> {
  const res = await pg.query<{ id: string }>(
    `insert into public.manager_application_fee_waiver_codes
       (manager_user_id, code, code_normalized, applies_to, property_ids, max_uses, status, expires_at)
     values ($1, $2, $2, $3, $4, $5, $6, $7) returning id`,
    [
      opts.managerUserId ?? MANAGER,
      opts.code,
      opts.appliesTo ?? "lease",
      opts.propertyIds ?? null,
      opts.maxUses ?? null,
      opts.status ?? "active",
      opts.expiresAt ?? null,
    ],
  );
  return res.rows[0]!.id;
}

async function usedCount(codeId: string): Promise<number> {
  const res = await pg.query<{ used_count: number }>(
    `select used_count from public.manager_application_fee_waiver_codes where id = $1`,
    [codeId],
  );
  return res.rows[0]!.used_count;
}

function charge(over: Record<string, unknown>): Row {
  const data = {
    id: FEE_CHARGE,
    createdAt: "2026-10-03T00:00:00.000Z",
    applicationId: "AXIS-APP-1",
    residentEmail: EMAIL,
    residentName: "Signer",
    residentUserId: RESIDENT,
    propertyId: "prop-1",
    propertyLabel: "Cascade Lofts",
    managerUserId: MANAGER,
    kind: "lease_fee",
    title: "Lease fee",
    amountLabel: "$300.00",
    balanceLabel: "$300.00",
    status: "pending",
    blocksLeaseUntilPaid: false,
    dueAtSigning: true,
    ...over,
  };
  return {
    id: data.id,
    manager_user_id: MANAGER,
    resident_user_id: RESIDENT,
    resident_email: EMAIL,
    property_id: "prop-1",
    kind: data.kind,
    status: data.status,
    row_data: data,
  };
}

function leaseRow(over: Record<string, unknown> = {}): Row {
  return {
    id: LEASE_ID,
    manager_user_id: MANAGER,
    resident_user_id: RESIDENT,
    property_id: "prop-1",
    resident_email: EMAIL,
    row_data: {
      id: LEASE_ID,
      axisId: "AXIS-APP-1",
      residentEmail: EMAIL,
      residentName: "Signer",
      propertyId: "prop-1",
      status: "Resident Signature Pending",
      bucket: "resident",
      application: { fullLegalName: "Signer", leaseTerm: "Long-Term", leaseStart: "2026-11-01" },
    },
    ...over,
  };
}

const lease = { axisId: "AXIS-APP-1", residentEmail: EMAIL, propertyId: "prop-1" };
const redeem = (code: string, over: Partial<{ residentUserId: string; residentEmail: string; leaseId: string }> = {}) =>
  redeemLeaseFeeWaiverCode(makeDb(), {
    residentUserId: over.residentUserId ?? RESIDENT,
    residentEmail: over.residentEmail ?? EMAIL,
    leaseId: over.leaseId ?? LEASE_ID,
    code,
  });
const feeChargeStatus = () => tables.portal_household_charge_records!.find((r) => r.id === FEE_CHARGE)!.status;

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(`create role anon; create role authenticated; create role service_role;
    create schema auth; create table auth.users(id uuid primary key);`);
  await pg.exec(`insert into auth.users(id) values ('${MANAGER}'), ('${OTHER_MANAGER}') on conflict do nothing;`);
  for (const file of MIGRATIONS) await pg.exec(readFileSync(join(process.cwd(), "supabase/migrations", file), "utf8"));
}, 30_000);

afterAll(async () => {
  await pg?.close();
});

beforeEach(async () => {
  chargeWriteMode = null;
  failLeaseWrites = false;
  await pg.exec(`delete from public.application_fee_waiver_redemptions; delete from public.manager_application_fee_waiver_codes;`);
  tables = {
    portal_household_charge_records: [
      charge({}),
      charge({
        id: "hc_app_app_signer_security_deposit",
        kind: "security_deposit",
        title: "Security deposit",
        amountLabel: "$500.00",
        balanceLabel: "$500.00",
      }),
    ],
    portal_lease_pipeline_records: [leaseRow()],
    audit_log: [],
  };
});

describe("a valid lease code waives the lease fee", () => {
  it("cancels the charge, drops it from the at-signing total, audits it, and spends one use", async () => {
    const codeId = await seedCode({ code: "SPRING25", appliesTo: "lease", maxUses: 5 });
    const before = await checkResidentAtSigningGate(makeDb(), { lease, residentUserId: RESIDENT, residentEmail: EMAIL });
    expect(before.ok && before.unpaidCents).toBe(80_000);

    const result = await redeem("spring25");
    expect(result).toMatchObject({ ok: true, alreadyWaived: false, cancelledChargeIds: [FEE_CHARGE] });

    expect(feeChargeStatus()).toBe("cancelled");
    const stored = tables.portal_household_charge_records!.find((r) => r.id === FEE_CHARGE)!;
    expect(stored.row_data).toMatchObject({ status: "cancelled", waiverReason: "Waive code SPRING25", waivedByUserId: MANAGER });
    const leaseData = tables.portal_lease_pipeline_records![0]!.row_data as {
      application: { managerLeaseFeeWaiver?: { reason: string } };
    };
    expect(leaseData.application.managerLeaseFeeWaiver?.reason).toBe("Waive code SPRING25");

    // The fee is gone from what the resident must pay before signing; the deposit is untouched.
    const after = await checkResidentAtSigningGate(makeDb(), { lease, residentUserId: RESIDENT, residentEmail: EMAIL });
    expect(after.ok && after.unpaid.map((c) => c.kind)).toEqual(["security_deposit"]);
    expect(after.ok && after.unpaidCents).toBe(50_000);

    // Audit: the resident's act under the manager's workspace, naming the code.
    expect(tables.audit_log).toHaveLength(1);
    expect(tables.audit_log![0]).toMatchObject({
      action: "lease_fee_waived_by_code",
      actor_user_id: RESIDENT,
      landlord_id: MANAGER,
    });
    expect(tables.audit_log![0]!.input_summary).toMatchObject({ leaseId: LEASE_ID, code: "SPRING25", residentEmail: EMAIL });

    expect(await usedCount(codeId)).toBe(1);
    const redemptions = await pg.query<{ kind: string; lease_id: string; resident_email: string }>(
      `select kind, lease_id, resident_email from public.application_fee_waiver_redemptions where code_id = $1`,
      [codeId],
    );
    expect(redemptions.rows).toEqual([{ kind: "lease", lease_id: LEASE_ID, resident_email: EMAIL }]);
  });

  it("a both code works for the lease fee too", async () => {
    const codeId = await seedCode({ code: "EVERYTHING", appliesTo: "both" });
    expect(await redeem("EVERYTHING")).toMatchObject({ ok: true });
    expect(feeChargeStatus()).toBe("cancelled");
    expect(await usedCount(codeId)).toBe(1);
  });

  it("a code limited to this property works there", async () => {
    await seedCode({ code: "HOUSE-ONE", appliesTo: "lease", propertyIds: ["prop-1", "prop-9"] });
    expect(await redeem("HOUSE-ONE")).toMatchObject({ ok: true });
    expect(feeChargeStatus()).toBe("cancelled");
  });

  it("the lease owner (user id) may redeem even when the email on file differs", async () => {
    await seedCode({ code: "BYUSERID" });
    expect(await redeem("BYUSERID", { residentEmail: "alias@example.com" })).toMatchObject({ ok: true });
  });
});

describe("a code that cannot be used leaves the fee owed and spends nothing", () => {
  it("an application-only code is not valid for a lease", async () => {
    const codeId = await seedCode({ code: "APPONLY1", appliesTo: "application" });
    expect(await redeem("APPONLY1")).toMatchObject({ ok: false, status: 400, reason: "NOT_FOUND" });
    expect(feeChargeStatus()).toBe("pending");
    expect(await usedCount(codeId)).toBe(0);
  });

  it("a code limited to other properties is not valid on this one", async () => {
    const codeId = await seedCode({ code: "ELSEWHERE", appliesTo: "both", propertyIds: ["prop-9"] });
    expect(await redeem("ELSEWHERE")).toMatchObject({ ok: false, reason: "NOT_FOUND" });
    expect(feeChargeStatus()).toBe("pending");
    expect(await usedCount(codeId)).toBe(0);
  });

  it("another manager's code is not valid on this manager's lease", async () => {
    const codeId = await seedCode({ code: "NOTYOURS1", appliesTo: "both", managerUserId: OTHER_MANAGER });
    expect(await redeem("NOTYOURS1")).toMatchObject({ ok: false, reason: "NOT_FOUND" });
    expect(feeChargeStatus()).toBe("pending");
    expect(await usedCount(codeId)).toBe(0);
  });

  it("an unknown, revoked, expired or used-up code each says why", async () => {
    expect(await redeem("NOSUCHCODE")).toMatchObject({ ok: false, reason: "NOT_FOUND" });

    await seedCode({ code: "REVOKED-1", status: "revoked" });
    expect(await redeem("REVOKED-1")).toMatchObject({ ok: false, reason: "REVOKED" });

    await seedCode({ code: "EXPIRED-1", expiresAt: "2020-01-01T00:00:00Z" });
    expect(await redeem("EXPIRED-1")).toMatchObject({ ok: false, reason: "EXPIRED" });

    const usedUp = await seedCode({ code: "USEDUP-1", maxUses: 1 });
    await pg.query(`update public.manager_application_fee_waiver_codes set used_count = 1 where id = $1`, [usedUp]);
    expect(await redeem("USEDUP-1")).toMatchObject({ ok: false, reason: "EXHAUSTED" });

    expect(feeChargeStatus()).toBe("pending");
  });

  it("a stranger who is not on the lease is told it does not exist, and nothing is spent", async () => {
    const codeId = await seedCode({ code: "STRANGER1" });
    const result = await redeem("STRANGER1", { residentUserId: STRANGER, residentEmail: "stranger@example.com" });
    expect(result).toMatchObject({ ok: false, status: 404, reason: "LEASE_NOT_FOUND" });
    expect(feeChargeStatus()).toBe("pending");
    expect(await usedCount(codeId)).toBe(0);
  });

  it("is refused once the lease fee is paid, clearing or refunded", async () => {
    const codeId = await seedCode({ code: "TOOLATE1" });
    for (const status of ["paid", "processing", "partially_paid", "refunded"]) {
      tables.portal_household_charge_records![0]!.status = status;
      expect(await redeem("TOOLATE1")).toMatchObject({ ok: false, status: 409, reason: "ALREADY_PAID" });
    }
    expect(await usedCount(codeId)).toBe(0);
  });

  it("a voided lease and a lease with no fee have nothing to waive", async () => {
    const codeId = await seedCode({ code: "NOTHING-1" });
    tables.portal_household_charge_records = [tables.portal_household_charge_records![1]!];
    expect(await redeem("NOTHING-1")).toMatchObject({ ok: false, reason: "NO_FEE" });

    const row = tables.portal_lease_pipeline_records![0]!.row_data as Record<string, unknown>;
    row.status = "Voided";
    row.voidedAt = "2026-10-03T12:00:00.000Z";
    expect(await redeem("NOTHING-1")).toMatchObject({ ok: false, reason: "LEASE_VOIDED" });
    expect(await usedCount(codeId)).toBe(0);
  });

  it("gives the use back when the waiver cannot be applied", async () => {
    const codeId = await seedCode({ code: "GIVEBACK1", maxUses: 1 });
    chargeWriteMode = "fail";
    const failed = await redeem("GIVEBACK1");
    expect(failed).toMatchObject({ ok: false });
    expect(feeChargeStatus()).toBe("pending");
    expect(await usedCount(codeId)).toBe(0);
    const left = await pg.query(`select 1 from public.application_fee_waiver_redemptions where code_id = $1`, [codeId]);
    expect(left.rows).toHaveLength(0);

    // The single use is still there for the next attempt.
    chargeWriteMode = null;
    expect(await redeem("GIVEBACK1")).toMatchObject({ ok: true });
    expect(await usedCount(codeId)).toBe(1);
  });
});

describe("one waiver per lease", () => {
  it("a fee the manager already waived spends no use and still succeeds", async () => {
    const codeId = await seedCode({ code: "AFTERMGR1", maxUses: 1 });
    await waiveLeaseFee(makeDb(), { managerUserId: MANAGER, leaseId: LEASE_ID, reason: "Referral" });
    const result = await redeem("AFTERMGR1");
    expect(result).toMatchObject({ ok: true, alreadyWaived: true, cancelledChargeIds: [] });
    expect(await usedCount(codeId)).toBe(0);
  });

  it("entering the code twice spends one use", async () => {
    const codeId = await seedCode({ code: "TWICE-001", maxUses: 3 });
    expect(await redeem("TWICE-001")).toMatchObject({ ok: true, alreadyWaived: false });
    expect(await redeem("TWICE-001")).toMatchObject({ ok: true, alreadyWaived: true });
    expect(await usedCount(codeId)).toBe(1);
  });

  it("after a manager restores the fee, the same lease cannot spend a second code", async () => {
    await seedCode({ code: "ONE-SHOT-1" });
    await seedCode({ code: "ONE-SHOT-2" });
    expect(await redeem("ONE-SHOT-1")).toMatchObject({ ok: true });
    // Restore the fee the way the manager's reinstate does: the cancelled, waived charge is owed again.
    const stored = tables.portal_household_charge_records!.find((r) => r.id === FEE_CHARGE)!;
    stored.status = "pending";
    const data = stored.row_data as Record<string, unknown>;
    data.status = "pending";
    delete data.waivedAt;
    delete (tables.portal_lease_pipeline_records![0]!.row_data as { application: Record<string, unknown> }).application
      .managerLeaseFeeWaiver;
    expect(await redeem("ONE-SHOT-2")).toMatchObject({ ok: false, status: 409, reason: "ALREADY_USED" });
    expect(feeChargeStatus()).toBe("pending");
  });
});

describe("the use cap holds across leases", () => {
  it("two residents racing for the last use: one is waived, the other still owes the fee", async () => {
    const codeId = await seedCode({ code: "LASTONE-1", maxUses: 1 });
    tables.portal_lease_pipeline_records!.push(
      leaseRow({
        id: "lease-2",
        resident_user_id: STRANGER,
        resident_email: "second@example.com",
        row_data: {
          id: "lease-2",
          axisId: "AXIS-APP-2",
          residentEmail: "second@example.com",
          residentName: "Second",
          propertyId: "prop-1",
          status: "Resident Signature Pending",
          bucket: "resident",
          application: { fullLegalName: "Second", leaseTerm: "Long-Term", leaseStart: "2026-11-01" },
        },
      }),
    );
    tables.portal_household_charge_records!.push(
      charge({
        id: "hc_app_app_second_lease_fee",
        applicationId: "AXIS-APP-2",
        residentEmail: "second@example.com",
        residentUserId: STRANGER,
      }),
    );
    const [a, b] = await Promise.all([
      redeem("LASTONE-1"),
      redeem("LASTONE-1", { residentUserId: STRANGER, residentEmail: "second@example.com", leaseId: "lease-2" }),
    ]);
    expect([a.ok, b.ok].filter(Boolean)).toHaveLength(1);
    expect(await usedCount(codeId)).toBe(1);
    const loser = a.ok ? b : a;
    expect(loser).toMatchObject({ ok: false, reason: "EXHAUSTED" });
    const waivedCount = tables.portal_household_charge_records!.filter(
      (r) => r.kind === "lease_fee" && r.status === "cancelled",
    ).length;
    expect(waivedCount).toBe(1);
  });
});

/**
 * The lease row's waiver is what the lease document and the billing snapshot read, and the charge
 * is what the resident owes. A half-applied waiver — stamped on the lease with the charge still
 * pending, or the reverse — is money being wrong, and the caller gives the code use back on any
 * failure, which only balances if nothing survived.
 */
describe("the lease stamp and the charge cancel are all-or-nothing", () => {
  it("rolls the cancelled charge back when the lease row cannot be stamped, and gives the use back", async () => {
    const codeId = await seedCode({ code: "HALFWAY-1", maxUses: 1 });
    failLeaseWrites = true;

    expect(await redeem("HALFWAY-1")).toMatchObject({ ok: false });

    expect(feeChargeStatus()).toBe("pending");
    const stored = tables.portal_household_charge_records!.find((r) => r.id === FEE_CHARGE)!;
    expect(stored.row_data).toMatchObject({ status: "pending" });
    expect((stored.row_data as Record<string, unknown>).waivedAt).toBeUndefined();
    const leaseData = tables.portal_lease_pipeline_records![0]!.row_data as {
      application: Record<string, unknown>;
    };
    expect(leaseData.application.managerLeaseFeeWaiver).toBeUndefined();
    expect(await usedCount(codeId)).toBe(0);
    const left = await pg.query(`select 1 from public.application_fee_waiver_redemptions where code_id = $1`, [codeId]);
    expect(left.rows).toHaveLength(0);
  });

  it("refuses with 409 instead of overwriting a charge that started clearing after the check", async () => {
    const codeId = await seedCode({ code: "RACED-001", maxUses: 1 });
    chargeWriteMode = "lost-race";

    expect(await redeem("RACED-001")).toMatchObject({ ok: false, status: 409, reason: "ALREADY_PAID" });

    const leaseData = tables.portal_lease_pipeline_records![0]!.row_data as {
      application: Record<string, unknown>;
    };
    expect(leaseData.application.managerLeaseFeeWaiver).toBeUndefined();
    expect(await usedCount(codeId)).toBe(0);
  });
});

/**
 * One lease may carry one code redemption (the partial unique index), so a reinstate that left the
 * row behind locked that lease out of every future code while the original code's use stayed spent.
 */
describe("reinstating the fee gives the code use back", () => {
  it("deletes the lease's redemption, restores used_count, and lets another code be redeemed", async () => {
    const first = await seedCode({ code: "UNDO-0001", maxUses: 1 });
    const second = await seedCode({ code: "UNDO-0002", maxUses: 1 });
    expect(await redeem("UNDO-0001")).toMatchObject({ ok: true });
    expect(await usedCount(first)).toBe(1);

    const reinstated = await reinstateLeaseFee(makeDb(), { managerUserId: MANAGER, leaseId: LEASE_ID });
    expect(reinstated).toMatchObject({ ok: true, reinstatedChargeIds: [FEE_CHARGE] });
    expect(feeChargeStatus()).toBe("pending");
    expect(await usedCount(first)).toBe(0);
    const left = await pg.query(`select 1 from public.application_fee_waiver_redemptions where lease_id = $1`, [LEASE_ID]);
    expect(left.rows).toHaveLength(0);

    expect(await redeem("UNDO-0002")).toMatchObject({ ok: true, alreadyWaived: false });
    expect(await usedCount(second)).toBe(1);
  });
});

/**
 * `reinstateLeaseFee` is the mirror of the waive and carries the same guarantee: the charge coming
 * back and the lease row dropping the waiver either both land or neither does. A lease that reads
 * "fee owed" against a charge still `cancelled` shows the resident a fee with nothing to pay.
 */
describe("reinstating is all-or-nothing too", () => {
  it("rolls the charge back to cancelled when the lease row cannot be cleared, and keeps the code spent", async () => {
    const codeId = await seedCode({ code: "UNDOFAIL1", maxUses: 1 });
    expect(await redeem("UNDOFAIL1")).toMatchObject({ ok: true });
    expect(feeChargeStatus()).toBe("cancelled");

    failLeaseWrites = true;
    const result = await reinstateLeaseFee(makeDb(), { managerUserId: MANAGER, leaseId: LEASE_ID });
    expect(result).toMatchObject({ ok: false, status: 500 });

    expect(feeChargeStatus()).toBe("cancelled");
    const stored = tables.portal_household_charge_records!.find((r) => r.id === FEE_CHARGE)!;
    expect(stored.row_data).toMatchObject({ status: "cancelled" });
    expect((stored.row_data as Record<string, unknown>).waivedAt).toBeTruthy();
    const leaseData = tables.portal_lease_pipeline_records![0]!.row_data as { application: Record<string, unknown> };
    expect(leaseData.application.managerLeaseFeeWaiver).toBeTruthy();
    // Nothing was undone, so the code use is still spent and the lease still holds its redemption.
    expect(await usedCount(codeId)).toBe(1);
    const left = await pg.query(`select 1 from public.application_fee_waiver_redemptions where lease_id = $1`, [LEASE_ID]);
    expect(left.rows).toHaveLength(1);

    // A retry once the write succeeds completes the reinstate.
    failLeaseWrites = false;
    expect(await reinstateLeaseFee(makeDb(), { managerUserId: MANAGER, leaseId: LEASE_ID })).toMatchObject({
      ok: true,
      reinstatedChargeIds: [FEE_CHARGE],
    });
    expect(feeChargeStatus()).toBe("pending");
    expect(await usedCount(codeId)).toBe(0);
  });

  it("never clears the lease row when the charge write fails — the money is written first", async () => {
    const codeId = await seedCode({ code: "MONEY1ST1", maxUses: 1 });
    expect(await redeem("MONEY1ST1")).toMatchObject({ ok: true });

    chargeWriteMode = "fail";
    const result = await reinstateLeaseFee(makeDb(), { managerUserId: MANAGER, leaseId: LEASE_ID });
    expect(result).toMatchObject({ ok: false, status: 500 });

    expect(feeChargeStatus()).toBe("cancelled");
    const leaseData = tables.portal_lease_pipeline_records![0]!.row_data as { application: Record<string, unknown> };
    expect(leaseData.application.managerLeaseFeeWaiver).toBeTruthy();
    expect(await usedCount(codeId)).toBe(1);
  });
});
