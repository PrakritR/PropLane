import { headerKey, moneyToCents, parseCsvText, readDate } from "./money-dates";
import type { ChannelFinanceFacts, FinancePlatform } from "./types";

/**
 * Backfill from the channels' own CSV exports: Airbnb "Transaction history" and Booking.com "Payouts" / "Reservations".
 * Column names come from the documented exports; headers are matched tolerantly (case, spaces, punctuation ignored, a list of
 * aliases per field). The importer previews first: every row is either READY, SKIPPED (a row that is not a reservation or has
 * nothing to book) or an ERROR with its line number - nothing is guessed and one bad row never blocks the others.
 */
export type CsvRowError = { line: number; message: string };
export type CsvPreview = {
  platform: FinancePlatform;
  rows: { line: number; facts: ChannelFinanceFacts }[];
  errors: CsvRowError[];
  skipped: { line: number; reason: string }[];
  /** A file-level problem (no header row, no recognisable code column). Rows is empty when set. */
  fatal: string | null;
};

type FieldAliases = Record<string, readonly string[]>;

const AIRBNB: FieldAliases = {
  type: ["type", "transactiontype"],
  code: ["confirmationcode", "reservationcode", "confirmation"],
  date: ["date", "transactiondate", "payoutdate"],
  start: ["startdate", "checkin", "checkindate"],
  end: ["enddate", "checkout", "checkoutdate"],
  guest: ["guest", "guestname"],
  listing: ["listing", "listingname", "property"],
  amount: ["amount", "netamount", "earnings"],
  paidOut: ["paidout", "paid"],
  serviceFee: ["servicefee", "hostservicefee", "hostfee"],
  gross: ["grossearnings", "gross", "grossamount"],
  tax: ["occupancytaxes", "occupancytax", "taxes"],
  currency: ["currency"],
};

const BOOKING: FieldAliases = {
  code: ["booknumber", "reservationnumber", "reservationid", "bookingnumber", "bookingid", "referencenumber", "reservation"],
  start: ["checkin", "checkindate", "arrival", "arrivaldate"],
  end: ["checkout", "checkoutdate", "departure", "departuredate"],
  guest: ["guestnames", "guestname", "guest", "bookedby"],
  listing: ["property", "propertyname", "unittype", "roomtype", "accommodation"],
  status: ["status", "reservationstatus"],
  price: ["price", "reservationamount", "grossamount", "totalprice", "bookingamount", "grossreservationamount"],
  commission: ["commissionamount", "commission", "commissioneur", "commissionusd"],
  paymentFee: ["paymentservicefee", "paymentcharge", "paymentchargeamount", "transactionfee"],
  net: ["netamount", "payoutamount", "net", "amount", "totalpayout"],
  payoutDate: ["payoutdate", "paymentdate", "paiddate", "transferdate"],
  type: ["type", "transactiontype", "rowtype"],
  currency: ["currency"],
};

function columnIndex(headers: readonly string[], aliases: FieldAliases): Record<string, number> {
  const keys = headers.map(headerKey);
  const out: Record<string, number> = {};
  for (const [field, names] of Object.entries(aliases)) {
    for (const name of names) {
      const at = keys.indexOf(name);
      if (at >= 0) {
        out[field] = at;
        break;
      }
    }
  }
  return out;
}

const cell = (row: string[], at: number | undefined): string => (at === undefined ? "" : (row[at] ?? "").trim());

type Money = { ok: true; cents: number | undefined } | { ok: false; message: string };
function money(label: string, raw: string): Money {
  if (!raw) return { ok: true, cents: undefined };
  const cents = moneyToCents(raw);
  if (cents === null) return { ok: false, message: `${label} "${raw.slice(0, 24)}" is not a plain amount` };
  return { ok: true, cents };
}

function currencyOk(raw: string): boolean {
  return !raw || raw.toUpperCase() === "USD";
}

const CODE_OK = /^[A-Za-z0-9]{6,20}$/;

