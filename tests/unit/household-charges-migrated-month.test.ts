/**
 * @vitest-environment jsdom
 *
 * A migrated month covers the recurring generator (PLAN-0920-2357 stream A). A
 * sales-migration import writes one all-in rent charge (`migrationSourceId` set) for
 * whatever month the tenant was imported for, rolling rent + utilities into a single
 * figure. `syncAllRecurringRentCharges` used to key its dedupe off `chargeBusinessKey`,
 * which deliberately returns a unique key per migrated row (so distinct imported charges
 * never collapse into one another) — the side effect was that the generator never
 * recognized a migrated row as "this month is already billed" and minted a second,
 * separate recurring rent + utilities charge for the same month on top of the import.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  readHouseholdCharges,
  seedDemoHouseholdCharges,
  upsertRecurringRentProfile,
  type HouseholdCharge,
} from "@/lib/household-charges";

const MANAGER_ID = "mgr-migrated-month";
const PROPERTY_ID = "prop-migrated-month";
const PROPERTY_LABEL = "Migrated House";
const RESIDENT_EMAIL = "resident@migrated-month.test";
const RESIDENT_NAME = "Migrated Resident";

function migratedRentCharge(rentMonth: string): HouseholdCharge {
  return {
    migrationSourceId: "migration-source-1",
    id: `hc_migrated_${rentMonth}`,
    createdAt: new Date().toISOString(),
    residentEmail: RESIDENT_EMAIL,
    residentName: RESIDENT_NAME,
    residentUserId: null,
    propertyId: PROPERTY_ID,
    propertyLabel: PROPERTY_LABEL,
    managerUserId: MANAGER_ID,
    kind: "rent",
    title: `Rent (imported) — ${rentMonth}`,
    amountLabel: "$1500.00",
    balanceLabel: "$1500.00",
    status: "pending",
    rentMonth,
    blocksLeaseUntilPaid: false,
  };
}

function chargesForMonth(rentMonth: string) {
  return readHouseholdCharges().filter(
    (c) =>
      c.residentEmail.trim().toLowerCase() === RESIDENT_EMAIL &&
      c.propertyId === PROPERTY_ID &&
      c.rentMonth === rentMonth &&
      (c.kind === "rent" || c.kind === "utilities"),
  );
}

function seedProfile(startMonth: string) {
  upsertRecurringRentProfile({
    residentEmail: RESIDENT_EMAIL,
    residentName: RESIDENT_NAME,
    propertyId: PROPERTY_ID,
    propertyLabel: PROPERTY_LABEL,
    roomLabel: "Room 1",
    managerUserId: MANAGER_ID,
    monthlyRent: 1000,
    monthlyUtilities: 100,
    startMonth,
  });
}

beforeEach(() => {
  window.sessionStorage.clear();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("a migrated month covers the generator", () => {
  it("skips generating rent and utilities for a month already covered by a migrated import", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-05T12:00:00.000Z"));

    seedDemoHouseholdCharges([migratedRentCharge("2026-10")], []);
    seedProfile("2026-10");

    const october = chargesForMonth("2026-10");
    // Only the migrated row itself — no generated rent, no generated utilities.
    expect(october).toHaveLength(1);
    expect(october[0]!.migrationSourceId).toBe("migration-source-1");
  });

  it("still generates a later month that has no migrated row", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-15T12:00:00.000Z"));

    seedDemoHouseholdCharges([migratedRentCharge("2026-10")], []);
    seedProfile("2026-10");

    // October stays covered by the migrated row alone.
    expect(chargesForMonth("2026-10")).toHaveLength(1);

    // November has no migrated row, so the generator materializes it normally.
    const november = chargesForMonth("2026-11");
    expect(november.find((c) => c.kind === "rent")).toBeTruthy();
    expect(november.find((c) => c.kind === "utilities")).toBeTruthy();
  });

  it("generates rent and utilities normally when there is no migrated row", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-05T12:00:00.000Z"));

    // Reset the in-memory store explicitly — `window.sessionStorage.clear()` in
    // `beforeEach` clears the persisted backup but not the module's in-memory
    // charges/profiles, and every case in this file reuses the same resident and
    // property so a prior case's rows would otherwise leak in here.
    seedDemoHouseholdCharges([], []);
    seedProfile("2026-10");

    const october = chargesForMonth("2026-10");
    expect(october.find((c) => c.kind === "rent")).toBeTruthy();
    expect(october.find((c) => c.kind === "utilities")).toBeTruthy();
    expect(october.some((c) => c.migrationSourceId)).toBe(false);
  });
});
