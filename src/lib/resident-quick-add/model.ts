/**
 * Quick add residents, pure half: the one input shape the Residents + sheet and the CSV share, its validation
 * (a row is saved only when it has NO error; nothing is skipped silently), the CSV reader/template, and the
 * mapping onto the existing Add resident form (`AddPersonForm`), so saving goes through the one commit that already
 * writes the occupancy row, the lease, the charges and the welcome link.
 *
 * Nothing here reads a store or the network: the house/room catalog comes in as an argument.
 */
import { normalizeE164 } from "@/lib/phone-e164";
import { RESIDENT_LEASE_TERM_LONG } from "@/lib/resident-manual-lease-terms";

export const QUICK_ADD_CSV_COLUMNS = ["name", "email", "phone", "house", "room", "move_in", "lease_end", "rent", "deposit"] as const;
export type QuickAddCsvColumn = (typeof QUICK_ADD_CSV_COLUMNS)[number];
export const QUICK_ADD_MAX_ROWS = 100;
export const QUICK_ADD_MAX_CSV_BYTES = 256 * 1024;

export type QuickAddCatalogHouse = { id: string; label: string; rooms: { id: string; name: string }[] };
export type QuickAddCatalog = { houses: readonly QuickAddCatalogHouse[] };

/** What a manager types (or a CSV row says), before validation. Every value is text. */
export type QuickAddRaw = {
  name: string;
  email: string;
  phone: string;
  /** A house label from the picker/CSV, or its id. */
  house: string;
  /** A room name from the picker/CSV, or its id. */
  room: string;
  moveIn: string;
  /** Blank = month-to-month. */
  leaseEnd: string;
  rent: string;
  deposit: string;
  moveInFee?: string;
  /** Optional one-time charges (a pet fee, a key deposit...), each a label and an amount. */
  oneTimeCharges?: { label: string; amount: string }[];
};

export type QuickAddResident = {
  name: string;
  email: string;
  /** E.164. */
  phone: string;
  propertyId: string;
  roomId: string;
  moveInDate: string;
  /** "" when month-to-month. */
  leaseEnd: string;
  monthToMonth: boolean;
  rent: number;
  deposit: number;
  moveInFee: number;
  oneTimeCharges: { label: string; amount: number }[];
};

export type QuickAddField = Exclude<keyof QuickAddRaw, "oneTimeCharges"> | "oneTimeCharges";
export const QUICK_ADD_MAX_ONE_TIME_CHARGES = 5;
export type QuickAddValidation = { ok: true; value: QuickAddResident } | { ok: false; errors: Partial<Record<QuickAddField, string>> };

const EMAIL_RE = /^[^\s@]+@[^\s@.]+(?:\.[^\s@.]+)+$/;
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const US_DATE = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/;

