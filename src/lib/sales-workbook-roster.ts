/**
 * Reading a room roster out of the Sales workbook.
 *
 * The workbook is a personal accounting sheet, not a feed. Each property tab lays three unrelated
 * blocks side by side on the same rows: a monthly P&L on the left, the CURRENT room roster in the
 * middle, and a deposits ledger of PAST tenants on the right. Only the middle block describes who
 * lives somewhere today, and the two rosters share no row alignment — the person on row 7 of the
 * deposits ledger has nothing to do with Room 5 on row 7.
 *
 * Column positions differ between tabs (8th Ave carries a Door Code column the others lack), so
 * everything here is located by HEADER TEXT. Hardcoded indices would read the P&L's numbers as
 * rent the day someone inserts a column.
 *
 * The governing rule is the one the lease layer already follows: emit a value only when the sheet
 * states it plainly, otherwise leave it blank and record an issue. A rent figure that is wrong is
 * far worse than one that is missing — it becomes a charge against a real person. Nothing here
 * guesses, infers a year, or repairs a typo.
 */

/** A room as the roster describes it. Absent fields mean the sheet did not say. */
export type RosterRoom = {
  /** Room label exactly as written ("Room 1", "Room2", "Room 10"). */
  room: string;
  /** Normalized room number, for matching against a listing catalog. Null when unparseable. */
  roomNumber: number | null;
  occupancy: "resident" | "short-term" | "vacant";
  residentName: string;
  /** E.164 where the sheet gave something parseable, else "". */
  residentPhone: string;
  residentEmail: string;
  monthlyRent: number | null;
  monthlyUtilities: number | null;
  cleaningFee: number | null;
  depositHeld: number | null;
  leaseStartIso: string;
  leaseEndIso: string;
  /** True when the sheet said "month to month" rather than giving an end date. */
  monthToMonth: boolean;
  doorCode: string;
};

export type RosterIssue = {
  room: string;
  field: string;
  raw: string;
  reason: string;
};

export type RosterReadResult = {
  rooms: RosterRoom[];
  issues: RosterIssue[];
};

/** Header labels that identify the roster block. `Name` and `Rent` together are the signature. */
const HEADER_NAME = "name";
const HEADER_RENT = "rent";

const norm = (value: unknown): string => String(value ?? "").trim();
const lower = (value: unknown): string => norm(value).toLowerCase();

/**
 * Excel serial date → ISO date.
 *
 * Excel's epoch is 1899-12-30 (its own leap-year bug included). Built in UTC deliberately: these
 * are calendar dates with no time, and constructing them locally would shift a lease end across a
 * day boundary depending on where the import runs.
 */
export function excelSerialToIso(serial: number): string {
  if (!Number.isFinite(serial) || serial <= 0) return "";
  const ms = Math.round((serial - 25569) * 86400 * 1000);
  const date = new Date(ms);
  if (Number.isNaN(date.getTime())) return "";
  return date.toISOString().slice(0, 10);
}

/**
 * A date cell, which may be an Excel serial, a real date string, or prose.
 *
 * "Month to Month" is a real answer and gets its own flag. Anything else unrecognised returns an
 * issue rather than a date: the sheet contains at least one mistyped value ("8/3122026"), and a
 * parser that repairs it into 2026 has invented a lease term nobody agreed to.
 */
export function readDateCell(raw: string): {
  iso: string;
  monthToMonth: boolean;
  problem: string;
} {
  const value = norm(raw);
  if (!value) return { iso: "", monthToMonth: false, problem: "" };

  const flat = lower(value).replace(/[\s-]/g, "");
  if (flat === "monthtomonth" || flat === "monthtomonth.") {
    return { iso: "", monthToMonth: true, problem: "" };
  }

  const serial = Number(value);
  if (Number.isFinite(serial) && serial > 20000 && serial < 80000) {
    const iso = excelSerialToIso(serial);
    return iso
      ? { iso, monthToMonth: false, problem: "" }
      : { iso: "", monthToMonth: false, problem: "date serial out of range" };
  }

  // A plain calendar date the sheet stored as text.
  const parsed = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(value);
  if (parsed) {
    const [, m, d, y] = parsed;
    const iso = `${y}-${m!.padStart(2, "0")}-${d!.padStart(2, "0")}`;
    return { iso, monthToMonth: false, problem: "" };
  }

  return { iso: "", monthToMonth: false, problem: "unrecognised date" };
}