/**
 * The Airbnb "Transaction history" Type values that ARE a reservation payout, matched EXACTLY (case and spacing only).
 * A substring test read "Reservation adjustment" / "Reservation resolution" as a full payout under the booking's own
 * confirmation code, and the in-file dedupe below then dropped the real reservation line for it. Every other type -
 * "Payout", "Adjustment", "Resolution Payout", "Co-Host Payout" - is skipped with its own reason and never reaches the
 * dedupe, so it can never stand in for the booking.
 */
const AIRBNB_RESERVATION_TYPES = new Set(["reservation"]);

const typeKey = (raw: string): string => raw.trim().toLowerCase().replace(/\s+/g, " ");

export function previewChannelCsv(platform: FinancePlatform, csvText: string): CsvPreview {
  const preview: CsvPreview = { platform, rows: [], errors: [], skipped: [], fatal: null };
  const table = parseCsvText(csvText);
  if (table.length < 2) return { ...preview, fatal: "The file has no rows." };
  // Airbnb exports can open with a summary block; the header row is the first one that names a confirmation / reservation code.
  const aliases = platform === "airbnb" ? AIRBNB : BOOKING;
  const headerAt = table.findIndex((row) => columnIndex(row, aliases).code !== undefined);
  if (headerAt < 0) {
    return { ...preview, fatal: platform === "airbnb" ? "No Confirmation Code column. Upload the Transaction history CSV." : "No reservation number column. Upload the Payouts or Reservations CSV." };
  }
  const cols = columnIndex(table[headerAt]!, aliases);
  for (let i = headerAt + 1; i < table.length; i += 1) {
    const row = table[i]!;
    const line = i + 1;
    const fail = (message: string) => preview.errors.push({ line, message });
    const skip = (reason: string) => preview.skipped.push({ line, reason });
    const code = cell(row, cols.code);
    const currency = cell(row, cols.currency);
    if (!currencyOk(currency)) {
      fail(`Currency ${currency} is not USD`);
      continue;
    }
    const guest = cell(row, cols.guest) || undefined;
    const listing = cell(row, cols.listing) || undefined;
    const checkIn = readDate(cell(row, cols.start)) ?? undefined;
    const checkOut = readDate(cell(row, cols.end)) ?? undefined;
    if ((cell(row, cols.start) && !checkIn) || (cell(row, cols.end) && !checkOut)) {
      fail("Date is not readable");
      continue;
    }
    if (checkIn && checkOut && checkOut <= checkIn) {
      fail("Check-out is not after check-in");
      continue;
    }
    const dates = checkIn && checkOut ? { checkIn, checkOut } : {};
    const common = { guestLabel: guest, listingHint: listing };

    if (platform === "airbnb") {
      const type = typeKey(cell(row, cols.type));
      if (type && !AIRBNB_RESERVATION_TYPES.has(type)) {
        skip(`${cell(row, cols.type)} row`);
        continue;
      }
      if (!code) {
        skip("No confirmation code");
        continue;
      }
      if (!CODE_OK.test(code)) {
        fail("Confirmation code is not readable");
        continue;
      }
      const amount = money("Amount", cell(row, cols.amount));
      const paidOut = money("Paid out", cell(row, cols.paidOut));
      const fee = money("Service fee", cell(row, cols.serviceFee));
      const gross = money("Gross earnings", cell(row, cols.gross));
      const tax = money("Occupancy taxes", cell(row, cols.tax));
      const bad = [amount, paidOut, fee, gross, tax].find((m) => !m.ok);
      if (bad && !bad.ok) {
        fail(bad.message);
        continue;
      }
      const values = [amount, paidOut, fee, gross, tax].map((m) => (m.ok ? m.cents : undefined));
      if (values.some((v) => v !== undefined && v < 0)) {
        fail("Negative amount (a refund or adjustment): enter it by hand");
        continue;
      }
      const [amountC, paidOutC, feeC, grossC, taxC] = values;
      const payoutCents = paidOutC && paidOutC > 0 ? paidOutC : amountC;
      if (payoutCents === undefined || payoutCents <= 0) {
        skip("No amount");
        continue;
      }
      const paid = Boolean(paidOutC && paidOutC > 0);
      const rowDate = readDate(cell(row, cols.date));
      preview.rows.push({
        line,
        facts: {
          platform,
          kind: "payout",
          confirmationCode: code,
          ...common,
          ...dates,
          ...(grossC !== undefined ? { grossCents: grossC } : {}),
          ...(feeC !== undefined ? { hostFeeCents: feeC } : {}),
          ...(taxC !== undefined ? { taxCents: taxC } : {}),
          payoutCents,
          currency: "USD",
          ...(paid && rowDate ? { paidOn: rowDate } : {}),
        },
      });
      continue;
    }

    // Booking.com
    if (!code) {
      skip("No reservation number");
      continue;
    }
    if (!CODE_OK.test(code)) {
      fail("Reservation number is not readable");
      continue;
    }
    const status = cell(row, cols.status).toLowerCase();
    if (/cancel|no[\s_-]?show/.test(status)) {
      skip(`Reservation ${status}`);
      continue;
    }
    const price = money("Price", cell(row, cols.price));
    const commission = money("Commission", cell(row, cols.commission));
    const paymentFee = money("Payment service fee", cell(row, cols.paymentFee));
    const net = money("Net amount", cell(row, cols.net));
    const bad = [price, commission, paymentFee, net].find((m) => !m.ok);
    if (bad && !bad.ok) {
      fail(bad.message);
      continue;
    }
    const [priceC, commissionC, paymentFeeC, netC] = [price, commission, paymentFee, net].map((m) => (m.ok ? m.cents : undefined));
    if ([priceC, commissionC, paymentFeeC, netC].some((v) => v !== undefined && v < 0)) {
      fail("Negative amount (a refund or adjustment): enter it by hand");
      continue;
    }
    const feeCents = commissionC === undefined && paymentFeeC === undefined ? undefined : (commissionC ?? 0) + (paymentFeeC ?? 0);
    const payoutDate = readDate(cell(row, cols.payoutDate));
    if (cell(row, cols.payoutDate) && !payoutDate) {
      fail("Payout date is not readable");
      continue;
    }
    const isPayoutFile = cols.payoutDate !== undefined || cols.net !== undefined;
    if (isPayoutFile && netC !== undefined && netC > 0) {
      preview.rows.push({
        line,
        facts: {
          platform,
          kind: "payout",
          confirmationCode: code,
          ...common,
          ...dates,
          ...(priceC !== undefined ? { grossCents: priceC } : {}),
          ...(feeCents !== undefined ? { hostFeeCents: feeCents } : {}),
          payoutCents: netC,
          currency: "USD",
          ...(payoutDate ? { paidOn: payoutDate } : {}),
        },
      });
      continue;
    }
    if (priceC === undefined || priceC <= 0) {
      skip("No amount");
      continue;
    }
    preview.rows.push({
      line,
      facts: {
        platform,
        kind: "reservation",
        confirmationCode: code,
        ...common,
        ...dates,
        grossCents: priceC,
        ...(feeCents !== undefined ? { hostFeeCents: feeCents } : {}),
        currency: "USD",
      },
    });
  }
  // The same code twice in one file is one booking: the later line wins, the earlier is reported rather than silently dropped.
  const last = new Map<string, number>();
  preview.rows.forEach((row, index) => last.set(`${row.facts.kind}:${row.facts.confirmationCode}`, index));
  const kept: typeof preview.rows = [];
  preview.rows.forEach((row, index) => {
    if (last.get(`${row.facts.kind}:${row.facts.confirmationCode}`) === index) kept.push(row);
    else preview.skipped.push({ line: row.line, reason: "Duplicate of a later line" });
  });
  preview.rows = kept;
  return preview;
}
