import { cellText } from "@/lib/sheet-sync/csv";
import { parseSheetDate } from "@/lib/sheet-sync/dates";
import { inferHouseKey } from "@/lib/sheet-sync/house-key";

/**
 * A one-row-per-stay tab (BUILD-WAVE2 C210/C213), the shape a manager's own
 * booking log usually takes — unlike `parse-occupancy.ts`'s day-by-day grid,
 * which is what the sheet import understood before this file existed.
 *
 * `channel` is read from the sheet's own words (its header calls it "Source"
 * or "Channel") rather than squeezed into the grid reader's Airbnb/Booking
 * pair — a manager's own long-stay tenants are real rows here, not a stay the
 * import silently drops (captain decision, BUILD-WAVE2 C213: import every
 * row, with the sheet's own word as the channel).
 */
export type StaysTableChannel = "Airbnb" | "Booking" | "Tenant" | "Direct" | "Other";

export type StaysTableStay = {
  houseKey: string;
  /** The sheet's own text for the house, kept for an unmatched-name prompt. */
  houseRaw: string;
  roomNumber: number | null;
  name: string;
  channel: StaysTableChannel;
  /** Inclusive first night. */
  start: string;
  /** Inclusive last night, or "" when the sheet left check-out blank (open-ended). */
  end: string;
  /** Every column this reader did not map to a known field, folded into one note. */
  notes: string;
};

export type StaysTableColumnKey = "property" | "room" | "guest" | "checkIn" | "checkOut" | "source";

export type StaysTableColumnMap = {
  property: number | null;
  room: number | null;
  guest: number | null;
  checkIn: number | null;
  checkOut: number | null;
  source: number | null;
  /** Every other column with a header, folded into `notes` on each row. */
  extras: number[];
};

const HEADER_PATTERNS: Record<StaysTableColumnKey, RegExp> = {
  property: /^(property|house|home|listing|building)/i,
  room: /^room/i,
  guest: /^(guest|name|resident|tenant)/i,
  checkIn: /^(check[\s-]?in|arrival|start|move[\s-]?in)/i,
  checkOut: /^(check[\s-]?out|departure|end|move[\s-]?out)/i,
  source: /^(source|channel|platform)/i,
};

const EMPTY_COLUMN_MAP: StaysTableColumnMap = {
  property: null,
  room: null,
  guest: null,
  checkIn: null,
  checkOut: null,
  source: null,
  extras: [],
};

/**
 * Which row (if any) reads as a stays-table header — every required column
 * (property, guest, check-in, check-out) matched by name, in any order.
 * Scans the first 10 rows, same bound `parse-occupancy.ts` uses for its own
 * date-header search, so a title row or two above the header is tolerated.
 */
export function findStaysTableHeaderRow(rows: string[][]): number | null {
  const scanLimit = Math.min(rows.length, 10);
  for (let r = 0; r < scanLimit; r++) {
    const map = detectStaysTableColumns(rows[r] ?? []);
    if (map.property != null && map.guest != null && map.checkIn != null && map.checkOut != null) return r;
  }
  return null;
}

/** Match a header row's cells to known stays-table columns by name. */
export function detectStaysTableColumns(headerRow: string[]): StaysTableColumnMap {
  const map: StaysTableColumnMap = { ...EMPTY_COLUMN_MAP, extras: [] };
  const matchedKeys = new Set<StaysTableColumnKey>();
  headerRow.forEach((raw, col) => {
    const text = cellText(raw);
    if (!text) return;
    for (const key of Object.keys(HEADER_PATTERNS) as StaysTableColumnKey[]) {
      if (matchedKeys.has(key)) continue;
      if (HEADER_PATTERNS[key].test(text)) {
        map[key] = col;
        matchedKeys.add(key);
        return;
      }
    }
    map.extras.push(col);
  });
  return map;
}

function normalizeChannel(raw: string): StaysTableChannel {
  const text = cellText(raw).toLowerCase();
  if (!text) return "Other";
  if (text.includes("airbnb")) return "Airbnb";
  if (text.includes("booking")) return "Booking";
  if (text.includes("tenant") || text.includes("lease")) return "Tenant";
  if (text.includes("direct")) return "Direct";
  return "Other";
}

/**
 * Reads a one-row-per-stay tab into {@link StaysTableStay}s. `columnMap`
 * overrides auto-detection (a manager's own match from the preview screen);
 * omit it to auto-detect from the sheet's own header row.
 */
export function parseStaysTable(
  rows: string[][],
  asOf?: string,
  columnMap?: StaysTableColumnMap,
): { stays: StaysTableStay[]; columnMap: StaysTableColumnMap; headerRowIndex: number | null; skipped: number } {
  const headerRowIndex = columnMap ? -1 : findStaysTableHeaderRow(rows);
  const map = columnMap ?? (headerRowIndex != null ? detectStaysTableColumns(rows[headerRowIndex] ?? []) : EMPTY_COLUMN_MAP);
  if (map.property == null || map.guest == null || map.checkIn == null || map.checkOut == null) {
    return { stays: [], columnMap: map, headerRowIndex, skipped: 0 };
  }

  const stays: StaysTableStay[] = [];
  let skipped = 0;
  const startRow = columnMap ? 0 : (headerRowIndex ?? -1) + 1;
  for (let r = startRow; r < rows.length; r++) {
    const row = rows[r] ?? [];
    const houseRaw = cellText(row[map.property] ?? "");
    const name = cellText(row[map.guest] ?? "");
    if (!houseRaw && !name) continue; // a blank spacer row
    const houseKey = inferHouseKey(houseRaw);
    const checkInRaw = cellText(row[map.checkIn] ?? "");
    const checkOutRaw = cellText(row[map.checkOut] ?? "");
    const start = parseSheetDate(checkInRaw, asOf);
    if (!houseKey || !name || !start) {
      skipped += 1;
      continue;
    }
    const end = checkOutRaw ? parseSheetDate(checkOutRaw, asOf) : "";
    if (checkOutRaw && !end) {
      // A check-out cell that has text but does not parse as a date is a bad
      // row, not an open-ended stay — an actually-blank cell is open-ended.
      skipped += 1;
      continue;
    }
    const roomRaw = map.room != null ? cellText(row[map.room] ?? "") : "";
    const roomNumber = roomRaw ? Number(roomRaw.replace(/^room\s*/i, "")) || null : null;
    const channel = map.source != null ? normalizeChannel(row[map.source] ?? "") : "Other";
    const notes = map.extras
      .map((col) => cellText(row[col] ?? ""))
      .filter(Boolean)
      .join(" · ");
    stays.push({ houseKey, houseRaw, roomNumber, name, channel, start, end: end || "", notes });
  }
  return { stays, columnMap: map, headerRowIndex, skipped };
}
