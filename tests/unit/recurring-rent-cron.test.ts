import { beforeEach, describe, expect, it, vi } from "vitest";
import { fakeSupabaseClient, type Row } from "./helpers/fake-supabase-tables";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/reports/ledger-sync", () => ({
  householdChargeLedgerFingerprint: () => "fp",
  reconcileDuplicateChargeList: async () => undefined,
  syncLedgerChargeEntry: async () => undefined,
}));
vi.mock("@/lib/domain-action-events.server", () => ({ emitHouseholdChargeTransition: async () => undefined }));
vi.mock("@/lib/payment-reminder-lifecycle.server", () => ({ cancelFuturePaymentRemindersForCharge: async () => undefined }));

import { runRecurringRentSweep } from "@/lib/recurring-rent-cron.server";
import { residentsMissingRentProfile } from "@/lib/recurring-rent-sweep";

const MANAGER = "11111111-1111-4111-8111-111111111111";
const NOW = new Date(2026, 9, 12, 13, 0, 0); // Oct 12 2026, local
const EMAIL = "resident@sweep.test";

function profile(extra: Record<string, unknown> = {}): Row {
  const row_data = {
    id: "rp-1",
    residentEmail: EMAIL,
    residentName: "Sweep Resident",
    residentUserId: null,
    propertyId: "prop-1",
    propertyLabel: "Sweep House",
    roomLabel: "Room 1",
    managerUserId: MANAGER,
    monthlyRent: 1000,
    dueDay: 1,
    startMonth: "2026-10", // lease began Sep 24: Sept is billed by the move-in charges
    active: true,
    updatedAt: "2026-09-24T00:00:00.000Z",
    ...extra,
  };
  return { id: "rp-1", manager_user_id: MANAGER, active: true, row_data, updated_at: "2026-09-24T00:00:00.000Z" };
}

let tables: Record<string, Row[]>;

beforeEach(() => {
  tables = {
    portal_recurring_rent_profile_records: [profile()],
    portal_household_charge_records: [],
    manager_application_records: [],
  };
});

const months = () =>
  tables.portal_household_charge_records
    .map((r) => (r.row_data as { rentMonth?: string; kind?: string }).rentMonth)
    .sort();

describe("recurring rent cron sweep", () => {
  it("creates this and next month once for a profile nobody opened the portal for", async () => {
    const db = fakeSupabaseClient(tables) as never;
    const first = await runRecurringRentSweep(db, NOW);
    expect(first.errors).toEqual([]);
    expect(first.created).toBe(2);
    expect(months()).toEqual(["2026-10", "2026-11"]);
    const row = tables.portal_household_charge_records[0]!;
    expect(row.manager_user_id).toBe(MANAGER);
    expect(row.status).toBe("pending");

    const second = await runRecurringRentSweep(db, NOW);
    expect(second.created).toBe(0);
    expect(tables.portal_household_charge_records).toHaveLength(2);
  });

  it("does not bill a month an imported row already covers", async () => {
    tables.portal_household_charge_records.push({
      id: "hc_imported_nov",
      manager_user_id: MANAGER,
      status: "pending",
      row_data: {
        id: "hc_imported_nov", migrationSourceId: "mig-1", managerUserId: MANAGER, kind: "rent", rentMonth: "2026-11",
        residentEmail: EMAIL, propertyId: "prop-1", status: "pending", amountLabel: "$1000.00", balanceLabel: "$1000.00",
      },
    });
    const result = await runRecurringRentSweep(fakeSupabaseClient(tables) as never, NOW);
    expect(result.created).toBe(1);
    const generated = tables.portal_household_charge_records.filter((r) => r.id !== "hc_imported_nov");
    expect(generated.map((r) => (r.row_data as { rentMonth: string }).rentMonth)).toEqual(["2026-10"]);
  });

  it("skips a resident on a migration billing hold", async () => {
    tables.manager_application_records.push({
      id: "app-1", manager_user_id: MANAGER, resident_email: EMAIL, "row_data->>migrationBillingHold": "true",
    });
    const result = await runRecurringRentSweep(fakeSupabaseClient(tables) as never, NOW);
    expect(result.created).toBe(0);
    expect(result.skippedHeld).toBe(1);
  });

  it("never rewrites a paid month", async () => {
    tables.portal_household_charge_records.push({
      id: "hc_rent_paid", manager_user_id: MANAGER, status: "paid",
      row_data: {
        id: "hc_rent_paid", managerUserId: MANAGER, kind: "rent", rentMonth: "2026-10", residentEmail: EMAIL, propertyId: "prop-1",
        recurringRentProfileId: "rp-1", status: "paid", amountLabel: "$1000.00", balanceLabel: "$0.00",
      },
    });
    await runRecurringRentSweep(fakeSupabaseClient(tables) as never, NOW);
    const paid = tables.portal_household_charge_records.find((r) => r.id === "hc_rent_paid")!;
    expect(paid.status).toBe("paid");
    expect((paid.row_data as { balanceLabel: string }).balanceLabel).toBe("$0.00");
  });
});

describe("residentsMissingRentProfile", () => {
  it("returns only residents with rent and no active profile for the placement", () => {
    const residents = [
      { email: "a@x.test", propertyId: "p1", monthlyRent: 900 },
      { email: "b@x.test", propertyId: "p1", monthlyRent: 900 },
      { email: "c@x.test", propertyId: "p1", monthlyRent: 0 },
    ];
    const profiles = [{ residentEmail: "A@x.test", propertyId: "p1", active: true }];
    expect(residentsMissingRentProfile(residents, profiles).map((r) => r.email)).toEqual(["b@x.test"]);
  });
});
