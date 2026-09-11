/**
 * A Long-term let offered at fixed lengths: the length pre-fills the move-out
 * date, and the dates stay the truth (the lease type is still "Long-term").
 */

/** `YYYY-MM-DD` plus N months, ending the day before the same date (a 3-month lease from Jan 1 ends Mar 31). */
export function addMonthsToDateString(start: string, months: number): string {
  const [y, m, d] = start.split("-").map(Number);
  if (!y || !m || !d) return "";
  const end = new Date(y, m - 1 + months, d);
  end.setDate(end.getDate() - 1);
  return `${end.getFullYear()}-${String(end.getMonth() + 1).padStart(2, "0")}-${String(end.getDate()).padStart(2, "0")}`;
}

/** Which offered length (if any) the current start/end pair matches, as a select value. */
export function longTermLengthFor(start: string, end: string, offered: readonly number[]): string {
  if (!start || !end) return "";
  for (const months of offered) {
    if (addMonthsToDateString(start, months) === end) return String(months);
  }
  return "";
}
