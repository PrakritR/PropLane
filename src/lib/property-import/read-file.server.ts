import "server-only";

/**
 * Property import — file bytes to plain cell grids.
 *
 * No interpretation happens here. A workbook becomes one grid per sheet, a
 * csv becomes one grid, a pdf becomes page text. Empty rows and columns are
 * dropped, every kept row remembers its 1-based row number so the model can
 * cite it, and the whole file is capped at `PROPERTY_IMPORT_MAX_ROWS` rows
 * so a giant export names which sheet was cut instead of timing out.
 */

import * as XLSX from "xlsx";
import { extractText, getDocumentProxy } from "unpdf";
import {
  PROPERTY_IMPORT_MAX_BYTES,
  PROPERTY_IMPORT_MAX_ROWS,
  type PropertyImportSourceKind,
} from "@/lib/property-import/types";

export class PropertyImportFileError extends Error {
  code: "unreadable" | "empty" | "too_large" | "unsupported";
  constructor(code: PropertyImportFileError["code"], message: string) {
    super(message);
    this.name = "PropertyImportFileError";
    this.code = code;
  }
}

export type PropertyImportSheet = {
  name: string;
  /** Each kept row: its 1-based row number in the sheet and its cells as strings. */
  rows: { row: number; cells: string[] }[];
};

export type PropertyImportSource = {
  kind: PropertyImportSourceKind;
  fileName: string;
  sheets: PropertyImportSheet[];
  /** pdf only — page-tagged text. */
  pages: string[];
  rowsRead: number;
  truncatedNote: string | null;
};

const CSV_TYPES = new Set(["text/csv", "application/csv", "text/plain"]);
const XLSX_TYPES = new Set([
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-excel",
  "application/vnd.oasis.opendocument.spreadsheet",
]);

export function sourceKindFor(fileName: string, mediaType: string): PropertyImportSourceKind | null {
  const name = fileName.toLowerCase();
  if (name.endsWith(".pdf") || mediaType === "application/pdf") return "pdf";
  if (name.endsWith(".csv") || name.endsWith(".tsv") || name.endsWith(".txt") || CSV_TYPES.has(mediaType)) return "csv";
  if (/\.(xlsx|xlsm|xls|ods|numbers)$/.test(name) || XLSX_TYPES.has(mediaType)) return "xlsx";
  return null;
}

function cellText(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "number") return Number.isInteger(value) ? String(value) : String(Math.round(value * 100) / 100);
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).replace(/\s+/g, " ").trim();
}

/** Drop trailing empty columns and every all-empty row; keep row numbers. */
function gridToSheet(name: string, grid: unknown[][]): PropertyImportSheet {
  let width = 0;
  const rows = grid.map((r, i) => ({ row: i + 1, cells: (r ?? []).map(cellText) }));
  for (const r of rows) {
    let last = -1;
    for (let i = 0; i < r.cells.length; i += 1) if (r.cells[i] !== "") last = i;
    width = Math.max(width, last + 1);
  }
  return {
    name,
    rows: rows
      .map((r) => ({ row: r.row, cells: r.cells.slice(0, width) }))
      .filter((r) => r.cells.some((c) => c !== "")),
  };
}

function workbookToSheets(workbook: XLSX.WorkBook): PropertyImportSheet[] {
  return workbook.SheetNames.map((name) => {
    const ws = workbook.Sheets[name];
    if (!ws) return { name, rows: [] };
    const grid = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, raw: true, defval: "" });
    return gridToSheet(name, grid);
  }).filter((s) => s.rows.length > 0);
}

