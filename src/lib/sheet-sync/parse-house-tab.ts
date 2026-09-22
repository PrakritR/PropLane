import { cellText, compactKey } from "@/lib/sheet-sync/csv";
import { looksLikePhone, parseMoneyDollars, parseSheetDate } from "@/lib/sheet-sync/dates";
import { inferHouseKey, parseRoomNumber } from "@/lib/sheet-sync/house-key";

export type HouseAccessCodes = {
  doorCode: string;
  gateCode: string;
  backGateCode: string;
  pantryCode: string;
  backupHouseCode: string;
  lockboxCode: string;
};

export type HouseRoomFact = {
  houseKey: string;
  roomNumber: number;
  name: string;
  phone: string;
  rentDollars: number | null;
  utilitiesDollars: number | null;
  depositDollars: number | null;
  doorCode: string;
  leaseStart: string | null;
  leaseEnd: string | null;
  monthToMonth: boolean;
  /** True when the roster name is the Airbnb placeholder, not a person. */
  airbnbPlaceholder: boolean;
};

export type ParsedHouseTab = {
  houseKey: string | null;
  title: string;
  access: HouseAccessCodes;
  rooms: HouseRoomFact[];
};

const ACCESS_LABELS: { key: keyof HouseAccessCodes; match: RegExp }[] = [
  { key: "gateCode", match: /front\s*gate/i },
  { key: "backGateCode", match: /back\s*gate/i },
  { key: "doorCode", match: /^(house|front\s*door)\s*code$/i },
  { key: "pantryCode", match: /pantry/i },
  { key: "backupHouseCode", match: /backup\s*house/i },
  { key: "lockboxCode", match: /(backup\s*)?lockbox/i },
];

const HEADER_ALIASES: Record<string, "room" | "name" | "phone" | "rent" | "utilities" | "deposit" | "doorCode" | "leaseStart" | "leaseEnd"> = {
  room: "room",
  rooms: "room",
  name: "name",
  phone: "phone",
  phonenumber: "phone",
  rent: "rent",
  utilities: "utilities",
  deposit: "deposit",
  doorcode: "doorCode",
  leasestart: "leaseStart",
  leasestarts: "leaseStart",
  leaseend: "leaseEnd",
  leaseends: "leaseEnd",
};

function emptyAccess(): HouseAccessCodes {
  return { doorCode: "", gateCode: "", backGateCode: "", pantryCode: "", backupHouseCode: "", lockboxCode: "" };
}

function headerKind(raw: string) {
  return HEADER_ALIASES[compactKey(raw)] ?? null;
}

function isMonthToMonth(raw: string): boolean {
  return /month\s*to\s*month/i.test(raw);
}

function adjacentValue(row: string[], col: number): string {
  const same = cellText(row[col] ?? "");
  const colon = same.split(":");
  if (colon.length > 1 && cellText(colon.slice(1).join(":"))) return cellText(colon.slice(1).join(":"));
  for (let i = col + 1; i < Math.min(row.length, col + 3); i++) {
    const next = cellText(row[i] ?? "");
    if (next) return next;
  }
  return "";
}

function matchAccessLabel(raw: string): keyof HouseAccessCodes | null {
  const text = cellText(raw);
  if (!text) return null;
  const compact = compactKey(text);
  if (compact === "housecode" || compact === "frontdoorcode") return "doorCode";
  if (compact === "frontgatecode") return "gateCode";
  if (compact === "backgatecode") return "backGateCode";
  if (compact === "pantrycode") return "pantryCode";
  if (compact === "backuphousecode") return "backupHouseCode";
  if (compact === "backuplockboxcode" || compact === "lockboxcode") return "lockboxCode";
  for (const spec of ACCESS_LABELS) {
    if (spec.match.test(text)) return spec.key;
  }
  return null;
}

function findRosterHeader(rows: string[][]): { rowIndex: number; columns: Partial<Record<ReturnType<typeof headerKind> & string, number>> } | null {
  for (let r = 0; r < rows.length; r++) {
    const columns: Record<string, number> = {};
    (rows[r] ?? []).forEach((cell, col) => {
      const kind = headerKind(cell);
      if (kind && columns[kind] == null) columns[kind] = col;
    });
    if (columns.name != null && (columns.phone != null || columns.rent != null || columns.doorCode != null)) {
      return { rowIndex: r, columns };
    }
  }
  return null;
}

