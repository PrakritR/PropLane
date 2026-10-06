/**
 * Charge fixture for the CENTRAL PAYMENTS browser proof: the same resident the
 * payments-upcoming fixture uses, but with `axisPaymentsEnabledSnapshot: true`
 * so every pending line is PropLane-payable. That flag is exactly what
 * `householdChargeProplanePayability` reads, and it is what turns the resident
 * list from a read-only ledger into the pay surface this change rebuilt: a
 * per-charge Pay on every row plus the whole-cart "Pay all" in the header.
 *
 * Dates are relative to "today" so the scenario never rots.
 */
export const MANAGER_ID = "mgr-fixture";
export const PROPERTY_ID = "prop-magnolia";
export const RESIDENT_EMAIL = "maya@example.com";

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
  const thisMonthName = today.toLocaleDateString("en-US", { month: "long" });

  const base = {
    createdAt: new Date(today.getFullYear(), today.getMonth() - 2, 1).toISOString(),
    residentEmail: RESIDENT_EMAIL,
    residentName: "Maya Chen",
    residentUserId: "res-maya",
    propertyId: PROPERTY_ID,
    propertyLabel: "The Magnolia · 2B",
    managerUserId: MANAGER_ID,
    blocksLeaseUntilPaid: false,
    // PropLane payments are ON for this listing: every pending line is payable
    // on the platform rail (card or in-app ACH), which is the whole point here.
    axisPaymentsEnabledSnapshot: true,
    acceptedPaymentMethodsSnapshot: ["card", "ach"],
  };

  const charges = [
    {
      ...base,
      id: "hc_central_overdue",
      kind: "late_fee",
      title: "Late fee",
      amountLabel: "$50.00",
      balanceLabel: "$50.00",
      status: "pending",
      dueDateLabel: label(overdueDue),
    },
    {
      ...base,
      id: "hc_central_due_soon",
      kind: "utilities",
      title: `Utilities — ${thisMonthName}`,
      amountLabel: "$95.00",
      balanceLabel: "$95.00",
      status: "pending",
      rentMonth: ymd(today),
      dueDateLabel: label(dueSoon),
    },
  ];

  return { charges, applications: APPLICATIONS, rentProfiles: [] };
}
