import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildPortfolioImportDraft,
  draftHasBlockingIssues,
  recomputeDraftAfterEdits,
  summarizePortfolioImportDraft,
} from "@/lib/portfolio-import/build-draft";
import { applyManualColumnMapping, mapPortfolioImportHeaders } from "@/lib/portfolio-import/column-map";
import { readCsvTable, readXlsxTable } from "@/lib/portfolio-import/spreadsheet.server";
import type { PortfolioImportDraft, PortfolioImportSourceTable } from "@/lib/portfolio-import/types";

const fixturesDir = path.resolve(__dirname, "../fixtures/portfolio-import");
const TODAY = new Date("2026-09-14T00:00:00.000Z");

function countByCode(draft: PortfolioImportDraft, code: string) {
  return draft.issues.filter((i) => i.code === code).length;
}
function countBySeverity(draft: PortfolioImportDraft, severity: string) {
  return draft.issues.filter((i) => i.severity === severity).length;
}
function countByKind(draft: PortfolioImportDraft, kind: string) {
  return draft.tasks.filter((t) => t.kind === kind).length;
}

/** Asserts the canonical expected shape from the task brief's fixture data set. */
function assertCanonicalDraft(draft: PortfolioImportDraft) {
  expect(draft.properties).toHaveLength(2);
  expect(draft.units).toHaveLength(7);
  expect(draft.residents).toHaveLength(6);
  expect(draft.balances).toHaveLength(1);
  expect(draft.balances[0].amount).toBe(350);
  expect(draft.rowCount).toBe(7); // the Total row is skipped, never counted

  expect(countBySeverity(draft, "block")).toBe(1);
  expect(countByCode(draft, "missing_email")).toBe(1);
  const luis = draft.residents.find((r) => r.name === "Luis Ortega");
  expect(luis).toBeTruthy();
  expect(luis!.email).toBeNull();
  expect(draft.issues.find((i) => i.code === "missing_email")?.residentKey).toBe(luis!.key);

  expect(countByCode(draft, "past_due_balance")).toBe(1);
  const marcus = draft.residents.find((r) => r.name === "Marcus Bell");
  expect(draft.issues.find((i) => i.code === "past_due_balance")?.residentKey).toBe(marcus!.key);

  expect(countByCode(draft, "shared_unit")).toBe(1);
  expect(countByCode(draft, "missing_phone")).toBe(1);
  const tom = draft.residents.find((r) => r.name === "Tom Ellis");
  expect(tom).toBeTruthy();
  expect(tom!.phone).toBeNull();
  expect(tom!.email).toBeNull();
  // Tom is a co-resident on a shared unit: missing phone is flagged (info), but
  // missing email is NOT — that block-severity check applies only to the
  // primary resident on the row (Priya, who does have an email).
  expect(draft.issues.find((i) => i.code === "missing_phone")?.residentKey).toBe(tom!.key);
  expect(draft.issues.some((i) => i.code === "missing_email" && i.residentKey === tom!.key)).toBe(false);

  expect(countByCode(draft, "vacant_unit")).toBe(2);
  expect(countByCode(draft, "summary_row_skipped")).toBe(1);
  expect(countByCode(draft, "duplicate_resident")).toBe(0);
  expect(countByCode(draft, "missing_rent")).toBe(0);

  expect(countByKind(draft, "add_photos")).toBe(2);
  expect(countByKind(draft, "upload_signed_lease")).toBe(6); // nobody has a leasePdf yet
  expect(countByKind(draft, "lease_ending")).toBe(1);
  expect(countByKind(draft, "add_resident_email")).toBe(1);
  expect(countByKind(draft, "connect_payouts")).toBe(1);

  const leaseEndingTask = draft.tasks.find((t) => t.kind === "lease_ending");
  expect(leaseEndingTask?.residentKey).toBe(luis!.key);
  expect(leaseEndingTask?.dueDate).toBe("2026-10-01");
  expect(leaseEndingTask?.urgency).toBe("deadline");

  const addEmailTask = draft.tasks.find((t) => t.kind === "add_resident_email");
  expect(addEmailTask?.residentKey).toBe(luis!.key);

  // Rent recorded once on the shared unit, never doubled.
  const unit2b = draft.units.find((u) => u.label === "2B");
  expect(unit2b?.monthlyRent).toBe(2100);
  expect(unit2b?.residentKeys).toHaveLength(2);
}

function tableFromCsvFixture(name: string): PortfolioImportSourceTable {
  return readCsvTable(readFileSync(path.join(fixturesDir, name), "utf8"));
}

