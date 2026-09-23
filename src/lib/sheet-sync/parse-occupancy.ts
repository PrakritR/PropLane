import { cellText } from "@/lib/sheet-sync/csv";
import { parseSheetDate } from "@/lib/sheet-sync/dates";
import { inferOccupancyHouseKey, parseRoomNumber } from "@/lib/sheet-sync/house-key";

export type OccupancyChannel = "Airbnb" | "Booking";

export type OccupancyGuest = {
  name: string;
  channel: OccupancyChannel | null;
};

export type OccupancyStay = {
  houseKey: string;
  roomNumber: number;
  name: string;
  channel: OccupancyChannel | null;
  /** Inclusive first night. */
  start: string;
  /** Inclusive last night. */
  end: string;
};

const SKIP_NAMES = new Set(["", "-", "—", "vacant", "empty", "open", "available", "n/a", "na", "none"]);

/**
 * Residents-tab guest cells: `Grace`, `Airbnb Ved`, `Vinod Booking`.
 * A bare `Airbnb` is a vacant short-stay flag, not a guest.
 */
export function parseOccupancyGuest(raw: string): OccupancyGuest | null {
  const text = cellText(raw);
  if (SKIP_NAMES.has(text.toLowerCase())) return null;

  const airbnbOnly = /^airbnb$/i.exec(text);
  if (airbnbOnly) return null;

  const airbnbNamed = /^airbnb\s+(.+)$/i.exec(text);
  if (airbnbNamed) {
    const name = cellText(airbnbNamed[1]!);
    return name ? { name, channel: "Airbnb" } : null;
  }

  const bookingPrefix = /^booking(?:\.com)?\s+(.+)$/i.exec(text);
  if (bookingPrefix) {
    const name = cellText(bookingPrefix[1]!);
    return name ? { name, channel: "Booking" } : null;
  }

  const bookingSuffix = /^(.+?)\s+booking(?:\.com)?$/i.exec(text);
  if (bookingSuffix) {
    const name = cellText(bookingSuffix[1]!);
    return name ? { name, channel: "Booking" } : null;
  }

  return { name: text, channel: null };
}

function findDateHeader(rows: string[][], asOf: string): { rowIndex: number; dates: Map<number, string> } | null {
  let best: { rowIndex: number; dates: Map<number, string> } | null = null;
  rows.forEach((row, rowIndex) => {
    const dates = new Map<number, string>();
    row.forEach((cell, col) => {
      const iso = parseSheetDate(cell, asOf);
      if (iso) dates.set(col, iso);
    });
    if (dates.size >= 2 && (!best || dates.size > best.dates.size)) {
      best = { rowIndex, dates };
    }
  });
  return best;
}

function guestKey(guest: OccupancyGuest): string {
  return `${guest.channel ?? ""}:${guest.name.toLowerCase()}`;
}

/**
 * Residents occupancy grid: dates across the header, house label + Room N
 * down the left, guest names in the body. Merged house labels carry forward.
 */
export function parseOccupancyGrid(rows: string[][], asOf?: string): OccupancyStay[] {
  const header = findDateHeader(rows, asOf ?? "2026-09-22");
  if (!header) return [];
  const dateCols = [...header.dates.entries()].sort((a, b) => a[0] - b[0]);
  const stays: OccupancyStay[] = [];
  let houseKey: string | null = null;

  for (let r = header.rowIndex + 1; r < rows.length; r++) {
    const row = rows[r] ?? [];
    const lead = row.slice(0, Math.min(4, dateCols[0]?.[0] ?? 4));
    houseKey = inferOccupancyHouseKey(lead, houseKey);
    const roomNumber = lead.map(parseRoomNumber).find((n) => n != null) ?? null;
    if (!houseKey || !roomNumber) continue;

    let run: { guest: OccupancyGuest; start: string; end: string } | null = null;
    const flush = () => {
      if (!run || !houseKey || !roomNumber) return;
      stays.push({
        houseKey,
        roomNumber,
        name: run.guest.name,
        channel: run.guest.channel,
        start: run.start,
        end: run.end,
      });
      run = null;
    };

    for (const [col, iso] of dateCols) {
      const guest = parseOccupancyGuest(row[col] ?? "");
      if (!guest) {
        flush();
        continue;
      }
      if (run && guestKey(run.guest) === guestKey(guest)) {
        run.end = iso;
        continue;
      }
      flush();
      run = { guest, start: iso, end: iso };
    }
    flush();
  }

  return stays;
}

export function occupancyStayKey(stay: OccupancyStay): string {
  return `${stay.houseKey}:${stay.roomNumber}:${stay.start}:${stay.end}:${stay.name.toLowerCase()}:${stay.channel ?? ""}`;
}
