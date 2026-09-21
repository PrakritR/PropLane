import { describe, expect, it } from "vitest";
import {
  selectDeadPropertyLedgerEntries,
  selectDuplicateGeneratedCharges,
  selectLedgerEntriesForCharges,
  selectOrphanChargeLedgerEntries,
  summarize,
  type ChargeRow,
  type LedgerRow,
} from "@/lib/ambika-payments-cleanup";

function charge(overrides: Partial<ChargeRow> & { id: string }): ChargeRow {
  return {
    resident_email: "resident@example.com",
    property_id: "prop-1",
    kind: "rent",
    status: "pending",
    row_data: null,
    ...overrides,
  };
}

function ledger(overrides: Partial<LedgerRow> & { id: string }): LedgerRow {
  return {
    resident_email: "resident@example.com",
    property_id: "prop-1",
    entry_type: "charge",
    source_charge_id: null,
    amount_cents: 100000,
    due_date: "2026-09-01",
    created_at: "2026-09-19T12:00:00Z",
    description: "Rent",
    ...overrides,
  };
}

describe("selectDuplicateGeneratedCharges", () => {
  it("selects a generated rent charge that duplicates an imported one", () => {
    const rows = [
      charge({
        id: "generated-1",
        kind: "rent",
        property_id: "prop-1",
        resident_email: "Resident@Example.com",
        row_data: { recurringRentProfileId: "profile-1", rentMonth: "2026-09" },
      }),
      charge({
        id: "imported-1",
        kind: "rent",
        property_id: "prop-1",
        resident_email: "resident@example.com",
        row_data: { migrationSourceId: "import-1", rentMonth: "2026-09" },
      }),
    ];
    expect(selectDuplicateGeneratedCharges(rows)).toEqual(["generated-1"]);
  });

  it("matches emails case-insensitively", () => {
    const rows = [
      charge({
        id: "generated-1",
        row_data: { recurringRentProfileId: "profile-1", rentMonth: "2026-09" },
        resident_email: "MixedCase@Example.com",
      }),
      charge({
        id: "imported-1",
        row_data: { migrationSourceId: "import-1", rentMonth: "2026-09" },
        resident_email: "mixedcase@example.com",
      }),
    ];
    expect(selectDuplicateGeneratedCharges(rows)).toEqual(["generated-1"]);
  });

  it("requires the same rent month", () => {
    const rows = [
      charge({
        id: "generated-1",
        row_data: { recurringRentProfileId: "profile-1", rentMonth: "2026-09" },
      }),
      charge({
        id: "imported-1",
        row_data: { migrationSourceId: "import-1", rentMonth: "2026-10" },
      }),
    ];
    expect(selectDuplicateGeneratedCharges(rows)).toEqual([]);
  });

  it("selects both rent and utilities generated rows for the same imported rent month", () => {
    const rows = [
      charge({
        id: "generated-rent",
        kind: "rent",
        row_data: { recurringRentProfileId: "profile-1", rentMonth: "2026-09" },
      }),
      charge({
        id: "generated-utilities",
        kind: "utilities",
        row_data: { recurringRentProfileId: "profile-1", rentMonth: "2026-09" },
      }),
      charge({
        id: "imported-1",
        kind: "rent",
        row_data: { migrationSourceId: "import-1", rentMonth: "2026-09" },
      }),
    ];
    expect(selectDuplicateGeneratedCharges(rows).sort()).toEqual(["generated-rent", "generated-utilities"]);
  });

  it("never selects an imported row itself", () => {
    const rows = [
      charge({
        id: "imported-1",
        kind: "rent",
        row_data: { migrationSourceId: "import-1", rentMonth: "2026-09" },
      }),
    ];
    expect(selectDuplicateGeneratedCharges(rows)).toEqual([]);
  });

  it("does not select paid rows differently — status is irrelevant", () => {
    const rows = [
      charge({
        id: "generated-1",
        status: "paid",
        row_data: { recurringRentProfileId: "profile-1", rentMonth: "2026-09" },
      }),
      charge({
        id: "imported-1",
        status: "paid",
        row_data: { migrationSourceId: "import-1", rentMonth: "2026-09" },
      }),
    ];
    expect(selectDuplicateGeneratedCharges(rows)).toEqual(["generated-1"]);
  });

  it("does not select a generated row with no matching imported row", () => {
    const rows = [
      charge({
        id: "generated-1",
        row_data: { recurringRentProfileId: "profile-1", rentMonth: "2026-09" },
      }),
    ];
    expect(selectDuplicateGeneratedCharges(rows)).toEqual([]);
  });

  it("requires the same property", () => {
    const rows = [
      charge({
        id: "generated-1",
        property_id: "prop-1",
        row_data: { recurringRentProfileId: "profile-1", rentMonth: "2026-09" },
      }),
      charge({
        id: "imported-1",
        property_id: "prop-2",
        row_data: { migrationSourceId: "import-1", rentMonth: "2026-09" },
      }),
    ];
    expect(selectDuplicateGeneratedCharges(rows)).toEqual([]);
  });

  it("ignores rows without a recurringRentProfileId or a generated kind", () => {
    const rows = [
      charge({ id: "manual-1", kind: "deposit", row_data: { rentMonth: "2026-09" } }),
      charge({ id: "no-row-data", row_data: null }),
      charge({
        id: "imported-1",
        row_data: { migrationSourceId: "import-1", rentMonth: "2026-09" },
      }),
    ];
    expect(selectDuplicateGeneratedCharges(rows)).toEqual([]);
  });
});