describe("buildPortfolioImportDraft — AppFolio fixture", () => {
  const table = tableFromCsvFixture("appfolio-rent-roll.csv");
  const { columns, preset } = mapPortfolioImportHeaders(table.headers, table.rows.slice(0, 3).map((r) => r.cells));

  it("produces the canonical draft shape", () => {
    const draft = buildPortfolioImportDraft({
      table,
      columns,
      sourceKind: "csv",
      preset,
      fileName: "appfolio-rent-roll.csv",
      today: TODAY,
    });
    assertCanonicalDraft(draft);
    expect(draft.preset).toBe("appfolio");
    // Clean AppFolio headers map fully — no unmapped-column notes.
    expect(countByCode(draft, "unmapped_column")).toBe(0);
  });

  it("produces stable task keys across two independent builds", () => {
    const a = buildPortfolioImportDraft({ table, columns, sourceKind: "csv", preset, fileName: "a.csv", today: TODAY });
    const b = buildPortfolioImportDraft({ table, columns, sourceKind: "csv", preset, fileName: "a.csv", today: TODAY });
    expect(a.tasks.map((t) => t.key).sort()).toEqual(b.tasks.map((t) => t.key).sort());
    expect(a.properties.map((p) => p.key).sort()).toEqual(b.properties.map((p) => p.key).sort());
    expect(a.residents.map((r) => r.key).sort()).toEqual(b.residents.map((r) => r.key).sort());
  });

  it("draftHasBlockingIssues is true until Luis's row is fixed", () => {
    const draft = buildPortfolioImportDraft({ table, columns, sourceKind: "csv", preset, fileName: "a.csv", today: TODAY });
    expect(draftHasBlockingIssues(draft)).toBe(true);
  });

  it("summarizePortfolioImportDraft reports counts consistent with the draft", () => {
    const draft = buildPortfolioImportDraft({ table, columns, sourceKind: "csv", preset, fileName: "a.csv", today: TODAY });
    const summary = summarizePortfolioImportDraft(draft, {
      importId: "imp_1",
      status: "draft",
      createdAt: "2026-09-14T00:00:00.000Z",
      committedAt: null,
    });
    expect(summary.propertyCount).toBe(2);
    expect(summary.unitCount).toBe(7);
    expect(summary.residentCount).toBe(6);
    expect(summary.balanceCount).toBe(1);
    expect(summary.balanceTotal).toBe(350);
    expect(summary.taskCount).toBe(draft.tasks.length);
    expect(summary.blockingIssueCount).toBe(1);
    expect(summary.reviewIssueCount).toBe(2); // past_due_balance + shared_unit
    expect(summary.invitableByEmail).toBe(4); // everyone but Luis (no email) and Tom (no email)
    expect(summary.invitableByText).toBe(5); // everyone but Tom (no phone)
  });
});

describe("buildPortfolioImportDraft — Buildium fixture (xlsx)", () => {
  it("produces the same canonical shape, plus one unmapped Market Rent column", () => {
    const table = readXlsxTable(readFileSync(path.join(fixturesDir, "buildium-rent-roll.xlsx")));
    const { columns, preset } = mapPortfolioImportHeaders(table.headers, table.rows.slice(0, 3).map((r) => r.cells));
    expect(preset).toBe("buildium");

    const draft = buildPortfolioImportDraft({
      table,
      columns,
      sourceKind: "xlsx",
      preset,
      fileName: "buildium-rent-roll.xlsx",
      today: TODAY,
    });
    assertCanonicalDraft(draft);
    expect(countByCode(draft, "unmapped_column")).toBe(1);
    expect(draft.issues.find((i) => i.code === "unmapped_column")?.message).toContain("Market Rent");

    // Market Rent must never have been used as monthlyRent.
    const unit1a = draft.units.find((u) => u.label === "1A");
    expect(unit1a?.monthlyRent).toBe(1850); // not 1975 (Market Rent)
  });
});

describe("buildPortfolioImportDraft — generic fixture (manual column mapping)", () => {
  it("produces the same canonical shape once Rent/mo and Owed are manually mapped", () => {
    const table = tableFromCsvFixture("generic.csv");
    const mapped = mapPortfolioImportHeaders(table.headers, table.rows.slice(0, 3).map((r) => r.cells));
    const { preset } = mapped;
    let columns = mapped.columns;
    expect(preset).toBe("generic");

    const rentIdx = columns.findIndex((c) => c.header === "Rent/mo");
    const owedIdx = columns.findIndex((c) => c.header === "Owed");
    expect(columns[rentIdx].key).toBeNull();
    expect(columns[owedIdx].key).toBeNull();
    columns = applyManualColumnMapping(columns, rentIdx, "monthlyRent");
    columns = applyManualColumnMapping(columns, owedIdx, "balance");

    const draft = buildPortfolioImportDraft({
      table,
      columns,
      sourceKind: "csv",
      preset,
      fileName: "generic.csv",
      today: TODAY,
    });
    assertCanonicalDraft(draft);
    // "Bldg" stays unmapped — a decorative column, not needed for grouping since
    // Address is present and mapped.
    expect(countByCode(draft, "unmapped_column")).toBe(1);
    expect(draft.issues.find((i) => i.code === "unmapped_column")?.message).toContain("Bldg");
  });
});

