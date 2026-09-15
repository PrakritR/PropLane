import "server-only";

/**
 * Portfolio import — csv and xlsx readers.
 *
 * Both readers hand back the same `PortfolioImportSourceTable`: a header row
 * and cells as strings, each row tagged with where it came from. They never
 * interpret values — money, dates, grouping all happen once, in
 * `build-draft.ts`. That split is what lets `build-draft.ts` stay isomorphic
 * and unit-testable without a file at all.
 */

import * as XLSX from "xlsx";
import { mapPortfolioImportHeaders } from "@/lib/portfolio-import/column-map";
import { PortfolioImportRowLimitError, PortfolioImportUnreadableError } from "@/lib/portfolio-import/errors";
import {
  PORTFOLIO_IMPORT_MAX_ROWS,
  type PortfolioImportCanonicalKey,
  type PortfolioImportSourceRef,
  type PortfolioImportSourceTable,
} from "@/lib/portfolio-import/types";

const SUMMARY_ROW_RE = /^(total|totals|grand total|subtotal|sum)\b/i;

/** Columns whose absence (while a money column is filled) marks a summary row. */
const TEXT_KEYS = new Set<PortfolioImportCanonicalKey>([
  "propertyName",
  "address",
  "unitLabel",
  "residentName",
]);
const MONEY_KEYS = new Set<PortfolioImportCanonicalKey>(["monthlyRent", "securityDeposit", "balance"]);

function cell(row: string[] | undefined, index: number): string {
  const value = row?.[index];
  return value === undefined || value === null ? "" : String(value);
}

function nonEmptyCount(row: string[]): number {
  let count = 0;
  for (const c of row) if ((c ?? "").trim() !== "") count += 1;
  return count;
}

function isRowEmpty(row: string[]): boolean {
  return row.every((c) => (c ?? "").trim() === "");
}

/**
 * Shared table builder: find the header row (first row with >= 3 filled
 * cells), drop preamble/blank/summary rows, enforce the row cap.
 */
function buildSourceTableFromRows(rows: string[][], sheet: string | undefined): PortfolioImportSourceTable {
  const headerIdx = rows.findIndex((r) => nonEmptyCount(r) >= 3);
  if (headerIdx === -1) {
    throw new PortfolioImportUnreadableError(
      "Couldn't find a header row — the file needs at least one row with 3 or more filled columns.",
    );
  }

  const headers = rows[headerIdx].map((h) => (h ?? "").trim());
  const dataRows = rows.slice(headerIdx + 1);
  if (dataRows.length > PORTFOLIO_IMPORT_MAX_ROWS) {
    throw new PortfolioImportRowLimitError(dataRows.length);
  }

  // Light-weight header mapping, used only to tell "text" columns from
  // "money" columns for the summary-row heuristic below.
  const mapping = mapPortfolioImportHeaders(headers, dataRows.slice(0, 5)).columns;
  const textIdx = mapping.filter((c) => c.key && TEXT_KEYS.has(c.key)).map((c) => c.index);
  const moneyIdx = mapping.filter((c) => c.key && MONEY_KEYS.has(c.key)).map((c) => c.index);

  const skippedRows: PortfolioImportSourceRef[] = [];
  for (let i = 0; i < headerIdx; i++) {
    skippedRows.push(sheet ? { row: i + 1, sheet } : { row: i + 1 });
  }

  const outRows: PortfolioImportSourceTable["rows"] = [];
  dataRows.forEach((row, i) => {
    const rowNumber = headerIdx + 2 + i;
    const source: PortfolioImportSourceRef = sheet ? { row: rowNumber, sheet } : { row: rowNumber };

    if (isRowEmpty(row)) {
      skippedRows.push(source);
      return;
    }
    const firstCell = cell(row, 0).trim();
    if (SUMMARY_ROW_RE.test(firstCell)) {
      skippedRows.push(source);
      return;
    }
    const textFilled = textIdx.some((idx) => cell(row, idx).trim() !== "");
    const moneyFilled = moneyIdx.some((idx) => cell(row, idx).trim() !== "");
    if (textIdx.length > 0 && !textFilled && moneyFilled) {
      skippedRows.push(source);
      return;
    }

    outRows.push({ cells: headers.map((_, idx) => cell(row, idx)), source });
  });

  return { sheet, headers, rows: outRows, skippedRows };
}

