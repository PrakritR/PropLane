import { AIRBNB_LEASE_TERM, SHORT_TERM_LEASE_TERM } from "@/lib/rental-application/lease-terms";

/** Parse YYYY-MM-DD or M/D/YYYY into a local calendar date. */
export function parseFlexibleLocalDate(value: string | undefined | null): Date | null {
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    const [y, m, d] = raw.split("-").map(Number);
    const dt = new Date(y, m - 1, d);
    return Number.isNaN(dt.getTime()) ? null : new Date(dt.getFullYear(), dt.getMonth(), dt.getDate());
  }
  if (/^\d{1,2}\/\d{1,2}\/\d{4}$/.test(raw)) {
    const [m, d, y] = raw.split("/").map(Number);
    const dt = new Date(y, m - 1, d);
    return Number.isNaN(dt.getTime()) ? null : new Date(dt.getFullYear(), dt.getMonth(), dt.getDate());
  }
  const dt = new Date(raw);
  return Number.isNaN(dt.getTime()) ? null : new Date(dt.getFullYear(), dt.getMonth(), dt.getDate());
}

export function formatIsoDateInput(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/** Normalize applicant/manager date strings for `<input type="date">`. */
export function normalizeIsoDateInput(value: string | undefined | null): string {
  const parsed = parseFlexibleLocalDate(value);
  return parsed ? formatIsoDateInput(parsed) : "";
}

export function leaseTermMonths(leaseTerm: string): number | null {
  const match = leaseTerm.trim().match(/^(\d+)-Month$/i);
  if (!match) return null;
  const months = Number.parseInt(match[1]!, 10);
  return Number.isFinite(months) && months > 0 ? months : null;
}

export function shouldAutoComputeLeaseEnd(
  leaseTerm: string,
  rentalType?: "standard" | "short_term" | string | null,
): boolean {
  if (rentalType === "short_term" || rentalType === "airbnb") return false;
  const term = leaseTerm.trim();
  if (!term || term === "Month-to-Month" || term === "Custom" || term === SHORT_TERM_LEASE_TERM) return false;
  return leaseTermMonths(term) != null;
}

/** Last day of an N-month term that begins on leaseStart (e.g. Jun 1 + 3 months → Aug 31). */
export function computeLeaseEndDate(leaseStart: string, leaseTerm: string): string {
  const months = leaseTermMonths(leaseTerm);
  if (!months) return "";
  const start = parseFlexibleLocalDate(leaseStart);
  if (!start) return "";
  const termEndExclusive = new Date(start.getFullYear(), start.getMonth() + months, start.getDate());
  const lastDay = new Date(termEndExclusive.getFullYear(), termEndExclusive.getMonth(), termEndExclusive.getDate() - 1);
  return formatIsoDateInput(lastDay);
}

export function formatLeaseDateLabel(value: string | undefined | null): string {
  const parsed = parseFlexibleLocalDate(value);
  if (!parsed) return "";
  return parsed.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

/** Last calendar day of a month (`month` is 1–12). */
export function lastDayOfCalendarMonth(year: number, month: number): number {
  return new Date(year, month, 0).getDate();
}

/**
 * A regular long-term lease starts on the 1st and ends on the last day of a month.
 * Both dates must be present; open-ended or partial dates are not standard.
 */
export function isStandardCalendarLease(
  leaseStart: string | undefined | null,
  leaseEnd: string | undefined | null,
): boolean {
  const start = parseFlexibleLocalDate(leaseStart);
  const end = parseFlexibleLocalDate(leaseEnd);
  if (!start || !end) return false;
  if (start.getDate() !== 1) return false;
  return end.getDate() === lastDayOfCalendarMonth(end.getFullYear(), end.getMonth() + 1);
}

/** Mid-month start or a lease end before the month's last day — requires both dates. */
export function isCustomCalendarLease(
  leaseStart: string | undefined | null,
  leaseEnd: string | undefined | null,
): boolean {
  const start = parseFlexibleLocalDate(leaseStart);
  const end = parseFlexibleLocalDate(leaseEnd);
  if (!start || !end) return false;
  return !isStandardCalendarLease(leaseStart, leaseEnd);
}

export function resolvePlacementLeaseDates(input: {
  leaseTerm?: string | null;
  leaseStart?: string | null;
  leaseEnd?: string | null;
  rentalType?: "standard" | "short_term" | string | null;
}): { leaseTerm: string; leaseStart: string; leaseEnd: string } {
  const leaseTerm =
    input.rentalType === "short_term"
      ? SHORT_TERM_LEASE_TERM
      : input.rentalType === "airbnb"
        ? AIRBNB_LEASE_TERM
        : input.leaseTerm?.trim() || "";
  const leaseStart = normalizeIsoDateInput(input.leaseStart);
  let leaseEnd = leaseTerm === "Month-to-Month" ? "" : normalizeIsoDateInput(input.leaseEnd);
  if (!leaseEnd && shouldAutoComputeLeaseEnd(leaseTerm, input.rentalType) && leaseStart) {
    leaseEnd = computeLeaseEndDate(leaseStart, leaseTerm);
  }
  return { leaseTerm, leaseStart, leaseEnd };
}
