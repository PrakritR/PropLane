/**
 * One CSV writer for every export.
 *
 * The escaping rule is small enough that it had been retyped per export, which is how two
 * exports of the same data end up quoting differently. Keep new exports on these helpers.
 */

/** RFC 4180: quote a field containing a delimiter, quote or newline, doubling inner quotes. */
export function escapeCsv(value: string): string {
  if (/[",\n]/.test(value)) return `"${value.replace(/"/g, '""')}"`;
  return value;
}

/**
 * A CSV document from a header row plus body rows.
 *
 * Values are stringified here rather than at each call site so a `null` cell writes an empty
 * field instead of the text "null" — which reads as data in a spreadsheet.
 */
export function toCsv(header: readonly string[], rows: readonly (readonly unknown[])[]): string {
  const line = (cells: readonly unknown[]) =>
    cells.map((cell) => escapeCsv(cell === null || cell === undefined ? "" : String(cell))).join(",");
  return [line(header), ...rows.map(line)].join("\n");
}

/** Integer cents as a plain decimal amount — no currency symbol, no thousands separator. */
export function csvMoneyFromCents(cents: number): string {
  return (Number(cents ?? 0) / 100).toFixed(2);
}
