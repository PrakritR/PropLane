/**
 * W8: pure helpers for manager operations by text. No database, no clock of their own: every
 * number a manager reads over SMS (tours, rent status, the 8am digest) is computed here from
 * rows a tool already scoped, so the same math backs a "who hasn't paid" answer and the digest.
 */
import type { HouseholdCharge } from "@/lib/household-charges";
import { householdChargeDueDate } from "@/lib/household-charges";
import { pacificCalendarDateYmd } from "@/lib/pacific-time";
import { parseMoneyAmount } from "@/lib/parse-money";
import { toGsm7 } from "@/lib/one-number/segments";

// ---- days -----------------------------------------------------------------------------------

const DAY_KEY = /^\d{4}-\d{2}-\d{2}$/;

/** Add whole days to a YYYY-MM-DD key (calendar math in UTC, so DST never shifts a day). */
export function shiftDayKey(dayKey: string, days: number): string {
  const [y, m, d] = dayKey.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/** "today" | "tomorrow" | a real YYYY-MM-DD, resolved in Pacific time. Anything else is null. */
export function resolveDayKey(day: string, now: Date = new Date()): string | null {
  const word = day.trim().toLowerCase();
  const today = pacificCalendarDateYmd(now);
  if (word === "today") return today;
  if (word === "tomorrow") return shiftDayKey(today, 1);
  if (!DAY_KEY.test(word)) return null;
  const back = new Date(`${word}T12:00:00Z`);
  return Number.isNaN(back.getTime()) || back.toISOString().slice(0, 10) !== word ? null : word;
}

/** "10:30 am" in Pacific time; empty for an unreadable instant. */
export function pacificClock(iso: string | null | undefined): string {
  const at = iso ? new Date(iso) : null;
  if (!at || Number.isNaN(at.getTime())) return "";
  return new Intl.DateTimeFormat("en-US", { timeZone: "America/Los_Angeles", hour: "numeric", minute: "2-digit" })
    .format(at)
    .replace(/\s?(AM|PM)$/i, (_, ap: string) => ` ${ap.toLowerCase()}`);
}

/** The Pacific YYYY-MM of a day key. */
export function monthOfDayKey(dayKey: string): string {
  return dayKey.slice(0, 7);
}

/** "October 2026". */
export function monthLabel(month: string): string {
  const [y, m] = month.split("-").map(Number) as [number, number];
  return new Date(Date.UTC(y, m - 1, 15)).toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
}

export function resolveMonthKey(month: string | undefined, now: Date = new Date()): string | null {
  const raw = (month ?? "").trim();
  if (!raw) return monthOfDayKey(pacificCalendarDateYmd(now));
  return /^\d{4}-(0[1-9]|1[0-2])$/.test(raw) ? raw : null;
}

// ---- rent -----------------------------------------------------------------------------------

/** The rent-shaped kinds: what a manager means by "October rent". */
export const RENT_CHARGE_KINDS: ReadonlySet<string> = new Set(["rent", "first_month_rent", "prorated_rent"]);

export type RentLine = {
  residentName: string;
  house: string;
  balanceCents: number;
  /** pending | failed | partially_paid | processing */
  status: string;
};

export type RentStatus = {
  month: string;
  paidCount: number;
  unpaidCount: number;
  paidCents: number;
  unpaidCents: number;
  unpaid: RentLine[];
};

function chargeMonth(charge: HouseholdCharge): string | null {
  if (charge.rentMonth && /^\d{4}-\d{2}$/.test(charge.rentMonth)) return charge.rentMonth;
  const due = householdChargeDueDate(charge);
  if (!due) return null;
  return `${due.getFullYear()}-${String(due.getMonth() + 1).padStart(2, "0")}`;
}

function cents(label: string): number {
  return Math.round(parseMoneyAmount(label) * 100);
}

/**
 * Rent for one month over an already-scoped charge set: one line per resident (a resident with
 * two rent-shaped charges that month is unpaid while either is open). Cancelled and refunded
 * charges are nothing owed and are ignored. `processing` (an ACH in flight) counts as not yet paid.
 */
export function summarizeRentForMonth(charges: readonly HouseholdCharge[], month: string): RentStatus {
  const people = new Map<string, { name: string; house: string; open: HouseholdCharge[]; paid: HouseholdCharge[] }>();
  for (const charge of charges) {
    if (!RENT_CHARGE_KINDS.has(charge.kind)) continue;
    if (charge.status === "cancelled" || charge.status === "refunded") continue;
    if (chargeMonth(charge) !== month) continue;
    const key = (charge.residentUserId || charge.residentEmail || charge.residentName || charge.id).toString().toLowerCase();
    const slot = people.get(key) ?? { name: charge.residentName || charge.residentEmail || "Resident", house: charge.propertyLabel || "", open: [], paid: [] };
    (charge.status === "paid" ? slot.paid : slot.open).push(charge);
    people.set(key, slot);
  }
  const out: RentStatus = { month, paidCount: 0, unpaidCount: 0, paidCents: 0, unpaidCents: 0, unpaid: [] };
  for (const person of people.values()) {
    if (person.open.length === 0) {
      out.paidCount += 1;
      out.paidCents += person.paid.reduce((sum, c) => sum + cents(c.amountLabel), 0);
      continue;
    }
    out.unpaidCount += 1;
    const balance = person.open.reduce((sum, c) => sum + cents(c.balanceLabel || c.amountLabel), 0);
    out.unpaidCents += balance;
    out.unpaid.push({ residentName: person.name, house: person.house, balanceCents: balance, status: person.open[0]!.status });
  }
  out.unpaid.sort((a, b) => a.house.localeCompare(b.house) || a.residentName.localeCompare(b.residentName));
  return out;
}

export function usd(centsValue: number): string {
  const dollars = centsValue / 100;
  return `$${Number.isInteger(dollars) ? dollars.toLocaleString("en-US") : dollars.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

// ---- the 8am digest -------------------------------------------------------------------------

export type DigestFacts = {
  toursToday: number;
  openServices: number;
  /** null when the workspace has no rent charges this month: the clause is left out. */
  rent: { paidCount: number; unpaidCount: number; unpaidCents: number } | null;
  newLeads: number;
};

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** True when there is nothing to say: the digest is then skipped, never sent as zeros. */
export function digestIsEmpty(facts: DigestFacts): boolean {
  return facts.toursToday === 0 && facts.openServices === 0 && facts.newLeads === 0 && (!facts.rent || (facts.rent.paidCount === 0 && facts.rent.unpaidCount === 0));
}

/**
 * One GSM-7 segment where it fits (the sender adds the "Good morning" subject line): tours today, open services,
 * rent paid / unpaid, new leads. A clause with nothing in it is dropped; rent is always kept
 * when there is any, because it is the one a manager acts on.
 */
export function buildMorningDigestText(facts: DigestFacts): string {
  const parts: string[] = [];
  if (facts.toursToday > 0) parts.push(plural(facts.toursToday, "tour") + " today");
  if (facts.openServices > 0) parts.push(plural(facts.openServices, "open service"));
  if (facts.rent && (facts.rent.paidCount > 0 || facts.rent.unpaidCount > 0)) {
    parts.push(
      facts.rent.unpaidCount === 0
        ? `rent all paid (${facts.rent.paidCount})`
        : `rent ${facts.rent.paidCount} paid, ${facts.rent.unpaidCount} unpaid (${usd(facts.rent.unpaidCents)})`,
    );
  }
  if (facts.newLeads > 0) parts.push(plural(facts.newLeads, "new lead"));
  return toGsm7(`${parts.join(", ")}.`);
}

// ---- house choice ---------------------------------------------------------------------------

/** The one question asked when a manager runs several houses and did not say which: "Which house: A, B or all?" */
export function whichHouseQuestion(houses: readonly string[]): string {
  const names = houses.map((h) => h.trim()).filter(Boolean);
  if (names.length <= 1) return "";
  return `Which house: ${names.slice(0, -1).join(", ")}, ${names[names.length - 1]}, or all?`;
}