/**
 * A money cell.
 *
 * Returns null for anything that is not purely a number. The sheet mixes notes into money columns
 * ("350 for rent", "425 for rent"), and those carry a meaning — part of the sum was applied to
 * rent — that a bare number would silently discard. Better to surface it than to bank half a fact.
 */
export function readMoneyCell(raw: string): { amount: number | null; problem: string } {
  const value = norm(raw);
  if (!value) return { amount: null, problem: "" };
  const cleaned = value.replace(/[$,]/g, "");
  if (/^-?\d+(\.\d+)?$/.test(cleaned)) {
    const amount = Number(cleaned);
    return Number.isFinite(amount) ? { amount, problem: "" } : { amount: null, problem: "not a number" };
  }
  return { amount: null, problem: "not purely a number" };
}

/**
 * A US phone number → E.164.
 *
 * Returns "" rather than a partial number: a wrong number on a resident record is a message sent
 * to a stranger. Some cells carry invisible directional marks from a paste, stripped here.
 */
export function readPhoneCell(raw: string): string {
  const digits = norm(raw).replace(/[‪-‮⁦-⁩]/g, "").replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return "";
}

/**
 * Whether a roster name is a short-term listing rather than a person.
 *
 * "Airbnb", "Airbnb Ryan", "Airbnb Khue Doan" all mean the room is let short-term. These must not
 * become residents: a resident record provisions a portal account and bills someone.
 */
export function isShortTermName(raw: string): boolean {
  return lower(raw).startsWith("airbnb");
}

/** Normalize "Room 1" / "Room2" / "Room 10" to a number, or null when it is not a room row. */
export function readRoomNumber(raw: string): number | null {
  const match = /^room\s*(\d+)$/i.exec(norm(raw));
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isInteger(value) && value > 0 ? value : null;
}

type HeaderMap = { row: number; cols: Map<string, number>; roomCol: number };

/**
 * Where the roster's own columns stop.
 *
 * The past-tenant deposits ledger sits to the right on the SAME header row and reuses the roster's
 * words — `Deposit`, `Phone`. Matching by header name alone therefore reaches across and reads the
 * ledger: on the 5259 tab, whose roster has no deposit column at all, every resident came back
 * holding the ledger's flat 600, which would have written a deposit nobody agreed to onto nine
 * rooms, attributed to people who are not those people.
 *
 * A blank-column gutter is NOT a reliable separator — the real tabs leave only one blank between
 * the blocks, the same as occurs inside the roster itself. So the boundary is the ledger's own
 * vocabulary: it always opens with a column naming the PAST occupant or the money that came back.
 * A wide run of blanks ends the block too, for the tab whose ledger has no such opener.
 */
const LEDGER_OPENERS = ["old tenant", "returned", "income", "move in fee"];

function rosterColumnEnd(headerRow: string[], nameCol: number): number {
  let blanks = 0;
  for (let c = nameCol + 1; c < headerRow.length; c += 1) {
    const key = lower(headerRow[c]);
    if (key) {
      if (LEDGER_OPENERS.includes(key)) return c - 1 - blanks;
      blanks = 0;
      continue;
    }
    blanks += 1;
    if (blanks >= 4) return c - blanks;
  }
  return headerRow.length;
}

/**
 * Find the roster block's header row and column positions.
 *
 * The roster is identified by `Name` and `Rent` appearing on the same row. The room label column
 * is unlabeled, so it is taken as the column immediately left of `Name` — confirmed by requiring
 * that at least one row under it actually reads as a room.
 */