function parseLeaseDate(raw: string, asOf?: string): string | null {
  if (isMonthToMonth(raw)) return null;
  return parseSheetDate(raw, asOf);
}

/**
 * Seattle house P&L tabs: left side is books (ignored), right side is the
 * room roster (Name / Phone / Rent / Utilities / lease / Door Code) plus
 * labeled Front Gate / House / Pantry / Lockbox codes anywhere on the grid.
 */
export function parseHouseTab(rows: string[][], title = "", asOf?: string): ParsedHouseTab {
  const access = emptyAccess();
  let houseKey = inferHouseKey(title);

  for (const row of rows) {
    row.forEach((cell, col) => {
      const label = matchAccessLabel(cell);
      if (!label) return;
      const value = adjacentValue(row, col);
      if (value && !access[label]) access[label] = value;
      if (!houseKey) houseKey = inferHouseKey(cell);
    });
  }

  const header = findRosterHeader(rows);
  const rooms: HouseRoomFact[] = [];
  if (header) {
    const cols = header.columns;
    for (let r = header.rowIndex + 1; r < rows.length; r++) {
      const row = rows[r] ?? [];
      const rawName = cols.name != null ? cellText(row[cols.name] ?? "") : "";
      const roomFromCol = cols.room != null ? parseRoomNumber(row[cols.room] ?? "") : null;
      const roomFromRow = row.map(parseRoomNumber).find((n) => n != null) ?? null;
      const roomNumber = roomFromCol ?? roomFromRow;
      if (!roomNumber) {
        if (!rawName && !row.some((c) => cellText(c))) break;
        continue;
      }
      if (!houseKey) {
        houseKey = row.map(inferHouseKey).find(Boolean) ?? houseKey;
      }
      const name = rawName;
      const airbnbPlaceholder = /^airbnb$/i.test(name);
      if (!name || airbnbPlaceholder) {
        rooms.push({
          houseKey: houseKey ?? "",
          roomNumber,
          name: airbnbPlaceholder ? "Airbnb" : "",
          phone: "",
          rentDollars: null,
          utilitiesDollars: null,
          depositDollars: null,
          doorCode: cols.doorCode != null ? cellText(row[cols.doorCode] ?? "") : "",
          leaseStart: null,
          leaseEnd: null,
          monthToMonth: false,
          airbnbPlaceholder: true,
        });
        continue;
      }
      if (looksLikePhone(name) || parseMoneyDollars(name)) continue;
      const phone = cols.phone != null ? cellText(row[cols.phone] ?? "") : "";
      const leaseEndRaw = cols.leaseEnd != null ? cellText(row[cols.leaseEnd] ?? "") : "";
      const leaseStartRaw = cols.leaseStart != null ? cellText(row[cols.leaseStart] ?? "") : "";
      rooms.push({
        houseKey: houseKey ?? "",
        roomNumber,
        name,
        phone: looksLikePhone(phone) ? phone : "",
        rentDollars: cols.rent != null ? parseMoneyDollars(row[cols.rent] ?? "") : null,
        utilitiesDollars: cols.utilities != null ? parseMoneyDollars(row[cols.utilities] ?? "") : null,
        depositDollars: cols.deposit != null ? parseMoneyDollars(row[cols.deposit] ?? "") : null,
        doorCode: cols.doorCode != null ? cellText(row[cols.doorCode] ?? "") : "",
        leaseStart: parseLeaseDate(leaseStartRaw, asOf),
        leaseEnd: parseLeaseDate(leaseEndRaw, asOf),
        monthToMonth: isMonthToMonth(leaseEndRaw) || isMonthToMonth(leaseStartRaw),
        airbnbPlaceholder: false,
      });
    }
  }

  return { houseKey, title, access, rooms: rooms.filter((room) => room.houseKey) };
}

export function accessNotes(access: HouseAccessCodes, rooms: readonly HouseRoomFact[]): string {
  const lines: string[] = [];
  if (access.backGateCode) lines.push(`Back gate · ${access.backGateCode}`);
  if (access.pantryCode) lines.push(`Pantry · ${access.pantryCode}`);
  if (access.backupHouseCode) lines.push(`Backup house · ${access.backupHouseCode}`);
  for (const room of rooms) {
    if (room.doorCode && !room.airbnbPlaceholder) {
      lines.push(`Room ${room.roomNumber} ${room.name} · ${room.doorCode}`);
    }
  }
  return lines.join("\n");
}
