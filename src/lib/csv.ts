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

/**
 * One cell, formula-safe: a spreadsheet reads a leading `=`, `+`, `@` or `-` as a formula, and an
 * apostrophe in front keeps the value text. Stringified here so a `null` writes an empty field.
 */
export function csvCell(value: unknown): string {
  const text = value === null || value === undefined ? "" : String(value);
  return escapeCsv(/^[\s]*[=+@-]/.test(text) ? `'${text}` : text);
}

/** A formula-safe CSV document from rows of cells, the header row included. */
export function toSafeCsv(rows: readonly (readonly unknown[])[]): string {
  return rows.map((row) => row.map(csvCell).join(",")).join("\n");
}

/**
 * Hand a CSV to the browser as a download. The anchor is in the document when it is clicked and the
 * object URL outlives the click's own task — a detached anchor or a URL revoked in the same task is
 * how a browser abandons the download. Every export used to retype these lines.
 */
export function downloadCsv(filename: string, csv: string): void {
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.style.display = "none";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
