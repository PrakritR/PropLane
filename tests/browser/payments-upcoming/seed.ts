/**
 * Relative-dated charge fixture for one resident (Maya Chen, The Magnolia 2B),
 * shaped like the `GET /api/portal-household-charges` payload. Dates are
 * computed from "today" so the scenario never rots:
 *
 *   overdue    — late fee due 10 days ago              → Overdue tab, resident sees it
 *   dueSoon    — this month's utilities, due in 3 days → Pending (due now), resident sees it (≤ 7 days)
 *   nextRent   — next month's rent, due the 1st        → Pending → Upcoming group; resident does NOT see it (> 7 days)
 *   nextFee    — a service pass-through due the 1st of next month, residentVisibleAt stamped
 *                (the manager sent a manual reminder)   → Upcoming for the manager; resident DOES see it
 *   paid       — paid last month                        → Paid tab
 *
 * Kinds are chosen so none of the pending lines reads as an upfront move-in
 * charge (`isPendingUpfrontMoveInCharge`), which would collapse them into one
 * "Move-in total" row and is a different scenario.
 *
 * `APPLICATIONS` is part of the fixture, not decoration: the manager Payments
 * ledger drops any charge whose email has no application row at all
 * (`manager-payments-scope.ts` -> `isLinkedToDirectoryResident`, the orphaned-
 * resident backstop), so a seed of charges alone renders an empty list. Maya
 * is an approved, current resident of the same property the charges name, which
 * is also what keeps `reconcileApprovedResidentPaymentSchedules` from treating
 * her rows as leftovers. No listing is served to the fixture, so
 * `recordApprovedApplicationCharges` bails before generating anything and these
 * five charges stay the whole ledger.
 */
export const MANAGER_ID = "mgr-fixture";
export const PROPERTY_ID = "prop-magnolia";
export const RESIDENT_EMAIL = "maya@example.com";

/** The one resident the charges belong to, as `GET /api/manager-applications` returns her. */
export const APPLICATIONS = [
  {
    id: "app-fixture-maya",
    name: "Maya Chen",
    email: RESIDENT_EMAIL,
    property: "The Magnolia · 2B",
    propertyId: PROPERTY_ID,
    assignedPropertyId: PROPERTY_ID,
    managerUserId: MANAGER_ID,
    residentUserId: "res-maya",
    stage: "Current resident",
    bucket: "approved" as const,
    detail: "Approved · The Magnolia · 2B",
  },
];

function ymd(d: Date) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}
function label(d: Date) {
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

export function buildSeed(now = new Date()) {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const overdueDue = new Date(today); overdueDue.setDate(today.getDate() - 10);
  const dueSoon = new Date(today); dueSoon.setDate(today.getDate() + 3);
  const nextMonthFirst = new Date(today.getFullYear(), today.getMonth() + 1, 1);
  const nextMonthKey = ymd(nextMonthFirst);
  const nextMonthName = nextMonthFirst.toLocaleDateString("en-US", { month: "long" });
  const thisMonthName = today.toLocaleDateString("en-US", { month: "long" });
  const lastMonth = new Date(today.getFullYear(), today.getMonth() - 1, 1);
  const daysUntilNextRent = Math.round((nextMonthFirst.getTime() - today.getTime()) / 86_400_000);

  const base = {
    createdAt: new Date(today.getFullYear(), today.getMonth() - 2, 1).toISOString(),
    residentEmail: RESIDENT_EMAIL,
    residentName: "Maya Chen",
    residentUserId: "res-maya",
    propertyId: PROPERTY_ID,
    propertyLabel: "The Magnolia · 2B",
    managerUserId: MANAGER_ID,
    blocksLeaseUntilPaid: false,
    axisPaymentsEnabledSnapshot: false,
    acceptedPaymentMethodsSnapshot: ["check"],
  };

  const charges = [
    {
      ...base,
      id: "hc_fixture_overdue",
      kind: "late_fee",
      sourceChargeId: "hc_fixture_paid",
      title: "Late fee",
      amountLabel: "$50.00",
      balanceLabel: "$50.00",
      status: "pending",
      dueDateLabel: label(overdueDue),
    },
    {
      ...base,
      id: "hc_fixture_due_soon",
      kind: "utilities",
      title: `Utilities — ${thisMonthName}`,
      amountLabel: "$95.00",
      balanceLabel: "$95.00",
      status: "pending",
      rentMonth: ymd(today),
      dueDateLabel: label(dueSoon),
    },
    {
      ...base,
      id: "hc_fixture_next_rent",
      kind: "rent",
      title: `Rent — ${nextMonthName}`,
      amountLabel: "$1,850.00",
      balanceLabel: "$1,850.00",
      status: "pending",
      rentMonth: nextMonthKey,
      dueDay: 1,
    },
    {
      ...base,
      id: "hc_fixture_next_fee",
      kind: "work_order_charge",
      workOrderId: "wo-fixture-drain",
      title: `Drain repair (shared cost)`,
      amountLabel: "$75.00",
      balanceLabel: "$75.00",
      status: "pending",
      dueDateLabel: label(nextMonthFirst),
      residentVisibleAt: new Date(today.getTime() - 3_600_000).toISOString(),
    },
    {
      ...base,
      id: "hc_fixture_paid",
      kind: "rent",
      title: `Rent — ${lastMonth.toLocaleDateString("en-US", { month: "long" })}`,
      amountLabel: "$1,850.00",
      balanceLabel: "$0.00",
      status: "paid",
      paidAt: new Date(lastMonth.getFullYear(), lastMonth.getMonth(), 2).toISOString(),
      paidMethod: "check",
      rentMonth: ymd(lastMonth),
      dueDay: 1,
    },
  ];

  return {
    charges,
    applications: APPLICATIONS,
    rentProfiles: [],
    labels: {
      overdue: label(overdueDue),
      dueSoon: label(dueSoon),
      nextMonthFirst: label(nextMonthFirst),
      nextMonthName,
      thisMonthName,
      daysUntilNextRent,
    },
  };
}
