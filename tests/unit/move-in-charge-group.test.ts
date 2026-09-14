// One move-in payment: the resident pays ONE total; the ledger keeps every line.
import { describe, expect, it } from "vitest";
import type { HouseholdCharge } from "@/lib/household-charges";
import {
  buildMoveInChargeGroups,
  isMoveInGroupId,
  isMoveInScheduleCharge,
  moveInGroupAsListRow,
  moveInSubtotalForLedgerRows,
} from "@/lib/move-in-charge-group";

const NOW = new Date(2026, 8, 14);

function charge(over: Partial<HouseholdCharge> & { id: string; kind: HouseholdCharge["kind"] }): HouseholdCharge {
  const amount = over.amountLabel ?? "$100.00";
  return {
    createdAt: "2026-09-01T00:00:00.000Z",
    residentEmail: "maya@example.com",
    residentName: "Maya Chen",
    residentUserId: "res-maya",
    propertyId: "prop-8th",
    propertyLabel: "4709A 8th Ave NE",
    managerUserId: "mgr-1",
    title: over.kind,
    amountLabel: amount,
    balanceLabel: amount,
    status: "pending",
    blocksLeaseUntilPaid: false,
    ...over,
  };
}

const MOVE_IN: HouseholdCharge[] = [
  charge({ id: "rent1", kind: "first_month_rent", title: "First month's rent", amountLabel: "$1,100.00", dueDateLabel: "Oct 1, 2026" }),
  charge({ id: "dep", kind: "security_deposit", title: "Security deposit ($300.00 holding deposit credited)", amountLabel: "$800.00", blocksLeaseUntilPaid: true }),
  charge({ id: "fee", kind: "move_in_fee", title: "Move-in cost", amountLabel: "$250.00" }),
  charge({ id: "clean", kind: "other_cost", title: "Cleaning", amountLabel: "$150.00", customFeeId: "cf-clean" }),
];

describe("isMoveInScheduleCharge", () => {
  it("takes the lines a signature bills up front and nothing that recurs, passes through, or a prospect owes", () => {
    for (const c of MOVE_IN) expect(isMoveInScheduleCharge(c)).toBe(true);
    expect(isMoveInScheduleCharge(charge({ id: "sign", kind: "payment_at_signing" }))).toBe(true);
    expect(isMoveInScheduleCharge(charge({ id: "u0", kind: "utilities" }))).toBe(true);
    expect(isMoveInScheduleCharge(charge({ id: "r", kind: "rent", recurringRentProfileId: "rp", rentMonth: "2026-11" }))).toBe(false);
    expect(isMoveInScheduleCharge(charge({ id: "u", kind: "utilities", rentMonth: "2026-11" }))).toBe(false);
    expect(isMoveInScheduleCharge(charge({ id: "app", kind: "application_fee" }))).toBe(false);
    expect(isMoveInScheduleCharge(charge({ id: "hold", kind: "holding_deposit" }))).toBe(false);
    expect(isMoveInScheduleCharge(charge({ id: "wo", kind: "work_order_charge", workOrderId: "wo-1" }))).toBe(false);
    expect(isMoveInScheduleCharge(charge({ id: "late", kind: "late_fee", sourceChargeId: "rent1" }))).toBe(false);
    expect(isMoveInScheduleCharge(charge({ id: "paid", kind: "security_deposit", status: "paid" }))).toBe(false);
    expect(isMoveInScheduleCharge(charge({ id: "canc", kind: "move_in_fee", status: "cancelled" }))).toBe(false);
  });
});

