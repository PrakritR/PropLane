import { describe, expect, it } from "vitest";
import type { HouseholdCharge } from "@/lib/household-charges";
import type { LeasePipelineRow } from "@/lib/lease-pipeline-storage";
import {
  groupResidentEditCharges,
  residentEditAmountLabel,
  residentEditChargesFromHousehold,
  residentEditDepositLine,
  residentEditNewUnpaidRentCents,
  residentEditPaidOfLine,
  residentEditSignersFromLease,
  type ResidentEditCharge,
} from "@/lib/resident-edit-record";
import { diffResidentEdit, type ResidentEditBaseline } from "@/lib/resident-edit-stage";

function charge(over: Partial<ResidentEditCharge> & Pick<ResidentEditCharge, "id" | "bucket">): ResidentEditCharge {
  return {
    title: "Rent",
    kind: "rent",
    status: over.bucket === "paid" ? "paid" : "pending",
    dueLabel: "Oct 1",
    dueMs: null,
    paidAtIso: null,
    amountCents: 97500,
    ...over,
  };
}

const rows: ResidentEditCharge[] = [
  charge({ id: "dep", bucket: "paid", kind: "security_deposit", title: "Security deposit", amountCents: 25000, paidAtIso: "2026-08-25T00:00:00Z" }),
  charge({ id: "sep", bucket: "paid", title: "September rent", paidAtIso: "2026-09-02T00:00:00Z" }),
  charge({ id: "oct", bucket: "pending", title: "October rent" }),
  charge({ id: "nov", bucket: "pending", title: "November rent", dueLabel: "Nov 1" }),
  charge({ id: "late", bucket: "overdue", title: "August rent", status: "late" }),
];

