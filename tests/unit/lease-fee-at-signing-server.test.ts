/**
 * MONEY (server half): the lease route refuses a resident's signature until every at-signing charge is
 * PAID - paid is written by the Stripe webhook, never by the request - and a manager can waive the lease
 * fee for one lease (audited, refused once paid, reversible).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fakeSupabaseClient, type Row } from "./helpers/fake-supabase-tables";

vi.mock("@/lib/household-charge-payment-eligibility.server", () => ({
  // The property takes PropLane payments and the payout account is ready.
  enrichHouseholdChargesFromPropertyRecords: async (_db: unknown, charges: Array<Record<string, unknown>>) =>
    charges.map((c) => ({ ...c, axisPaymentsEnabledSnapshot: payable.on, managerStripeConnectReadySnapshot: true })),
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

const payable = vi.hoisted(() => ({ on: true }));

import { checkResidentAtSigningGate } from "@/lib/lease-at-signing.server";
import { listLeaseFeeWaivers, reinstateLeaseFee, waiveLeaseFee } from "@/lib/lease-fee-waiver.server";

const MANAGER = "11111111-1111-4111-8111-111111111111";
const RESIDENT = "22222222-2222-4222-8222-222222222222";
const EMAIL = "signer@example.com";
const LEASE_ID = "lease-1";

function charge(over: Record<string, unknown>): Row {
  const data = {
    id: "hc_app_app_signer_lease_fee",
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

let tables: Record<string, Row[]>;

beforeEach(() => {
  payable.on = true;
  tables = {
    portal_household_charge_records: [
      charge({}),
      charge({ id: "hc_app_app_signer_security_deposit", kind: "security_deposit", title: "Security deposit", amountLabel: "$500.00", balanceLabel: "$500.00" }),
    ],
    portal_lease_pipeline_records: [
      {
        id: LEASE_ID,
        manager_user_id: MANAGER,
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
      },
    ],
    audit_log: [],
  };
});

const lease = { axisId: "AXIS-APP-1", residentEmail: EMAIL, propertyId: "prop-1" };

describe("the signing gate reads the server's charges", () => {
  it("blocks while any at-signing line is unpaid, and reports the exact sum", async () => {
    const gate = await checkResidentAtSigningGate(fakeSupabaseClient(tables) as never, {
      lease,
      residentUserId: RESIDENT,
      residentEmail: EMAIL,
    });
    expect(gate.ok).toBe(true);
    if (!gate.ok) return;
    expect(gate.unpaid.map((c) => c.kind).sort()).toEqual(["lease_fee", "security_deposit"]);
    expect(gate.unpaidCents).toBe(80_000);
  });

  it("allows signing once the webhook has marked every line paid", async () => {
    for (const row of tables.portal_household_charge_records!) {
      row.status = "paid";
      row.row_data = { ...(row.row_data as object), status: "paid", balanceLabel: "$0.00" };
    }
    const gate = await checkResidentAtSigningGate(fakeSupabaseClient(tables) as never, {
      lease,
      residentUserId: RESIDENT,
      residentEmail: EMAIL,
    });
    expect(gate).toMatchObject({ ok: true, unpaidCents: 0 });
    expect(gate.ok && gate.unpaid).toEqual([]);
  });

  it("a half-paid set still blocks, and a clearing bank transfer is not paid", async () => {
    tables.portal_household_charge_records![0]!.status = "paid";
    tables.portal_household_charge_records![1]!.status = "processing";
    const gate = await checkResidentAtSigningGate(fakeSupabaseClient(tables) as never, {
      lease,
      residentUserId: RESIDENT,
      residentEmail: EMAIL,
    });
    expect(gate.ok && gate.unpaid.map((c) => c.kind)).toEqual(["security_deposit"]);
  });

  it("does not trap a resident whose manager collects offline", async () => {
    payable.on = false;
    const gate = await checkResidentAtSigningGate(fakeSupabaseClient(tables) as never, {
      lease,
      residentUserId: RESIDENT,
      residentEmail: EMAIL,
    });
    expect(gate.ok && gate.unpaid).toEqual([]);
  });

  it("only the signer's own lines gate them, and only for this lease", async () => {
    tables.portal_household_charge_records!.push(
      charge({ id: "other-person", residentUserId: "99999999-9999-4999-8999-999999999999", residentEmail: "other@example.com" }),
      charge({ id: "other-lease", applicationId: "AXIS-APP-2", propertyId: "prop-2" }),
    );
    const gate = await checkResidentAtSigningGate(fakeSupabaseClient(tables) as never, {
      lease,
      residentUserId: RESIDENT,
      residentEmail: EMAIL,
    });
    expect(gate.ok && gate.unpaid.map((c) => c.id).sort()).toEqual([
      "hc_app_app_signer_lease_fee",
      "hc_app_app_signer_security_deposit",
    ]);
  });

  it("a post-signing line (no dueAtSigning stamp) never gates the signature", async () => {
    tables.portal_household_charge_records = [charge({ id: "rent", kind: "first_month_rent", dueAtSigning: undefined })];
    const gate = await checkResidentAtSigningGate(fakeSupabaseClient(tables) as never, {
      lease,
      residentUserId: RESIDENT,
      residentEmail: EMAIL,
    });
    expect(gate.ok && gate.unpaid).toEqual([]);
  });
});

describe("waiving the lease fee", () => {
  it("cancels the unpaid lease_fee charge, stamps who/when/why, and drops it from the gate", async () => {
    const db = fakeSupabaseClient(tables) as never;
    const result = await waiveLeaseFee(db, { managerUserId: MANAGER, leaseId: LEASE_ID, reason: "Referral" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.cancelledChargeIds).toEqual(["hc_app_app_signer_lease_fee"]);

    const stored = tables.portal_household_charge_records!.find((r) => r.id === "hc_app_app_signer_lease_fee")!;
    expect(stored.status).toBe("cancelled");
    expect(stored.row_data).toMatchObject({
      status: "cancelled",
      waivedByUserId: MANAGER,
      waiverReason: "Referral",
    });
    // The lease row carries the waiver for the document and the billing snapshot.
    const leaseRow = tables.portal_lease_pipeline_records![0]!.row_data as { application: { managerLeaseFeeWaiver?: { reason: string } } };
    expect(leaseRow.application.managerLeaseFeeWaiver?.reason).toBe("Referral");
    expect(tables.audit_log).toHaveLength(1);
    expect(tables.audit_log![0]).toMatchObject({ action: "lease_fee_waived", actor_user_id: MANAGER });

    const gate = await checkResidentAtSigningGate(db, { lease, residentUserId: RESIDENT, residentEmail: EMAIL });
    expect(gate.ok && gate.unpaid.map((c) => c.kind)).toEqual(["security_deposit"]);
    expect(gate.ok && gate.unpaidCents).toBe(50_000);
  });

  it("is idempotent", async () => {
    const db = fakeSupabaseClient(tables) as never;
    await waiveLeaseFee(db, { managerUserId: MANAGER, leaseId: LEASE_ID, reason: "First" });
    const again = await waiveLeaseFee(db, { managerUserId: MANAGER, leaseId: LEASE_ID, reason: "Second" });
    expect(again.ok && again.cancelledChargeIds).toEqual([]);
    const leaseRow = tables.portal_lease_pipeline_records![0]!.row_data as { application: { managerLeaseFeeWaiver?: { reason: string } } };
    expect(leaseRow.application.managerLeaseFeeWaiver?.reason).toBe("First");
  });

  it("refuses once the fee was paid (that is a refund), and never touches another manager's lease", async () => {
    const db = fakeSupabaseClient(tables) as never;
    tables.portal_household_charge_records![0]!.status = "paid";
    const paid = await waiveLeaseFee(db, { managerUserId: MANAGER, leaseId: LEASE_ID });
    expect(paid).toMatchObject({ ok: false, status: 409 });

    tables.portal_household_charge_records![0]!.status = "pending";
    const stranger = await waiveLeaseFee(db, { managerUserId: "33333333-3333-4333-8333-333333333333", leaseId: LEASE_ID });
    expect(stranger).toMatchObject({ ok: false, status: 404 });
    expect(tables.portal_household_charge_records![0]!.status).toBe("pending");
  });

  it("can be reversed: the fee is owed again for its original amount", async () => {
    const db = fakeSupabaseClient(tables) as never;
    await waiveLeaseFee(db, { managerUserId: MANAGER, leaseId: LEASE_ID, reason: "Referral" });
    expect((await listLeaseFeeWaivers(db, MANAGER)).map((w) => w.leaseId)).toEqual([LEASE_ID]);
    const result = await reinstateLeaseFee(db, { managerUserId: MANAGER, leaseId: LEASE_ID });
    expect(result.ok && result.reinstatedChargeIds).toEqual(["hc_app_app_signer_lease_fee"]);
    const stored = tables.portal_household_charge_records!.find((r) => r.id === "hc_app_app_signer_lease_fee")!;
    expect(stored.status).toBe("pending");
    expect(stored.row_data).toMatchObject({ status: "pending", balanceLabel: "$300.00" });
    expect((stored.row_data as Record<string, unknown>).waivedAt).toBeUndefined();
    expect(await listLeaseFeeWaivers(db, MANAGER)).toEqual([]);
  });
});