function findRosterHeader(rows: string[][]): HeaderMap | null {
  for (let r = 0; r < Math.min(rows.length, 12); r += 1) {
    const row = rows[r] ?? [];
    const nameCol = row.findIndex((cell) => lower(cell) === HEADER_NAME);
    if (nameCol < 0) continue;

    // Only headers inside the roster's own block. `Door Code` sits two left of `Name` on the tab
    // that has one; everything past the gutter belongs to the deposits ledger.
    const end = rosterColumnEnd(row, nameCol);
    const cols = new Map<string, number>();
    for (let c = Math.max(0, nameCol - 2); c <= end && c < row.length; c += 1) {
      const key = lower(row[c]);
      if (key && !cols.has(key)) cols.set(key, c);
    }
    if (!cols.has(HEADER_RENT)) continue;

    const roomCol = nameCol - 1;
    if (roomCol < 0) continue;
    const looksLikeRooms = rows
      .slice(r + 1)
      .some((candidate) => readRoomNumber(candidate?.[roomCol] ?? "") !== null);
    if (!looksLikeRooms) continue;

    return { row: r, cols, roomCol };
  }
  return null;
}

/**
 * Read one property tab's current room roster.
 *
 * Only rows whose room column reads as a room are taken, which is what keeps the P&L on the left
 * and the deposits ledger on the right out of the result — they occupy the same rows but never
 * carry a room label in this column.
 */
export function readSalesWorkbookRoster(rows: string[][]): RosterReadResult {
  const header = findRosterHeader(rows);
  if (!header) return { rooms: [], issues: [] };

  const issues: RosterIssue[] = [];
  const rooms: RosterRoom[] = [];
  const at = (row: string[], label: string): string => {
    const index = header.cols.get(label);
    return index === undefined ? "" : norm(row[index]);
  };

  for (let r = header.row + 1; r < rows.length; r += 1) {
    const row = rows[r] ?? [];
    const roomLabel = norm(row[header.roomCol]);
    const roomNumber = readRoomNumber(roomLabel);
    if (roomNumber === null) continue;

    const rawName = at(row, HEADER_NAME);
    const note = (field: string, raw: string, reason: string) => {
      if (raw && reason) issues.push({ room: roomLabel, field, raw, reason });
    };

    const rent = readMoneyCell(at(row, HEADER_RENT));
    note("rent", at(row, HEADER_RENT), rent.problem);
    const utilities = readMoneyCell(at(row, "utilities"));
    note("utilities", at(row, "utilities"), utilities.problem);
    const cleaning = readMoneyCell(at(row, "cleaning fee"));
    note("cleaningFee", at(row, "cleaning fee"), cleaning.problem);
    const deposit = readMoneyCell(at(row, "deposit"));
    note("deposit", at(row, "deposit"), deposit.problem);

    const start = readDateCell(at(row, "lease starts"));
    note("leaseStart", at(row, "lease starts"), start.problem);
    const end = readDateCell(at(row, "lease ends"));
    note("leaseEnd", at(row, "lease ends"), end.problem);

    const rawPhone = at(row, "phone");
    const phone = readPhoneCell(rawPhone);
    if (rawPhone && !phone) note("phone", rawPhone, "not a 10-digit US number");

    const occupancy: RosterRoom["occupancy"] = !rawName
      ? "vacant"
      : isShortTermName(rawName)
        ? "short-term"
        : "resident";

    rooms.push({
      room: roomLabel,
      roomNumber,
      occupancy,
      residentName: occupancy === "resident" ? rawName : "",
      residentPhone: occupancy === "resident" ? phone : "",
      residentEmail: occupancy === "resident" ? at(row, "email") : "",
      monthlyRent: rent.amount,
      monthlyUtilities: utilities.amount,
      cleaningFee: cleaning.amount,
      depositHeld: deposit.amount,
      leaseStartIso: start.iso,
      leaseEndIso: end.iso,
      monthToMonth: end.monthToMonth,
      doorCode: at(row, "door code"),
    });
  }

  return { rooms, issues };
}