describe("resident edit record: Payments (C2-ER5 / ER8)", () => {
  it("groups the real charges Overdue, Pending, Paid", () => {
    const groups = groupResidentEditCharges(rows);
    expect(groups.overdue.map((c) => c.id)).toEqual(["late"]);
    expect(groups.pending.map((c) => c.id)).toEqual(["oct", "nov"]);
    // newest receipt first
    expect(groups.paid.map((c) => c.id)).toEqual(["sep", "dep"]);
  });

  it("says how much is paid of the total, leaving cancelled and refunded out", () => {
    expect(residentEditPaidOfLine(rows)).toBe("$1,225 paid of $4,150");
    expect(
      residentEditPaidOfLine([...rows, charge({ id: "x", bucket: "paid", status: "cancelled", amountCents: 99900 })]),
    ).toBe("$1,225 paid of $4,150");
    expect(residentEditPaidOfLine([])).toBeNull();
  });

  const baseline = { rent: "975" } as ResidentEditBaseline;
  const form = (rent: string) =>
    ({ ...baseline, rent, application: {} }) as Parameters<typeof diffResidentEdit>[1];

  it("shows old → new on unpaid rent only for a resident added by hand whose rent changed", () => {
    const diff = diffResidentEdit(baseline, form("1050"));
    const unpaidRent = rows.find((c) => c.id === "oct")!;
    const newCents = residentEditNewUnpaidRentCents({ stage: "by_hand", diff, rent: "1050", charge: unpaidRent });
    expect(newCents).toBe(105000);
    expect(residentEditAmountLabel(unpaidRent, newCents)).toBe("$975 → $1,050");
  });

  it("keeps paid charges, deposits and every other stage exactly as stored", () => {
    const diff = diffResidentEdit(baseline, form("1050"));
    const paidRent = rows.find((c) => c.id === "sep")!;
    const deposit = rows.find((c) => c.id === "dep")!;
    const unpaidRent = rows.find((c) => c.id === "oct")!;
    expect(residentEditNewUnpaidRentCents({ stage: "by_hand", diff, rent: "1050", charge: paidRent })).toBeNull();
    expect(residentEditNewUnpaidRentCents({ stage: "by_hand", diff, rent: "1050", charge: deposit })).toBeNull();
    for (const stage of ["signed", "lease_draft", "lease_sent", "applicant", "moved_out"] as const) {
      expect(residentEditNewUnpaidRentCents({ stage, diff, rent: "1050", charge: unpaidRent })).toBeNull();
    }
    // no rent change, no old → new
    const same = diffResidentEdit(baseline, form("975"));
    expect(residentEditNewUnpaidRentCents({ stage: "by_hand", diff: same, rent: "975", charge: unpaidRent })).toBeNull();
    expect(residentEditAmountLabel(unpaidRent, null)).toBe("$975");
  });

  it("groups the deposit under Billing as paid or due", () => {
    const fmt = (iso: string) => iso.slice(0, 10);
    expect(residentEditDepositLine(rows, fmt)).toEqual({ text: "Security deposit $250 paid 2026-08-25", paid: true });
    expect(
      residentEditDepositLine([charge({ id: "d", bucket: "pending", kind: "security_deposit", amountCents: 25000, dueLabel: "Before move-in" })], fmt),
    ).toEqual({ text: "Security deposit $250 due Before move-in", paid: false });
    expect(residentEditDepositLine([], fmt)).toEqual({ text: "No security deposit charged", paid: false });
  });

  it("reads the stored charges: paid stays paid, an unpaid one is pending or overdue by its date", () => {
    const base = {
      id: "c",
      createdAt: "2026-01-01T00:00:00Z",
      residentEmail: "a@b.co",
      residentName: "A",
      residentUserId: null,
      propertyId: "p",
      propertyLabel: "P",
      managerUserId: "m",
      kind: "other_cost",
      title: "Parking",
      amountLabel: "$1,050.50",
      balanceLabel: "$1,050.50",
      blocksLeaseUntilPaid: false,
    } as const;
    const converted = residentEditChargesFromHousehold([
      { ...base, id: "paid", status: "paid", balanceLabel: "$0.00", paidAt: "2026-09-01T10:00:00Z" } as HouseholdCharge,
      { ...base, id: "old", status: "pending", dueDateLabel: "Jan 5, 2020" } as HouseholdCharge,
    ]);
    const byId = new Map(converted.map((c) => [c.id, c]));
    expect(byId.get("paid")).toMatchObject({ bucket: "paid", amountCents: 105050, paidAtIso: "2026-09-01T10:00:00Z" });
    expect(byId.get("old")?.bucket).toBe("overdue");
  });
});

describe("resident edit record: lease signers (C2-ER8)", () => {
  const lease = {
    id: "l1",
    residentName: "Harper Quinn",
    bucket: "resident",
    status: "Resident Signature Pending",
    sentToResidentAt: "2026-09-24T12:00:00Z",
    updatedAtIso: "2026-09-24T12:00:00Z",
    residentSignature: null,
    managerSignature: null,
  } as unknown as LeasePipelineRow;

  it("lists the tenant then the manager, waiting while the lease is out for signature", () => {
    const signers = residentEditSignersFromLease(lease, "lease_sent");
    expect(signers.map((s) => [s.name, s.role, s.signedAtIso, s.waitText])).toEqual([
      ["Harper Quinn", "Tenant", null, "Waiting"],
      ["Manager", "Manager", null, "Signs after the tenant"],
    ]);
  });

  it("shows a signature date once signed, and nothing for a resident added by hand", () => {
    const signed = {
      ...lease,
      status: "Fully Signed",
      bucket: "signed",
      residentSignedAt: "2026-09-26T09:00:00Z",
      residentSignature: { name: "Harper Quinn", signedAtIso: "2026-09-26T09:00:00Z", role: "resident" },
      managerSignature: { name: "Prakrit", signedAtIso: "2026-09-27T09:00:00Z", role: "manager" },
    } as unknown as LeasePipelineRow;
    expect(residentEditSignersFromLease(signed, "signed").every((s) => s.signedAtIso)).toBe(true);
    expect(residentEditSignersFromLease(signed, "by_hand")).toEqual([]);
    expect(residentEditSignersFromLease(null, "signed")).toEqual([]);
  });
});
