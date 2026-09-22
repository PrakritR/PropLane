const ISO = /^(\d{4})-(\d{2})-(\d{2})$/;
const MDY = /^(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?$/;
const MONTH_DAY = /^(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\s+(\d{1,2})(?:[,\s]+(\d{2,4}))?$/i;

const MONTHS: Record<string, number> = {
  jan: 1,
  feb: 2,
  mar: 3,
  apr: 4,
  may: 5,
  jun: 6,
  jul: 7,
  aug: 8,
  sep: 9,
  sept: 9,
  oct: 10,
  nov: 11,
  dec: 12,
};

export function pacificTodayKey(now = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles" }).format(now);
}

export function addDaysToIsoDate(iso: string, days: number): string {
  const [year, month, day] = iso.split("-").map(Number);
  if (!year || !month || !day) return iso;
  const next = new Date(year, month - 1, day + days);
  return `${next.getFullYear()}-${String(next.getMonth() + 1).padStart(2, "0")}-${String(next.getDate()).padStart(2, "0")}`;
}

/** Inclusive last night → exclusive checkout for a room-date block. */
export function exclusiveCheckoutAfterLastNight(inclusiveEnd: string): string {
  return addDaysToIsoDate(inclusiveEnd, 1);
}

function padIso(year: number, month: number, day: number): string | null {
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function expandYear(raw: string | undefined, fallbackYear: number): number {
  if (!raw) return fallbackYear;
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallbackYear;
  if (n < 100) return n >= 70 ? 1900 + n : 2000 + n;
  return n;
}

/**
 * Occupancy headers are often `9/22` with no year. Use `asOf`'s year, then
 * wrap Dec↔Jan so a January pull of late-December nights is not a year ahead.
 */
export function parseSheetDate(raw: string, asOf = pacificTodayKey()): string | null {
  const text = raw.replace(/\s+/g, " ").trim();
  if (!text) return null;
  const iso = ISO.exec(text);
  if (iso) return padIso(Number(iso[1]), Number(iso[2]), Number(iso[3]));

  const asOfYear = Number(asOf.slice(0, 4));
  const asOfMonth = Number(asOf.slice(5, 7));
  const mdy = MDY.exec(text);
  if (mdy) {
    const month = Number(mdy[1]);
    const day = Number(mdy[2]);
    let year = expandYear(mdy[3], asOfYear);
    if (!mdy[3]) year = wrapYear(year, month, asOfMonth);
    return padIso(year, month, day);
  }

  const named = MONTH_DAY.exec(text);
  if (named) {
    const month = MONTHS[named[1]!.toLowerCase()];
    if (!month) return null;
    const day = Number(named[2]);
    let year = expandYear(named[3], asOfYear);
    if (!named[3]) year = wrapYear(year, month, asOfMonth);
    return padIso(year, month, day);
  }
  return null;
}

function wrapYear(year: number, month: number, asOfMonth: number): number {
  if (asOfMonth <= 2 && month >= 11) return year - 1;
  if (asOfMonth >= 11 && month <= 2) return year + 1;
  return year;
}

export function parseMoneyDollars(raw: string): number | null {
  const text = raw.replace(/[$,\s]/g, "").replace(/[()]/g, "");
  if (!text || !/^\d+(\.\d+)?$/.test(text)) return null;
  const value = Number(text);
  if (!Number.isFinite(value) || value <= 0) return null;
  return Math.round(value * 100) / 100;
}

export function looksLikePhone(raw: string): boolean {
  const digits = raw.replace(/\D/g, "");
  return digits.length >= 10 && digits.length <= 15;
}