/** `2026-11-12` or `11/12/2026` -> `2026-11-12`; anything else (or a day that does not exist) -> null. */
export function parseQuickAddDate(raw: string): string | null {
  const value = String(raw ?? "").trim();
  let y: number;
  let m: number;
  let d: number;
  const iso = ISO_DATE.exec(value);
  const us = US_DATE.exec(value);
  if (iso) [y, m, d] = [Number(iso[1]), Number(iso[2]), Number(iso[3])];
  else if (us) [y, m, d] = [Number(us[3]), Number(us[1]), Number(us[2])];
  else return null;
  const probe = new Date(Date.UTC(y, m - 1, d));
  if (probe.getUTCFullYear() !== y || probe.getUTCMonth() !== m - 1 || probe.getUTCDate() !== d) return null;
  return `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/** `$1,250.50` -> 1250.5; blank -> null; anything else that is not a plain amount -> NaN. */
export function parseQuickAddMoney(raw: string): number | null {
  const value = String(raw ?? "").trim();
  if (!value) return null;
  const cleaned = value.replace(/^\$/, "").replace(/,/g, "");
  if (!/^\d+(\.\d{1,2})?$/.test(cleaned)) return Number.NaN;
  return Math.round(Number(cleaned) * 100) / 100;
}

const norm = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();

export function resolveQuickAddHouse(catalog: QuickAddCatalog, raw: string): { house: QuickAddCatalogHouse } | { error: string } {
  const key = norm(raw);
  if (!key) return { error: "Pick a house." };
  const byId = catalog.houses.filter((h) => norm(h.id) === key);
  if (byId.length === 1) return { house: byId[0]! };
  const byLabel = catalog.houses.filter((h) => norm(h.label) === key);
  if (byLabel.length === 1) return { house: byLabel[0]! };
  if (byLabel.length > 1) return { error: "More than one house has that name. Use the house id." };
  return { error: "That house is not one of yours." };
}

export function validateQuickAdd(raw: QuickAddRaw, catalog: QuickAddCatalog, opts: { now?: Date } = {}): QuickAddValidation {
  void opts;
  const errors: Partial<Record<QuickAddField, string>> = {};
  const name = String(raw.name ?? "").replace(/\s+/g, " ").trim();
  if (name.length < 2 || name.length > 80) errors.name = "Enter the full name.";
  const email = String(raw.email ?? "").trim().toLowerCase();
  if (!email || email.length > 254 || !EMAIL_RE.test(email)) errors.email = "Enter a valid email.";
  const phone = normalizeE164(raw.phone);
  if (!String(raw.phone ?? "").trim() || !phone) errors.phone = "Enter a valid US phone number.";

  let propertyId = "";
  let roomId = "";
  const house = resolveQuickAddHouse(catalog, raw.house);
  if ("error" in house) errors.house = house.error;
  else {
    propertyId = house.house.id;
    const rooms = house.house.rooms;
    const roomKey = norm(raw.room);
    if (rooms.length > 0) {
      if (!roomKey) errors.room = "Pick a room.";
      else {
        const byId = rooms.filter((r) => norm(r.id) === roomKey);
        const byName = rooms.filter((r) => norm(r.name) === roomKey);
        const match = byId.length === 1 ? byId[0] : byName.length === 1 ? byName[0] : null;
        if (!match) errors.room = byName.length > 1 ? "More than one room has that name. Use the room id." : "That room is not in this house.";
        else roomId = match.id;
      }
    } else if (roomKey) errors.room = "This house is rented whole. Leave the room blank.";
  }

  const moveIn = parseQuickAddDate(raw.moveIn);
  if (!String(raw.moveIn ?? "").trim()) errors.moveIn = "Enter the move-in date.";
  else if (!moveIn) errors.moveIn = "Use a date like 2026-12-01.";
  let leaseEnd = "";
  if (String(raw.leaseEnd ?? "").trim()) {
    const parsed = parseQuickAddDate(raw.leaseEnd);
    if (!parsed) errors.leaseEnd = "Use a date like 2027-11-30, or leave blank for month-to-month.";
    else if (moveIn && parsed <= moveIn) errors.leaseEnd = "The lease must end after move-in.";
    else leaseEnd = parsed;
  }

  const rent = parseQuickAddMoney(raw.rent);
  if (rent === null) errors.rent = "Enter the monthly rent.";
  else if (Number.isNaN(rent) || rent <= 0 || rent > 1_000_000) errors.rent = "Enter the rent as a number, like 1450.";
  const deposit = parseQuickAddMoney(raw.deposit ?? "");
  if (deposit !== null && (Number.isNaN(deposit) || deposit < 0 || deposit > 1_000_000)) errors.deposit = "Enter the deposit as a number, like 1450.";
  const moveInFee = parseQuickAddMoney(raw.moveInFee ?? "");
  if (moveInFee !== null && (Number.isNaN(moveInFee) || moveInFee < 0 || moveInFee > 1_000_000)) errors.moveInFee = "Enter the fee as a number.";
  const oneTimeCharges: { label: string; amount: number }[] = [];
  const charges = (raw.oneTimeCharges ?? []).filter((c) => String(c.label ?? "").trim() || String(c.amount ?? "").trim());
  if (charges.length > QUICK_ADD_MAX_ONE_TIME_CHARGES) errors.oneTimeCharges = `Add up to ${QUICK_ADD_MAX_ONE_TIME_CHARGES} one-time charges.`;
  else {
    for (const c of charges) {
      const label = String(c.label ?? "").replace(/\s+/g, " ").trim().slice(0, 60);
      const amount = parseQuickAddMoney(c.amount ?? "");
      if (!label || amount === null || Number.isNaN(amount) || amount <= 0 || amount > 1_000_000) {
        errors.oneTimeCharges = "Each one-time charge needs a name and an amount.";
        break;
      }
      oneTimeCharges.push({ label, amount });
    }
  }

  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return {
    ok: true,
    value: {
      name,
      email,
      phone: phone!,
      propertyId,
      roomId,
      moveInDate: moveIn!,
      leaseEnd,
      monthToMonth: leaseEnd === "",
      rent: rent as number,
      deposit: deposit ?? 0,
      moveInFee: moveInFee ?? 0,
      oneTimeCharges,
    },
  };
}

/* ───────────────────────────── CSV ───────────────────────────── */

/** RFC 4180 reader: quoted fields, doubled quotes, CRLF/LF, a leading BOM. Blank lines are dropped. */
export function parseCsv(text: string): string[][] {
  const src = String(text ?? "").replace(/^﻿/, "");
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i]!;
    if (quoted) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += c;
    } else if (c === '"' && field === "") quoted = true;
    else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && src[i + 1] === "\n") i++;
      row.push(field);
      field = "";
      if (row.some((cell) => cell.trim() !== "")) rows.push(row);
      row = [];
    } else field += c;
  }
  row.push(field);
  if (row.some((cell) => cell.trim() !== "")) rows.push(row);
  return rows;
}

function csvCell(value: string): string {
  return /[",\n\r]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/** The downloadable template: the header and one example row built from the manager's own first house. */
export function quickAddCsvTemplate(catalog?: QuickAddCatalog): string {
  const first = catalog?.houses[0];
  const example = [
    "Jordan Example",
    "jordan@example.com",
    "(206) 555-0101",
    first?.label ?? "Maple House",
    first?.rooms[0]?.name ?? "",
    "2026-12-01",
    "2027-11-30",
    "1450",
    "1450",
  ];
  return `${QUICK_ADD_CSV_COLUMNS.join(",")}\n${example.map(csvCell).join(",")}\n`;
}

export type QuickAddPreviewRow = {
  /** 1-based line in the file (the header is line 1), so an error points at a spot the manager can find. */
  line: number;
  raw: QuickAddRaw;
  /** Present when the row has no error. */
  value: QuickAddResident | null;
  errors: Partial<Record<QuickAddField, string>>;
  /** Row-level problems that are not one field (a duplicate in the file). */
  rowError: string | null;
};

export type QuickAddPreview = { fileError: string | null; rows: QuickAddPreviewRow[]; okCount: number; errorCount: number };

const HEADER_ALIASES: Record<string, QuickAddCsvColumn> = {
  name: "name",
  full_name: "name",
  email: "email",
  phone: "phone",
  house: "house",
  property: "house",
  room: "room",
  move_in: "move_in",
  movein: "move_in",
  move_in_date: "move_in",
  lease_end: "lease_end",
  leaseend: "lease_end",
  lease_end_date: "lease_end",
  rent: "rent",
  monthly_rent: "rent",
  deposit: "deposit",
  security_deposit: "deposit",
};

/**
 * Read a CSV into preview rows. Every data row comes back, valid or not, with its own errors; the caller saves only
 * the rows with none, and shows the rest. A duplicate email or phone INSIDE the file is an error on the later row.
 */
export function previewQuickAddCsv(text: string, catalog: QuickAddCatalog): QuickAddPreview {
  const empty = (fileError: string): QuickAddPreview => ({ fileError, rows: [], okCount: 0, errorCount: 0 });
  if (String(text ?? "").length > QUICK_ADD_MAX_CSV_BYTES) return empty("That file is too large. Keep it under 250 KB.");
  const table = parseCsv(text);
  if (table.length === 0) return empty("The file is empty.");
  const header = table[0]!.map((h) => HEADER_ALIASES[h.trim().toLowerCase().replace(/[\s-]+/g, "_")] ?? null);
  const missing = QUICK_ADD_CSV_COLUMNS.filter((c) => c !== "room" && c !== "lease_end" && c !== "deposit" && !header.includes(c));
  if (missing.length > 0) return empty(`Missing column${missing.length > 1 ? "s" : ""}: ${missing.join(", ")}. Download the template.`);
  const body = table.slice(1);
  if (body.length === 0) return empty("There are no residents in the file.");
  if (body.length > QUICK_ADD_MAX_ROWS) return empty(`Too many rows. Add up to ${QUICK_ADD_MAX_ROWS} at a time.`);

  const seenEmail = new Map<string, number>();
  const seenPhone = new Map<string, number>();
  const rows: QuickAddPreviewRow[] = body.map((cells, index) => {
    const get = (col: QuickAddCsvColumn) => {
      const at = header.indexOf(col);
      return at >= 0 ? (cells[at] ?? "").trim() : "";
    };
    const raw: QuickAddRaw = {
      name: get("name"),
      email: get("email"),
      phone: get("phone"),
      house: get("house"),
      room: get("room"),
      moveIn: get("move_in"),
      leaseEnd: get("lease_end"),
      rent: get("rent"),
      deposit: get("deposit"),
    };
    const line = index + 2;
    const checked = validateQuickAdd(raw, catalog);
    let rowError: string | null = null;
    if (checked.ok) {
      const dupEmail = seenEmail.get(checked.value.email);
      const dupPhone = seenPhone.get(checked.value.phone);
      if (dupEmail) rowError = `Same email as line ${dupEmail}.`;
      else if (dupPhone) rowError = `Same phone as line ${dupPhone}.`;
      seenEmail.set(checked.value.email, seenEmail.get(checked.value.email) ?? line);
      seenPhone.set(checked.value.phone, seenPhone.get(checked.value.phone) ?? line);
    }
    return {
      line,
      raw,
      value: checked.ok && !rowError ? checked.value : null,
      errors: checked.ok ? {} : checked.errors,
      rowError,
    };
  });
  const okCount = rows.filter((r) => r.value).length;
  return { fileError: null, rows, okCount, errorCount: rows.length - okCount };
}

/** One line per problem on a row, for the preview. */
export function quickAddRowProblems(row: Pick<QuickAddPreviewRow, "errors" | "rowError">): string[] {
  return [...Object.values(row.errors), ...(row.rowError ? [row.rowError] : [])].filter((m): m is string => Boolean(m));
}

/* ─────────────────── onto the existing Add resident form ─────────────────── */

export type QuickAddLeaseChoice = "none" | "signed" | "draft";

/**
 * The Add resident form this person's quick add stands for. Lease + Payments are on (the resident's Lease and
 * Payments exist the moment they sign in); the deposit and move-in fee are DUE, not marked paid. A lease PDF the
 * manager attached is a signed one (already executed) or a draft that goes out for signature, as in the wizard.
 */
export function quickAddFormPatch(
  r: QuickAddResident,
  lease: { choice: QuickAddLeaseChoice; file: File | null; dataUrl: string },
): Record<string, unknown> {
  const hasPdf = lease.choice !== "none" && Boolean(lease.dataUrl);
  return {
    kind: "resident" as const,
    name: r.name,
    email: r.email,
    phone: r.phone,
    propertyId: r.propertyId,
    roomId: r.roomId,
    leaseTerm: r.monthToMonth ? "Month-to-Month" : RESIDENT_LEASE_TERM_LONG,
    leaseTermCustomMode: r.monthToMonth,
    moveInDate: r.moveInDate,
    moveOutDate: r.leaseEnd,
    rent: String(r.rent),
    securityDeposit: r.deposit > 0 ? String(r.deposit) : "",
    moveInFee: r.moveInFee > 0 ? String(r.moveInFee) : "",
    leaseDocument: hasPdf ? lease.choice : "later",
    leaseFile: hasPdf ? lease.file : null,
    leaseDataUrl: hasPdf ? lease.dataUrl : "",
    leaseFileName: hasPdf ? (lease.file?.name ?? "lease.pdf") : "",
    alsoCreate: ["lease", "payments"],
    depositPaid: false,
    moveInFeePaid: false,
    billingStart: "move_in" as const,
  };
}
