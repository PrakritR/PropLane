/**
 * Pure vocabulary for a financial entry's payment fields: how it was (or will be) paid, whether it is
 * Paid or Due, and how a recurring payable steps forward. Browser-safe: the Add financial entry form,
 * the routes and the recurring cron all read this one file.
 *
 * Labels are generic on purpose. PropLane records how a payment left the owner's hands; it integrates with
 * no outside payment network, and the tests forbid naming one (`no-off-platform-payment-channels`).
 */

export const PAYMENT_METHODS = ["p2p_transfer", "ach", "card", "check", "cash", "other"] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

export const PAYMENT_METHOD_LABELS: Record<PaymentMethod, string> = {
  p2p_transfer: "Bank app / P2P transfer",
  ach: "ACH",
  card: "Card",
  check: "Check",
  cash: "Cash",
  other: "Other",
};

export function isPaymentMethod(value: unknown): value is PaymentMethod {
  return typeof value === "string" && (PAYMENT_METHODS as readonly string[]).includes(value);
}

export const PAYMENT_STATUSES = ["paid", "due"] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

export function isPaymentStatus(value: unknown): value is PaymentStatus {
  return value === "paid" || value === "due";
}

export const RECURRENCE_FREQUENCIES = ["weekly", "monthly", "quarterly", "annual"] as const;
export type RecurrenceFrequency = (typeof RECURRENCE_FREQUENCIES)[number];

export const RECURRENCE_LABELS: Record<RecurrenceFrequency, string> = {
  weekly: "Weekly",
  monthly: "Monthly",
  quarterly: "Quarterly",
  annual: "Annual",
};

export function isRecurrenceFrequency(value: unknown): value is RecurrenceFrequency {
  return typeof value === "string" && (RECURRENCE_FREQUENCIES as readonly string[]).includes(value);
}

export const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** A real calendar date in YYYY-MM-DD form (rejects 2026-02-31). */
export function isIsoDate(value: unknown): value is string {
  if (typeof value !== "string" || !ISO_DATE_RE.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function daysInMonth(year: number, month1: number): number {
  return new Date(Date.UTC(year, month1, 0)).getUTCDate();
}

/**
 * The next occurrence after `from`. Monthly / quarterly / annual keep the ANCHOR day of month and clamp to
 * the month's last day (Jan 31 -> Feb 28 -> Mar 31), so a payable anchored on the 31st never drifts to the
 * 28th for good. `anchorDay` defaults to `from`'s own day.
 */
export function advanceRecurrenceDate(from: string, frequency: RecurrenceFrequency, anchorDay?: number): string {
  if (!isIsoDate(from)) throw new Error("advanceRecurrenceDate: invalid date.");
  const [y, m, d] = from.split("-").map(Number) as [number, number, number];
  if (frequency === "weekly") {
    return new Date(Date.UTC(y, m - 1, d + 7)).toISOString().slice(0, 10);
  }
  const step = frequency === "monthly" ? 1 : frequency === "quarterly" ? 3 : 12;
  const targetIndex = y * 12 + (m - 1) + step;
  const ty = Math.floor(targetIndex / 12);
  const tm = (targetIndex % 12) + 1;
  const day = Math.min(anchorDay && anchorDay >= 1 && anchorDay <= 31 ? anchorDay : d, daysInMonth(ty, tm));
  return `${ty}-${String(tm).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/** Every occurrence from `start` (inclusive) up to `through` (inclusive) and not past `endDate`. */
export function recurrenceDatesThrough(
  start: string,
  frequency: RecurrenceFrequency,
  through: string,
  endDate?: string | null,
  limit = 60,
): string[] {
  const anchorDay = Number(start.slice(8, 10));
  const out: string[] = [];
  let cursor = start;
  while (cursor <= through && (!endDate || cursor <= endDate) && out.length < limit) {
    out.push(cursor);
    cursor = advanceRecurrenceDate(cursor, frequency, anchorDay);
  }
  return out;
}