describe("parsing edge cases", () => {
  function draftFromRows(headers: string[], rows: string[][], opts: Partial<Parameters<typeof buildPortfolioImportDraft>[0]> = {}) {
    const table: PortfolioImportSourceTable = {
      headers,
      rows: rows.map((cells, i) => ({ cells, source: { row: i + 2 } })),
      skippedRows: [],
    };
    const { columns } = mapPortfolioImportHeaders(headers, rows);
    return buildPortfolioImportDraft({
      table,
      columns,
      sourceKind: "csv",
      preset: "generic",
      fileName: "edge.csv",
      today: TODAY,
      ...opts,
    });
  }

  it("parses money: strips $ and commas, parens are negative, blank is null", () => {
    const headers = ["Property", "Unit", "Tenant", "Rent"];
    const draft = draftFromRows(headers, [
      ["A", "1", "Dana", "$1,850.00"],
      ["A", "2", "Marcus", "(350.00)"],
      ["A", "3", "Priya", ""],
    ]);
    const byLabel = Object.fromEntries(draft.units.map((u) => [u.label, u]));
    expect(byLabel["1"].monthlyRent).toBe(1850);
    expect(byLabel["2"].monthlyRent).toBe(-350);
    expect(byLabel["3"].monthlyRent).toBeNull();
  });

  it("parses dates in every accepted format", () => {
    const headers = ["Property", "Unit", "Tenant", "Lease Start"];
    const draft = draftFromRows(headers, [
      ["A", "1", "Dana", "2026-03-01"],
      ["A", "2", "Marcus", "3/1/2026"],
      ["A", "3", "Priya", "Mar 1, 2026"],
      ["A", "4", "Luis", "1-Mar-26"],
    ]);
    for (const resident of draft.residents) {
      expect(resident.leaseStart).toBe("2026-03-01");
    }
  });

  it("keeps an unparseable date's raw text in notes instead of throwing", () => {
    const headers = ["Property", "Unit", "Tenant", "Lease Start"];
    const draft = draftFromRows(headers, [["A", "1", "Dana", "next spring sometime"]]);
    expect(draft.residents[0].leaseStart).toBeNull();
    expect(draft.residents[0].notes).toContain("next spring sometime");
  });

  it("invalid phone -> null + a review invalid_phone issue", () => {
    const headers = ["Property", "Unit", "Tenant", "Phone"];
    const draft = draftFromRows(headers, [["A", "1", "Dana", "12"]]);
    expect(draft.residents[0].phone).toBeNull();
    const issue = draft.issues.find((i) => i.code === "invalid_phone");
    expect(issue?.severity).toBe("review");
  });

  it("invalid email -> null + a block invalid_email issue", () => {
    const headers = ["Property", "Unit", "Tenant", "Email"];
    const draft = draftFromRows(headers, [["A", "1", "Dana", "not-an-email"]]);
    expect(draft.residents[0].email).toBeNull();
    const issue = draft.issues.find((i) => i.code === "invalid_email");
    expect(issue?.severity).toBe("block");
    // A resident never gets both invalid_email and missing_email for the same field.
    expect(draft.issues.some((i) => i.code === "missing_email" && i.residentKey === draft.residents[0].key)).toBe(false);
  });

  it("splits several tenant names on &, and, comma, semicolon, slash", () => {
    const headers = ["Property", "Unit", "Tenant"];
    const draft = draftFromRows(headers, [
      ["A", "1", "Dana Whitfield & Marcus Bell"],
      ["A", "2", "Priya Nair and Tom Ellis"],
      ["A", "3", "Jae Park, Luis Ortega"],
      ["A", "4", "A Person; B Person"],
      ["A", "5", "C Person / D Person"],
    ]);
    expect(draft.residents.map((r) => r.name)).toEqual([
      "Dana Whitfield", "Marcus Bell",
      "Priya Nair", "Tom Ellis",
      "Jae Park", "Luis Ortega",
      "A Person", "B Person",
      "C Person", "D Person",
    ]);
  });

  it("no resident name and no vacancy keyword still yields a vacant unit", () => {
    const headers = ["Property", "Unit", "Tenant", "Rent"];
    const draft = draftFromRows(headers, [["A", "1", "", "1500"]]);
    expect(draft.units[0].occupancy).toBe("vacant");
    expect(draft.residents).toHaveLength(0);
    expect(draft.issues.some((i) => i.code === "vacant_unit")).toBe(true);
  });

  it("a file with no unit column treats each row as one unit ('Unit 1')", () => {
    const headers = ["Property", "Tenant", "Rent"];
    const draft = draftFromRows(headers, [["Maple Court", "Dana", "1850"]]);
    expect(draft.units).toHaveLength(1);
    expect(draft.units[0].label).toBe("Unit 1");
  });

  it("a file with neither address nor property name -> one missing_property block issue", () => {
    const headers = ["Unit", "Tenant", "Rent"];
    const draft = draftFromRows(headers, [
      ["1", "Dana", "1850"],
      ["2", "Marcus", "1795"],
    ]);
    const missing = draft.issues.filter((i) => i.code === "missing_property");
    expect(missing).toHaveLength(1);
    expect(missing[0].severity).toBe("block");
  });

  it("inventoryKind is room when most unit labels contain room/bed, else unit", () => {
    const headers = ["Property", "Unit", "Tenant"];
    const roomDraft = draftFromRows(headers, [
      ["Pine St", "Room 1", "Jae"],
      ["Pine St", "Room 2", "Luis"],
    ]);
    expect(roomDraft.properties[0].inventoryKind).toBe("room");

    const unitDraft = draftFromRows(headers, [
      ["Maple Court", "1A", "Dana"],
      ["Maple Court", "1B", "Marcus"],
    ]);
    expect(unitDraft.properties[0].inventoryKind).toBe("unit");
  });

  it("duplicate_resident fires on a repeated email, including one already in existingEmails", () => {
    const headers = ["Property", "Unit", "Tenant", "Email"];
    const draft = draftFromRows(
      headers,
      [
        ["A", "1", "Dana", "dana@example.com"],
        ["A", "2", "Marcus", "dana@example.com"],
        ["A", "3", "Priya", "priya@example.com"],
      ],
      { existingEmails: ["priya@example.com"] },
    );
    expect(draft.issues.filter((i) => i.code === "duplicate_resident")).toHaveLength(2);
  });
});