describe("selectDeadPropertyLedgerEntries", () => {
  it("selects ledger rows whose property is not in the live set", () => {
    const rows = [
      ledger({ id: "l1", property_id: "live-1" }),
      ledger({ id: "l2", property_id: "dead-seed-1" }),
      ledger({ id: "l3", property_id: "dead-seed-2" }),
    ];
    const live = new Set(["live-1"]);
    expect(selectDeadPropertyLedgerEntries(rows, live).sort()).toEqual(["l2", "l3"]);
  });

  it("selects a row with a null property id", () => {
    const rows = [ledger({ id: "l1", property_id: null })];
    expect(selectDeadPropertyLedgerEntries(rows, new Set(["live-1"]))).toEqual(["l1"]);
  });
});

describe("selectOrphanChargeLedgerEntries", () => {
  const live = new Set(["live-1"]);

  it("selects a charge-type ledger row on a live property with no source charge since the cutoff", () => {
    const rows = [
      ledger({
        id: "l1",
        entry_type: "charge",
        source_charge_id: null,
        property_id: "live-1",
        created_at: "2026-09-20T00:00:00Z",
      }),
    ];
    expect(selectOrphanChargeLedgerEntries(rows, live)).toEqual(["l1"]);
  });

  it("excludes rows before the since cutoff", () => {
    const rows = [
      ledger({
        id: "l1",
        entry_type: "charge",
        source_charge_id: null,
        property_id: "live-1",
        created_at: "2026-09-18T00:00:00Z",
      }),
    ];
    expect(selectOrphanChargeLedgerEntries(rows, live)).toEqual([]);
  });

  it("respects a custom since cutoff", () => {
    const rows = [
      ledger({
        id: "l1",
        entry_type: "charge",
        source_charge_id: null,
        property_id: "live-1",
        created_at: "2026-09-05T00:00:00Z",
      }),
    ];
    expect(selectOrphanChargeLedgerEntries(rows, live, "2026-09-01T00:00:00Z")).toEqual(["l1"]);
  });

  it("excludes rows with a source charge id", () => {
    const rows = [
      ledger({
        id: "l1",
        entry_type: "charge",
        source_charge_id: "charge-1",
        property_id: "live-1",
        created_at: "2026-09-20T00:00:00Z",
      }),
    ];
    expect(selectOrphanChargeLedgerEntries(rows, live)).toEqual([]);
  });

  it("excludes non-charge entry types", () => {
    const rows = [
      ledger({
        id: "l1",
        entry_type: "payment",
        source_charge_id: null,
        property_id: "live-1",
        created_at: "2026-09-20T00:00:00Z",
      }),
    ];
    expect(selectOrphanChargeLedgerEntries(rows, live)).toEqual([]);
  });

  it("excludes dead properties — those belong to selectDeadPropertyLedgerEntries", () => {
    const rows = [
      ledger({
        id: "l1",
        entry_type: "charge",
        source_charge_id: null,
        property_id: "dead-1",
        created_at: "2026-09-20T00:00:00Z",
      }),
    ];
    expect(selectOrphanChargeLedgerEntries(rows, live)).toEqual([]);
  });
});

describe("selectLedgerEntriesForCharges", () => {
  it("selects ledger rows whose source_charge_id matches a given charge id", () => {
    const rows = [
      ledger({ id: "l1", source_charge_id: "charge-1" }),
      ledger({ id: "l2", source_charge_id: "charge-2" }),
      ledger({ id: "l3", source_charge_id: null }),
    ];
    expect(selectLedgerEntriesForCharges(rows, ["charge-1"])).toEqual(["l1"]);
  });

  it("returns nothing when no charge ids match", () => {
    const rows = [ledger({ id: "l1", source_charge_id: "charge-9" })];
    expect(selectLedgerEntriesForCharges(rows, ["charge-1"])).toEqual([]);
  });
});

describe("summarize", () => {
  it("counts each group and sums ledger amounts", () => {
    const ledgerRows = [
      ledger({ id: "dead-1", property_id: "dead-1", amount_cents: 50000 }),
      ledger({ id: "dead-2", property_id: "dead-1", amount_cents: 25000 }),
      ledger({ id: "orphan-1", property_id: "live-1", amount_cents: 10000 }),
      ledger({ id: "dup-1", property_id: "live-1", source_charge_id: "generated-1", amount_cents: 100000 }),
    ];
    const summary = summarize(["generated-1"], ["dead-1", "dead-2"], ["orphan-1"], ["dup-1"], ledgerRows);
    expect(summary).toEqual({
      duplicateGeneratedCharges: { count: 1, amountCents: 0 },
      deadPropertyLedgerEntries: { count: 2, amountCents: 75000 },
      orphanChargeLedgerEntries: { count: 1, amountCents: 10000 },
      duplicateChargeLedgerEntries: { count: 1, amountCents: 100000 },
    });
  });

  it("handles empty groups", () => {
    const summary = summarize([], [], [], [], []);
    expect(summary).toEqual({
      duplicateGeneratedCharges: { count: 0, amountCents: 0 },
      deadPropertyLedgerEntries: { count: 0, amountCents: 0 },
      orphanChargeLedgerEntries: { count: 0, amountCents: 0 },
      duplicateChargeLedgerEntries: { count: 0, amountCents: 0 },
    });
  });
});
