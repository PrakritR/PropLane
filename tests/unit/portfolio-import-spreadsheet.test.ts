import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { PortfolioImportRowLimitError, PortfolioImportUnreadableError } from "@/lib/portfolio-import/errors";
import { readCsvTable, readSpreadsheetTable, readXlsxTable } from "@/lib/portfolio-import/spreadsheet.server";
import { PORTFOLIO_IMPORT_MAX_ROWS } from "@/lib/portfolio-import/types";

const fixturesDir = path.resolve(__dirname, "../fixtures/portfolio-import");

describe("readCsvTable", () => {
  it("handles quoted fields, doubled quotes, embedded commas and newlines", () => {
    const csv = [
      "Property,Tenant,Notes",
      '"Maple Court","Dana ""D"" Whitfield","Likes quiet, ground floor"',
      '"Pine St","Multi\nline note","plain"',
    ].join("\n");
    const table = readCsvTable(csv);
    expect(table.headers).toEqual(["Property", "Tenant", "Notes"]);
    expect(table.rows).toHaveLength(2);
    expect(table.rows[0].cells).toEqual(["Maple Court", 'Dana "D" Whitfield', "Likes quiet, ground floor"]);
    expect(table.rows[1].cells).toEqual(["Pine St", "Multi\nline note", "plain"]);
  });

  it("handles CRLF line endings", () => {
    const csv = "Property,Unit,Tenant\r\nMaple Court,1A,Dana\r\nPine St,Room 1,Luis\r\n";
    const table = readCsvTable(csv);
    expect(table.rows.map((r) => r.cells)).toEqual([
      ["Maple Court", "1A", "Dana"],
      ["Pine St", "Room 1", "Luis"],
    ]);
  });

  it("strips a leading BOM", () => {
    const csv = "﻿Property,Unit,Tenant\nMaple Court,1A,Dana\n";
    const table = readCsvTable(csv);
    expect(table.headers).toEqual(["Property", "Unit", "Tenant"]);
    expect(table.rows[0].cells).toEqual(["Maple Court", "1A", "Dana"]);
  });

  it("skips a trailing Total/summary row and reports it in skippedRows", () => {
    const csv = [
      "Property,Unit,Tenant,Rent",
      "Maple Court,1A,Dana,1850",
      "Maple Court,1B,Marcus,1795",
      "Total,,,3645",
    ].join("\n");
    const table = readCsvTable(csv);
    expect(table.rows).toHaveLength(2);
    expect(table.skippedRows).toEqual([{ row: 4 }]);
  });

  it("skips blank rows", () => {
    const csv = "Property,Unit,Tenant\nMaple Court,1A,Dana\n\nMaple Court,1B,Marcus\n";
    const table = readCsvTable(csv);
    expect(table.rows).toHaveLength(2);
    expect(table.skippedRows).toEqual([{ row: 3 }]);
  });

  it("finds a header row after preamble lines", () => {
    const csv = ["Portfolio Export", "Generated 2026-09-14", "Property,Unit,Tenant", "Maple Court,1A,Dana"].join("\n");
    const table = readCsvTable(csv);
    expect(table.headers).toEqual(["Property", "Unit", "Tenant"]);
    expect(table.rows).toHaveLength(1);
    expect(table.rows[0].source).toEqual({ row: 4 });
  });

  it("throws PortfolioImportRowLimitError over the row cap", () => {
    const header = "Property,Unit,Tenant";
    const rows = Array.from({ length: PORTFOLIO_IMPORT_MAX_ROWS + 1 }, (_, i) => `Maple Court,${i},Dana`);
    const csv = [header, ...rows].join("\n");
    expect(() => readCsvTable(csv)).toThrow(PortfolioImportRowLimitError);
  });

  it("throws PortfolioImportUnreadableError when no header row can be found", () => {
    const csv = "a,b\nc,d\n";
    expect(() => readCsvTable(csv)).toThrow(PortfolioImportUnreadableError);
  });
});

describe("readXlsxTable", () => {
  it("picks the sheet that looks most like a rent roll, ties -> first sheet", () => {
    const bytes = readFileSync(path.join(fixturesDir, "buildium-rent-roll.xlsx"));
    const table = readXlsxTable(bytes);
    expect(table.sheet).toBe("Rent Roll");
    expect(table.headers).toContain("Tenants");
    expect(table.rows.length).toBeGreaterThan(0);
  });

  it("reads dates as display text, never Excel serial numbers", () => {
    const bytes = readFileSync(path.join(fixturesDir, "buildium-rent-roll.xlsx"));
    const table = readXlsxTable(bytes);
    const leaseStartIdx = table.headers.indexOf("Lease Start");
    const danaRow = table.rows.find((r) => r.cells[table.headers.indexOf("Email")] === "dana.w@gmail.com");
    expect(danaRow?.cells[leaseStartIdx]).toBe("2026-03-01");
  });
});

describe("readSpreadsheetTable", () => {
  it("dispatches csv by extension", () => {
    const bytes = readFileSync(path.join(fixturesDir, "appfolio-rent-roll.csv"));
    const { sourceKind, table } = readSpreadsheetTable({ bytes, fileName: "appfolio-rent-roll.csv" });
    expect(sourceKind).toBe("csv");
    expect(table.headers[0]).toBe("Property");
  });

  it("dispatches xlsx by extension", () => {
    const bytes = readFileSync(path.join(fixturesDir, "buildium-rent-roll.xlsx"));
    const { sourceKind, table } = readSpreadsheetTable({ bytes, fileName: "buildium-rent-roll.xlsx" });
    expect(sourceKind).toBe("xlsx");
    expect(table.headers).toContain("Tenants");
  });

  it("dispatches xlsx by media type even with a misleading extension", () => {
    const bytes = readFileSync(path.join(fixturesDir, "buildium-rent-roll.xlsx"));
    const { sourceKind } = readSpreadsheetTable({
      bytes,
      fileName: "export.bin",
      mediaType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    });
    expect(sourceKind).toBe("xlsx");
  });

  it("rejects a pdf extension with PortfolioImportUnreadableError", () => {
    const bytes = new TextEncoder().encode("%PDF-1.4");
    expect(() => readSpreadsheetTable({ bytes, fileName: "rent-roll.pdf" })).toThrow(PortfolioImportUnreadableError);
  });
});