describe("recomputeDraftAfterEdits", () => {
  function buildBaseDraft(): PortfolioImportDraft {
    const table = tableFromCsvFixture("appfolio-rent-roll.csv");
    const { columns, preset } = mapPortfolioImportHeaders(table.headers, table.rows.slice(0, 3).map((r) => r.cells));
    return buildPortfolioImportDraft({ table, columns, sourceKind: "csv", preset, fileName: "a.csv", today: TODAY });
  }

  it("clears the missing_email block issue once the manager adds an email", () => {
    const draft = buildBaseDraft();
    expect(draftHasBlockingIssues(draft)).toBe(true);

    const luis = draft.residents.find((r) => r.name === "Luis Ortega")!;
    const edited: PortfolioImportDraft = {
      ...draft,
      residents: draft.residents.map((r) => (r.key === luis.key ? { ...r, email: "luis.ortega@gmail.com" } : r)),
    };
    const recomputed = recomputeDraftAfterEdits(edited);
    expect(draftHasBlockingIssues(recomputed)).toBe(false);
    expect(recomputed.issues.some((i) => i.code === "missing_email" && i.residentKey === luis.key)).toBe(false);
    const updatedLuis = recomputed.residents.find((r) => r.key === luis.key)!;
    expect(updatedLuis.inviteChannels.email).toBe(true);
    expect(recomputed.tasks.some((t) => t.kind === "add_resident_email" && t.residentKey === luis.key)).toBe(false);
  });

  it("clears the missing_email block issue once the manager excludes the row", () => {
    const draft = buildBaseDraft();
    const luis = draft.residents.find((r) => r.name === "Luis Ortega")!;
    const edited: PortfolioImportDraft = {
      ...draft,
      residents: draft.residents.map((r) => (r.key === luis.key ? { ...r, excluded: true } : r)),
    };
    const recomputed = recomputeDraftAfterEdits(edited);
    expect(draftHasBlockingIssues(recomputed)).toBe(false);
    expect(recomputed.issues.some((i) => i.residentKey === luis.key)).toBe(false);
  });

  it("is otherwise stable: task keys match a fresh build for unedited residents", () => {
    const draft = buildBaseDraft();
    const recomputed = recomputeDraftAfterEdits(draft);
    const originalAddPhotoKeys = draft.tasks.filter((t) => t.kind === "add_photos").map((t) => t.key).sort();
    const recomputedAddPhotoKeys = recomputed.tasks.filter((t) => t.kind === "add_photos").map((t) => t.key).sort();
    expect(recomputedAddPhotoKeys).toEqual(originalAddPhotoKeys);
  });
});
