import { describe, expect, it } from "vitest";
import type { DemoApplicantRow } from "@/data/demo-portal";
import type { HouseholdCharge } from "@/lib/household-charges";
import { householdChargeManagerBucket, householdChargeToLedgerRow } from "@/lib/household-charges";
import {
  managerPaymentBucketCounts,
  scopeChargesToManagerPaymentsLedger,
  shouldExcludePaymentAccount,
  unpaidManagerPaymentCharges,
} from "@/lib/manager-payments-scope";

/**
 * F-PAY-1: the dashboard "Payments" group advertised "View all 85 →" against a
 * Payments page listing 64, and "80 pending" against a Pending tab reading 58,
 * because Payments narrowed the charge list by two rules the dashboard never
 * applied. Both surfaces now scope through `manager-payments-scope`.
 */

function charge(over: Partial<HouseholdCharge> & Pick<HouseholdCharge, "id">): HouseholdCharge {
  return {
    createdAt: "2026-01-01T00:00:00.000Z",
    residentEmail: "resident@example.com",
    residentName: "Resident Example",
    residentUserId: null,
    propertyId: "prop-1",
    propertyLabel: "Prop One",
    managerUserId: "mgr-1",
    kind: "rent",
    title: "Rent",
    amountLabel: "$100.00",
    balanceLabel: "$100.00",
    status: "pending",
    blocksLeaseUntilPaid: false,
    ...over,
  } as HouseholdCharge;
}

function application(over: Partial<DemoApplicantRow> & Pick<DemoApplicantRow, "id">): DemoApplicantRow {
  return {
    name: "Resident Example",
    property: "Prop One",
    stage: "Approved",
    bucket: "approved",
    backgroundCheckStatus: "pending_review",
    detail: "",
    email: "resident@example.com",
    ...over,
  } as DemoApplicantRow;
}

