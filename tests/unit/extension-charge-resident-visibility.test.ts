/** @vitest-environment jsdom */
import { afterEach, expect, it, vi } from "vitest";
import { HOUSEHOLD_CHARGES_SESSION_KEY, readChargesForResident, dedupeHouseholdCharges, isPendingUpfrontMoveInCharge, type HouseholdCharge } from "@/lib/household-charges";
import { residentVisibleCharges } from "@/lib/household-charge-visibility";

afterEach(() => { window.sessionStorage.clear(); vi.useRealTimers(); });

it("shows explicitly surfaced extension charges beyond the normal horizon only to their resident", () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-24T12:00:00Z"));
  const charge = {
    id: "extension-march", kind: "rent", status: "pending", residentEmail: "qa@example.invalid",
    residentUserId: "resident", residentName: "QA", managerUserId: "owner", propertyId: "house",
    propertyLabel: "QA House", title: "Stay extension", amountLabel: "$1,000.00", balanceLabel: "$1,000.00",
    createdAt: "2026-11-24", dueDateLabel: "2027-03-01", rentMonth: "2027-03",
    residentVisibleAt: "2026-11-24T12:00:00Z", blocksLeaseUntilPaid: false,
  } satisfies HouseholdCharge;
  window.sessionStorage.setItem(HOUSEHOLD_CHARGES_SESSION_KEY, JSON.stringify([
    charge,
    { ...charge, id: "normal-april", rentMonth: "2027-04", dueDateLabel: "2027-04-01", residentVisibleAt: undefined },
    { ...charge, id: "other-resident", residentEmail: "other@example.invalid", residentUserId: "other" },
  ]));
  const visible = residentVisibleCharges(readChargesForResident("qa@example.invalid", "resident"));
  expect(visible.map((row) => row.id)).toEqual([charge.id]);
  expect(visible[0]?.dueDateLabel).toBe("2027-03-01");
  expect(visible[0]?.status).toBe("pending");
});

it("retains separate added periods and utilities when a stay is extended twice in the same month", () => {
  const base = {
    id: "rent-one", kind: "rent", status: "pending", residentEmail: "qa@example.invalid", residentName: "QA",
    managerUserId: "owner", propertyId: "house", propertyLabel: "QA House", applicationId: "app",
    createdAt: "2026-11-24", title: "Extension", amountLabel: "$500", balanceLabel: "$500", rentMonth: "2027-03",
    blocksLeaseUntilPaid: false, stayExtension: { extensionId: "one", key: "rent", start: "2027-03-01", end: "2027-03-15" },
  } satisfies HouseholdCharge;
  const rows: HouseholdCharge[] = [
    base, { ...base, id: "rent-two", kind: "prorated_rent", stayExtension: { ...base.stayExtension, extensionId: "two", start: "2027-03-16", end: "2027-03-31" } },
    { ...base, id: "utilities-one", kind: "utilities", stayExtension: { ...base.stayExtension, key: "utilities" } },
    { ...base, id: "utilities-two", kind: "utilities", stayExtension: { ...base.stayExtension, extensionId: "two", key: "utilities" } },
    { ...base, id: "fee-one", kind: "other_cost", stayExtension: { ...base.stayExtension, key: "fee:parking" } },
  ];
  expect(dedupeHouseholdCharges([...rows, { ...base }]).map((row) => row.id).sort()).toEqual(rows.map((row) => row.id).sort());
  expect(rows.some(isPendingUpfrontMoveInCharge)).toBe(false);
});
