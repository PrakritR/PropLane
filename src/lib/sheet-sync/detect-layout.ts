import { parseSheetDate } from "@/lib/sheet-sync/dates";
import { findStaysTableHeaderRow } from "@/lib/sheet-sync/parse-stays-table";

export type SheetTabLayout = "occupancy" | "stays" | "unknown";

/**
 * Does any row in the first 10 read as a day-by-day date header — at least
 * two cells that parse as dates? Mirrors `parse-occupancy.ts`'s own
 * `findDateHeader` bound (same file does not export it, so this stays a
 * lightweight, independent check rather than reaching into that module's
 * internals) — used only to tell a grid tab from a stays tab, never to parse
 * the grid itself.
 */
/**
 * A real occupancy-grid header carries a date across most of the row (one
 * column per day). The threshold is 3, not 2 — a single stays-table DATA row
 * already has two date cells of its own (check-in, check-out), which would
 * otherwise misread as a date header on a sheet that is actually a stays
 * table with no separate header match.
 */
function hasDateHeaderRow(rows: string[][], asOf?: string): boolean {
  const scanLimit = Math.min(rows.length, 10);
  for (let r = 0; r < scanLimit; r++) {
    const row = rows[r] ?? [];
    let dateCells = 0;
    for (const cell of row) {
      if (parseSheetDate(cell, asOf)) dateCells += 1;
      if (dateCells >= 3) return true;
    }
  }
  return false;
}

/**
 * Which shape a sheet tab is in, so the same "link a spreadsheet" flow can
 * read either without a manager having to say so up front (BUILD-WAVE2
 * C210's Build tab: "Tells a stays table from the existing occupancy grid by
 * the header, so existing grid links keep working exactly as today"). A day
 * header wins ties — an occupancy grid can carry stray text in a "Room"-ish
 * cell that would otherwise look like a stays-table header.
 */
export function detectSheetLayout(rows: string[][], asOf?: string): SheetTabLayout {
  // An explicit, named stays header ("Property", "Guest", "Check-in",
  // "Check-out") is a stronger signal than "some row has a few date-looking
  // cells" — a stays table's own DATA rows can incidentally contain two or
  // more dates (its check-in and check-out columns), so check for the named
  // header first.
  if (findStaysTableHeaderRow(rows) != null) return "stays";
  if (hasDateHeaderRow(rows, asOf)) return "occupancy";
  return "unknown";
}