/** Enforce the row cap across sheets in order, naming the sheet that was cut. */
function capRows(sheets: PropertyImportSheet[]): { sheets: PropertyImportSheet[]; rowsRead: number; truncatedNote: string | null } {
  let budget = PROPERTY_IMPORT_MAX_ROWS;
  let truncatedNote: string | null = null;
  const kept: PropertyImportSheet[] = [];
  for (const sheet of sheets) {
    if (budget <= 0) {
      truncatedNote ??= `Stopped before sheet "${sheet.name}" — the first ${PROPERTY_IMPORT_MAX_ROWS.toLocaleString("en-US")} rows were read.`;
      break;
    }
    if (sheet.rows.length > budget) {
      kept.push({ name: sheet.name, rows: sheet.rows.slice(0, budget) });
      truncatedNote = `Sheet "${sheet.name}" was cut after row ${sheet.rows[budget - 1]!.row} — the first ${PROPERTY_IMPORT_MAX_ROWS.toLocaleString("en-US")} rows of the file were read.`;
      budget = 0;
      continue;
    }
    kept.push(sheet);
    budget -= sheet.rows.length;
  }
  return { sheets: kept, rowsRead: kept.reduce((n, s) => n + s.rows.length, 0), truncatedNote };
}

export async function readPropertyImportFile(input: {
  bytes: Uint8Array;
  fileName: string;
  mediaType: string;
}): Promise<PropertyImportSource> {
  if (input.bytes.byteLength > PROPERTY_IMPORT_MAX_BYTES) {
    throw new PropertyImportFileError("too_large", "That file is over 5 MB. Export a smaller sheet, or split it.");
  }
  if (input.bytes.byteLength === 0) {
    throw new PropertyImportFileError("empty", "That file is empty.");
  }
  const kind = sourceKindFor(input.fileName, input.mediaType);
  if (!kind) {
    throw new PropertyImportFileError("unsupported", "Use a .xlsx, .xls, .csv or .pdf file.");
  }

  if (kind === "pdf") {
    let pages: string[];
    try {
      const pdf = await getDocumentProxy(new Uint8Array(input.bytes));
      const { text } = await extractText(pdf);
      pages = (Array.isArray(text) ? text : [String(text ?? "")]).map((p) => String(p ?? "").replace(/[ \t]+/g, " ").trim());
    } catch {
      throw new PropertyImportFileError("unreadable", "Couldn't open that PDF.");
    }
    const characters = pages.reduce((n, p) => n + p.length, 0);
    if (characters < 40) {
      throw new PropertyImportFileError(
        "unreadable",
        "That PDF has no readable text — it looks like a scan. Export the rent roll from your software as a spreadsheet or PDF with text.",
      );
    }
    // Page text is treated as one "sheet" of lines so the model cites line numbers.
    const lines = pages.flatMap((p, pi) => p.split("\n").map((l) => l.trim()).filter(Boolean).map((l) => `p${pi + 1}: ${l}`));
    const sheet: PropertyImportSheet = { name: "Document", rows: lines.map((l, i) => ({ row: i + 1, cells: [l] })) };
    const capped = capRows([sheet]);
    return { kind, fileName: input.fileName, sheets: capped.sheets, pages, rowsRead: capped.rowsRead, truncatedNote: capped.truncatedNote };
  }

  let workbook: XLSX.WorkBook;
  try {
    workbook =
      kind === "csv"
        ? XLSX.read(new TextDecoder("utf-8").decode(input.bytes), { type: "string", raw: true })
        : XLSX.read(input.bytes, { type: "array", cellDates: true });
  } catch {
    throw new PropertyImportFileError("unreadable", "Couldn't open that spreadsheet. Save it as .xlsx or .csv and try again.");
  }
  const sheets = workbookToSheets(workbook);
  if (sheets.length === 0) {
    throw new PropertyImportFileError("empty", "That spreadsheet has no filled cells.");
  }
  const capped = capRows(sheets);
  return { kind, fileName: input.fileName, sheets: capped.sheets, pages: [], rowsRead: capped.rowsRead, truncatedNote: capped.truncatedNote };
}

/**
 * The text the model reads: every sheet, every kept row, tab-separated, with
 * its row number in front. Row numbers are the only thing the model is asked
 * to echo back, so a citation can always be checked against the file.
 */
export function renderSourceForModel(source: PropertyImportSource): string {
  return source.sheets
    .map((sheet) => {
      const body = sheet.rows.map((r) => `${r.row}\t${r.cells.join("\t")}`).join("\n");
      return `=== SHEET: ${sheet.name} (${sheet.rows.length} rows) ===\n${body}`;
    })
    .join("\n\n");
}
