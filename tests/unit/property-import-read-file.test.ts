/**
 * Property import — the file reader hands the model plain, row-numbered
 * grids and never interprets a value. Every fixture shape opens; the caps
 * refuse loudly with the reason a manager can act on.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  PropertyImportFileError,
  readPropertyImportFile,
  renderSourceForModel,
  sourceKindFor,
} from "@/lib/property-import/read-file.server";
import { PROPERTY_IMPORT_MAX_ROWS } from "@/lib/property-import/types";

const FIXTURES = path.join(process.cwd(), "tests/fixtures/portfolio-import");
const bytes = (name: string) => new Uint8Array(readFileSync(path.join(FIXTURES, name)));

describe("sourceKindFor", () => {
  it("classifies by extension first, then media type", () => {
    expect(sourceKindFor("Copy of Sales.xlsx", "")).toBe("xlsx");
    expect(sourceKindFor("roll.CSV", "")).toBe("csv");
    expect(sourceKindFor("roll.pdf", "")).toBe("pdf");
    expect(sourceKindFor("blob", "application/vnd.ms-excel")).toBe("xlsx");
    expect(sourceKindFor("photo.png", "image/png")).toBeNull();
  });
});

describe("readPropertyImportFile", () => {
  it("reads an AppFolio csv into one row-numbered sheet with the header row kept", async () => {
    const src = await readPropertyImportFile({ bytes: bytes("appfolio-rent-roll.csv"), fileName: "appfolio-rent-roll.csv", mediaType: "text/csv" });
    expect(src.kind).toBe("csv");
    expect(src.sheets).toHaveLength(1);
    const [sheet] = src.sheets;
    expect(sheet!.rows[0]!.row).toBe(1);
    expect(sheet!.rows[0]!.cells[0]).toBe("Property");
    expect(sheet!.rows[1]!.cells).toContain("220 Maple Ave");
    expect(src.rowsRead).toBe(sheet!.rows.length);
    expect(src.truncatedNote).toBeNull();
    const rendered = renderSourceForModel(src);
    expect(rendered).toContain("=== SHEET:");
    expect(rendered).toContain("\n2\tMaple Court\t220 Maple Ave");
  });

  it("reads a Buildium workbook sheet by sheet and keeps numbers as plain digits", async () => {
    const src = await readPropertyImportFile({ bytes: bytes("buildium-rent-roll.xlsx"), fileName: "buildium-rent-roll.xlsx", mediaType: "" });
    expect(src.kind).toBe("xlsx");
    expect(src.sheets.length).toBeGreaterThan(0);
    const all = src.sheets.flatMap((s) => s.rows.flatMap((r) => r.cells));
    expect(all).toContain("220 Maple Ave");
    expect(all.some((c) => /^\d{3,4}$/.test(c))).toBe(true);
  });

  it("reads a pdf with text into page-tagged lines", async () => {
    const src = await readPropertyImportFile({ bytes: bytes("rent-roll.pdf"), fileName: "rent-roll.pdf", mediaType: "application/pdf" });
    expect(src.kind).toBe("pdf");
    expect(src.pages.length).toBeGreaterThan(0);
    expect(src.sheets[0]!.rows[0]!.cells[0]).toMatch(/^p1: /);
  });

  it("refuses a text-less scan with the export advice", async () => {
    await expect(
      readPropertyImportFile({ bytes: bytes("scan-no-text.pdf"), fileName: "scan-no-text.pdf", mediaType: "application/pdf" }),
    ).rejects.toMatchObject({ code: "unreadable", message: expect.stringContaining("scan") });
  });

  it("refuses an unsupported type, an empty file and an oversize file by code", async () => {
    await expect(readPropertyImportFile({ bytes: new Uint8Array([1]), fileName: "x.png", mediaType: "image/png" })).rejects.toMatchObject({ code: "unsupported" });
    await expect(readPropertyImportFile({ bytes: new Uint8Array(), fileName: "x.csv", mediaType: "" })).rejects.toMatchObject({ code: "empty" });
    const big = new Uint8Array(5 * 1024 * 1024 + 1);
    await expect(readPropertyImportFile({ bytes: big, fileName: "x.csv", mediaType: "" })).rejects.toBeInstanceOf(PropertyImportFileError);
  });

  it("drops empty rows and trailing empty columns but keeps the file's row numbers", async () => {
    const csv = "Address,Rent,,\n,,,\n400 Pike St,1200,,\n\n1412 Pine St,,,\n";
    const src = await readPropertyImportFile({ bytes: new TextEncoder().encode(csv), fileName: "sheet.csv", mediaType: "text/csv" });
    const rows = src.sheets[0]!.rows;
    expect(rows.map((r) => r.row)).toEqual([1, 3, 5]);
    expect(rows[1]!.cells).toEqual(["400 Pike St", "1200"]);
  });

  it("caps the rows read across sheets and names the sheet that was cut", async () => {
    const lines = ["Address,Rent"];
    for (let i = 0; i < PROPERTY_IMPORT_MAX_ROWS + 50; i += 1) lines.push(`${i} Main St,${1000 + i}`);
    const src = await readPropertyImportFile({ bytes: new TextEncoder().encode(lines.join("\n")), fileName: "big.csv", mediaType: "text/csv" });
    expect(src.rowsRead).toBe(PROPERTY_IMPORT_MAX_ROWS);
    expect(src.truncatedNote).toContain("was cut after row");
  });
});