describe("buildMoveInChargeGroups", () => {
  it("collapses one resident's move-in into one total whose lines are all still there", () => {
    const groups = buildMoveInChargeGroups(MOVE_IN, NOW);
    expect(groups).toHaveLength(1);
    const [group] = groups;
    expect(isMoveInGroupId(group.id)).toBe(true);
    expect(group.items.map((c) => c.id).sort()).toEqual(["clean", "dep", "fee", "rent1"]);
    // 1,100 + 800 (deposit already net of the $300 holding credit) + 250 + 150
    expect(group.totalCents).toBe(230_000);
    expect(group.totalLabel).toBe("$2,300.00");
    expect(group.blocksLeaseUntilPaid).toBe(true);
    expect(group.overdue).toBe(false);
  });

  it("a paid holding deposit brings the total DOWN through the deposit line, never as a negative row", () => {
    const withCredit = buildMoveInChargeGroups(MOVE_IN, NOW)[0];
    const noCredit = buildMoveInChargeGroups(
      MOVE_IN.map((c) => (c.id === "dep" ? { ...c, amountLabel: "$1,100.00", balanceLabel: "$1,100.00", title: "Security deposit" } : c)),
      NOW,
    )[0];
    expect(noCredit.totalCents - withCredit.totalCents).toBe(30_000);
    expect(withCredit.items.every((c) => !c.balanceLabel.startsWith("-"))).toBe(true);
  });

  it("needs two lines — a lone deposit is just a deposit", () => {
    expect(buildMoveInChargeGroups([MOVE_IN[1]], NOW)).toHaveLength(0);
  });

  it("keeps a recurring month and a late fee out of the total, and groups per home", () => {
    const charges = [
      ...MOVE_IN,
      charge({ id: "nov", kind: "rent", title: "November rent", amountLabel: "$1,100.00", recurringRentProfileId: "rp", rentMonth: "2026-11" }),
      charge({ id: "late", kind: "late_fee", amountLabel: "$50.00", sourceChargeId: "rent1" }),
      charge({ id: "b-rent", kind: "first_month_rent", amountLabel: "$900.00", propertyId: "prop-b", propertyLabel: "Brooklyn" }),
      charge({ id: "b-dep", kind: "security_deposit", amountLabel: "$900.00", propertyId: "prop-b", propertyLabel: "Brooklyn" }),
    ];
    const groups = buildMoveInChargeGroups(charges, NOW);
    expect(groups.map((g) => [g.propertyId, g.totalLabel]).sort()).toEqual([
      ["prop-8th", "$2,300.00"],
      ["prop-b", "$1,800.00"],
    ]);
    expect(groups.flatMap((g) => g.items.map((c) => c.id))).not.toContain("nov");
    expect(groups.flatMap((g) => g.items.map((c) => c.id))).not.toContain("late");
  });

  it("is overdue when any line is, and due by the soonest dated line", () => {
    const charges = MOVE_IN.map((c) => (c.id === "rent1" ? { ...c, dueDateLabel: "Sep 1, 2026" } : c));
    const [group] = buildMoveInChargeGroups(charges, NOW);
    expect(group.overdue).toBe(true);
    expect(group.dueLabel).toBe("Sep 1, 2026");
    expect(group.items[0].id).toBe("rent1");
  });

  it("renders as a row carrying the total and never a real charge's id", () => {
    const [group] = buildMoveInChargeGroups(MOVE_IN, NOW);
    const row = moveInGroupAsListRow(group);
    expect(row.title).toBe("Move-in total");
    expect(row.balanceLabel).toBe("$2,300.00");
    expect(row.status).toBe("pending");
    expect(MOVE_IN.some((c) => c.id === row.id)).toBe(false);
  });

  it("a group whose every line is a clearing bank transfer reads as processing", () => {
    const [group] = buildMoveInChargeGroups(MOVE_IN.map((c) => ({ ...c, status: "processing" as const })), NOW);
    expect(group.allProcessing).toBe(true);
    expect(moveInGroupAsListRow(group).status).toBe("processing");
  });
});

describe("moveInSubtotalForLedgerRows — the manager's side of the same total", () => {
  it("sums the still-owed move-in lines and ignores paid ones and recurring rent", () => {
    const subtotal = moveInSubtotalForLedgerRows([
      { moveInSchedule: true, bucket: "pending", balanceDue: "$1,100.00" },
      { moveInSchedule: true, bucket: "pending", balanceDue: "$800.00" },
      { moveInSchedule: true, bucket: "paid", balanceDue: "$0.00" },
      { moveInSchedule: false, bucket: "pending", balanceDue: "$1,100.00" },
    ]);
    expect(subtotal).toEqual({ count: 2, totalCents: 190_000, totalLabel: "$1,900.00" });
  });

  it("is nothing below two lines", () => {
    expect(moveInSubtotalForLedgerRows([{ moveInSchedule: true, bucket: "pending", balanceDue: "$800.00" }])).toBeNull();
  });
});