describe("manager payments scope (F-PAY-1)", () => {
  it("drops the internal payer account by EXACT match, never by substring", () => {
    expect(shouldExcludePaymentAccount("Sharad Ramachandran", "x@y.com")).toBe(true);
    expect(shouldExcludePaymentAccount("  sharad  ", "")).toBe(true);
    expect(shouldExcludePaymentAccount("Maya Chen", "maya@y.com")).toBe(false);
  });

  it("never swallows a real resident whose name or email merely CONTAINS the token", () => {
    // The substring rule this replaced hid every charge for any of these, on
    // every manager's dashboard and Payments page, with nothing on screen.
    expect(shouldExcludePaymentAccount("Sharada Iyer", "sharada@example.com")).toBe(false);
    expect(shouldExcludePaymentAccount("Priya Sharma", "sharad.k@example.com")).toBe(false);
    expect(shouldExcludePaymentAccount("Bob", "notsharad@example.com")).toBe(false);
    expect(shouldExcludePaymentAccount("Sharad Ramachandran Jr", "")).toBe(false);
  });

  it("drops charges only for a resident who has MOVED OUT", () => {
    const charges = [
      charge({ id: "current" }),
      charge({ id: "movedOut", residentEmail: "gone@example.com" }),
    ];
    const apps = [
      application({ id: "a1" }),
      application({ id: "a2", email: "gone@example.com", stage: "Moved out" }),
    ];
    const scoped = scopeChargesToManagerPaymentsLedger(charges, apps);
    expect(scoped.map((c) => c.id)).toEqual(["current"]);
  });

  it("keeps every charge for a current resident who ALSO holds another application", () => {
    // The old rule keyed on "not a current-resident row", which is true of a
    // pending row too — so a housed resident who applied somewhere else had all
    // their charges vanish from both money surfaces. One audited account held 19
    // pending applications, so this was the common case, not the edge.
    const charges = [charge({ id: "rent" }), charge({ id: "utilities", kind: "utilities" })];
    const apps = [
      application({ id: "a1" }),
      application({ id: "a2", bucket: "pending", stage: "Submitted" }),
    ];
    const scoped = scopeChargesToManagerPaymentsLedger(charges, apps);
    expect(scoped.map((c) => c.id)).toEqual(["rent", "utilities"]);
  });

  it("keeps a pending applicant's application fee — that is money genuinely owed", () => {
    const charges = [
      charge({ id: "fee", kind: "application_fee", residentEmail: "applicant@example.com" }),
    ];
    const apps = [
      application({ id: "a1", email: "applicant@example.com", bucket: "pending", stage: "Submitted" }),
    ];
    expect(scopeChargesToManagerPaymentsLedger(charges, apps).map((c) => c.id)).toEqual(["fee"]);
  });

  it("keeps charges for a rejected or withdrawn applicant, who never moved out", () => {
    const charges = [charge({ id: "fee", residentEmail: "rejected@example.com" })];
    const apps = [
      application({ id: "a1", email: "rejected@example.com", bucket: "rejected", stage: "Rejected" }),
    ];
    expect(scopeChargesToManagerPaymentsLedger(charges, apps).map((c) => c.id)).toEqual(["fee"]);
  });

  it("keeps a manager-entered one-off after the payer moves out", () => {
    const charges = [
      charge({ id: "hc_mgr_one_off", residentEmail: "gone@example.com", kind: "other_cost" }),
    ];
    const apps = [application({ id: "a2", email: "gone@example.com", stage: "Moved out" })];
    expect(scopeChargesToManagerPaymentsLedger(charges, apps).map((c) => c.id)).toEqual(["hc_mgr_one_off"]);
  });

  // N080: a charge naming an email with NO application row at all — the
  // manager fully deleted that resident, or a bug left the row behind — is
  // orphaned and must not render, unlike the "moved out" and
  // "rejected/withdrawn" cases above, which still have a real application row.
  it("drops a charge for an email with no application row anywhere (N080 orphan)", () => {
    const charges = [
      charge({ id: "kept", residentEmail: "current@example.com" }),
      charge({ id: "orphaned", residentEmail: "deleted@example.com" }),
    ];
    const apps = [application({ id: "a1", email: "current@example.com" })];
    expect(scopeChargesToManagerPaymentsLedger(charges, apps).map((c) => c.id)).toEqual(["kept"]);
  });

  it("still keeps a manager-entered one-off for a fully deleted resident", () => {
    const charges = [
      charge({ id: "hc_mgr_one_off", residentEmail: "deleted@example.com", kind: "other_cost" }),
    ];
    expect(scopeChargesToManagerPaymentsLedger(charges, []).map((c) => c.id)).toEqual(["hc_mgr_one_off"]);
  });

  it("the dashboard's unpaid count equals the Payments Pending + Overdue tabs", () => {
    const charges = [
      charge({ id: "pending", dueDateLabel: "2099-01-01" }),
      charge({ id: "overdue", dueDateLabel: "2020-01-01" }),
      charge({ id: "clearing", status: "processing", dueDateLabel: "2020-01-01" }),
      charge({ id: "paid", status: "paid", paidAt: "2026-02-01", balanceLabel: "$0.00" }),
      // Excluded from BOTH surfaces by the shared scope.
      charge({ id: "internal", residentName: "Sharad Ramachandran" }),
    ];
    const scoped = scopeChargesToManagerPaymentsLedger(charges, [application({ id: "a1" })]);
    const counts = managerPaymentBucketCounts(scoped);

    // What the Payments tabs render, derived independently through the ledger row.
    const tabCounts = { pending: 0, overdue: 0, paid: 0 };
    for (const c of scoped) tabCounts[householdChargeToLedgerRow(c).bucket] += 1;

    expect(counts).toEqual(tabCounts);
    // The dashboard group: total = Pending + Overdue, never Paid.
    expect(unpaidManagerPaymentCharges(scoped)).toHaveLength(counts.pending + counts.overdue);
    expect(scoped.map((c) => c.id)).not.toContain("internal");
  });

  it("buckets a clearing ACH charge as Pending on both surfaces, never Overdue", () => {
    const clearing = charge({ id: "clearing", status: "processing", dueDateLabel: "2020-01-01" });
    expect(householdChargeManagerBucket(clearing)).toBe("pending");
    expect(householdChargeToLedgerRow(clearing).bucket).toBe("pending");
    // It used to be invisible to the dashboard, which filtered on status === "pending".
    expect(unpaidManagerPaymentCharges([clearing])).toHaveLength(1);
  });

  it("never counts a cancelled or refunded charge as money still owed", () => {
    const cancelled = charge({ id: "cancelled", status: "cancelled", dueDateLabel: "2020-01-01" });
    const refunded = charge({ id: "refunded", status: "refunded", dueDateLabel: "2020-01-01" });

    for (const settled of [cancelled, refunded]) {
      expect(householdChargeManagerBucket(settled)).toBe("paid");
      const row = householdChargeToLedgerRow(settled);
      // Payments' own "is this actionable" reads: statusLabel !== "Paid" AND a
      // non-zero balance would put the row back in the chase list.
      expect(row.balanceDue).toBe("$0.00");
    }
    expect(householdChargeToLedgerRow(cancelled).statusLabel).toBe("Cancelled");
    expect(householdChargeToLedgerRow(refunded).statusLabel).toBe("Refunded");
    expect(unpaidManagerPaymentCharges([cancelled, refunded])).toEqual([]);
    expect(managerPaymentBucketCounts([cancelled, refunded])).toEqual({
      pending: 0,
      overdue: 0,
      paid: 2,
    });
  });

  it("keeps a failed payment attempt owed — the charge did not go away", () => {
    const failed = charge({ id: "failed", status: "failed", dueDateLabel: "2099-01-01" });
    expect(householdChargeManagerBucket(failed)).toBe("pending");
    expect(unpaidManagerPaymentCharges([failed])).toHaveLength(1);
  });

  it("the ledger row agrees with the bucket helper for every charge status", () => {
    const statuses: HouseholdCharge["status"][] = [
      "pending",
      "processing",
      "partially_paid",
      "paid",
      "cancelled",
      "refunded",
      "failed",
    ];
    for (const status of statuses) {
      for (const dueDateLabel of ["2020-01-01", "2099-01-01"]) {
        const c = charge({ id: `${status}-${dueDateLabel}`, status, dueDateLabel });
        const bucket = householdChargeManagerBucket(c);
        const row = householdChargeToLedgerRow(c);
        expect(row.bucket).toBe(bucket);
        expect(row.balanceDue === "$0.00").toBe(bucket === "paid");
        expect(unpaidManagerPaymentCharges([c])).toHaveLength(bucket === "paid" ? 0 : 1);
      }
    }
  });
});