/** RFC 4180: quoted fields, doubled quotes, CRLF/LF, a leading BOM. */
function parseCsvRows(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  const n = text.length;
  let i = 0;

  while (i < n) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      field += c;
      i++;
      continue;
    }

    if (c === '"') {
      inQuotes = true;
      i++;
      continue;
    }
    if (c === ",") {
      row.push(field);
      field = "";
      i++;
      continue;
    }
    if (c === "\r") {
      if (text[i + 1] === "\n") i++;
      row.push(field);
      field = "";
      rows.push(row);
      row = [];
      i++;
      continue;
    }
    if (c === "\n") {
      row.push(field);
      field = "";
      rows.push(row);
      row = [];
      i++;
      continue;
    }
    field += c;
    i++;
  }

  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

export function readCsvTable(text: string): PortfolioImportSourceTable {
  const stripped = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const rows = parseCsvRows(stripped);
  return buildSourceTableFromRows(rows, undefined);
}

export function readXlsxTable(bytes: Uint8Array | ArrayBuffer): PortfolioImportSourceTable {
  let workbook: XLSX.WorkBook;
  try {
    const data = bytes instanceof ArrayBuffer ? new Uint8Array(bytes) : bytes;
    workbook = XLSX.read(data, { type: "array" });
  } catch (err) {
    throw new PortfolioImportUnreadableError(
      `Couldn't read the spreadsheet: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (workbook.SheetNames.length === 0) {
    throw new PortfolioImportUnreadableError("The spreadsheet has no sheets.");
  }

  let bestSheet = workbook.SheetNames[0];
  let bestScore = -1;
  let bestRows: string[][] = [];

  for (const name of workbook.SheetNames) {
    const worksheet = workbook.Sheets[name];
    if (!worksheet) continue;
    const raw = XLSX.utils.sheet_to_json<unknown[]>(worksheet, { header: 1, raw: false, defval: "" });
    const rows = raw.map((r) =>
      Array.isArray(r) ? r.map((c) => (c === null || c === undefined ? "" : String(c))) : [],
    );
    const firstNonEmptyIdx = rows.findIndex((r) => nonEmptyCount(r) > 0);
    const score =
      firstNonEmptyIdx === -1
        ? 0
        : mapPortfolioImportHeaders(
            rows[firstNonEmptyIdx].map((h) => h.trim()),
            rows.slice(firstNonEmptyIdx + 1, firstNonEmptyIdx + 6),
          ).columns.filter((c) => c.key !== null).length;

    if (score > bestScore) {
      bestScore = score;
      bestSheet = name;
      bestRows = rows;
    }
  }

  return buildSourceTableFromRows(bestRows, bestSheet);
}

export function readSpreadsheetTable(input: {
  bytes: Uint8Array;
  fileName: string;
  mediaType?: string;
}): { table: PortfolioImportSourceTable; sourceKind: "csv" | "xlsx" } {
  const ext = (input.fileName.split(".").pop() ?? "").toLowerCase();
  const mediaType = (input.mediaType ?? "").toLowerCase();

  const isXlsx =
    ext === "xlsx" ||
    ext === "xls" ||
    mediaType.includes("spreadsheetml") ||
    mediaType === "application/vnd.ms-excel";

  if (isXlsx) {
    return { table: readXlsxTable(input.bytes), sourceKind: "xlsx" };
  }

  if (ext === "pdf" || mediaType === "application/pdf") {
    throw new PortfolioImportUnreadableError(
      "This looks like a PDF rent roll — use the PDF import path instead of the spreadsheet reader.",
    );
  }

  // Anything else — csv, txt, or no extension/media type at all — is read as
  // delimited text. A pasted rent roll rarely arrives with a clean media type.
  const text = new TextDecoder("utf-8").decode(input.bytes);
  return { table: readCsvTable(text), sourceKind: "csv" };
}
