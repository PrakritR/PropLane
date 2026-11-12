/** Exact money and date reading shared by the mail parsers and the CSV importer. Pure; no IO; never float arithmetic on cents. */

const MAX_CENTS = 100_000_000;

/**
 * "$1,234.56", "US$ 12", "1234.5", "(12.00)" -> cents. Dot decimals only: "1.234,56" is refused (null), never read as 1.23.
 * Returns the cents (negative for "-12" or "(12)"), or null when the text is not one plain amount.
 */
export function moneyToCents(raw: string | null | undefined): number | null {
  let text = (raw ?? "").trim();
  if (!text) return null;
  let negative = false;
  if (/^\(.*\)$/.test(text)) {
    negative = true;
    text = text.slice(1, -1).trim();
  }
  text = text.replace(/^(?:US\$|USD|\$)\s*/i, "").replace(/\s*USD$/i, "");
  if (text.startsWith("-") || text.startsWith("−")) {
    negative = !negative;
    text = text.slice(1).trim().replace(/^(?:US\$|USD|\$)\s*/i, "");
  }
  if (!/^\d{1,3}(?:,\d{3})*(?:\.\d{1,2})?$|^\d+(?:\.\d{1,2})?$/.test(text)) return null;
  const [whole, frac = ""] = text.replace(/,/g, "").split(".");
  const cents = Number(whole) * 100 + Number(frac.padEnd(2, "0"));
  if (!Number.isSafeInteger(cents) || cents > MAX_CENTS) return null;
  return negative ? -cents : cents;
}

const MONTHS: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
const pad = (n: number) => String(n).padStart(2, "0");

function validYmd(y: number, m: number, d: number): string | null {
  if (m < 1 || m > 12 || d < 1 || d > 31 || y < 2000 || y > 2100) return null;
  const probe = new Date(Date.UTC(y, m - 1, d));
  if (probe.getUTCMonth() !== m - 1) return null;
  return `${y}-${pad(m)}-${pad(d)}`;
}

/**
 * One date in a cell or a phrase -> YYYY-MM-DD, or null. Accepts ISO (2026-10-05), US numeric (10/05/2026), "Oct 5, 2026",
 * "5 Oct 2026" and "Tue, Oct 5, 2026". A date with no year takes `defaultYear` only when one is given.
 */
export function readDate(raw: string | null | undefined, defaultYear?: number): string | null {
  const text = (raw ?? "").trim();
  if (!text) return null;
  let m = /\b(20\d{2})-(\d{1,2})-(\d{1,2})\b/.exec(text);
  if (m) return validYmd(Number(m[1]), Number(m[2]), Number(m[3]));
  m = /\b(\d{1,2})\/(\d{1,2})\/(20\d{2})\b/.exec(text);
  if (m) return validYmd(Number(m[3]), Number(m[1]), Number(m[2]));
  const word = "(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\\.?";
  m = new RegExp(`\\b${word}\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s+(20\\d{2}))?\\b`, "i").exec(text);
  if (m) {
    const year = m[3] ? Number(m[3]) : defaultYear;
    return year ? validYmd(year, MONTHS[m[1]!.toLowerCase()]!, Number(m[2])) : null;
  }
  m = new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+${word}(?:,?\\s+(20\\d{2}))?\\b`, "i").exec(text);
  if (m) {
    const year = m[3] ? Number(m[3]) : defaultYear;
    return year ? validYmd(year, MONTHS[m[2]!.toLowerCase()]!, Number(m[1])) : null;
  }
  return null;
}

/** RFC 4180 CSV: quoted cells, doubled quotes, CRLF, a BOM. Returns rows of cells; blank lines dropped. */
export function parseCsvText(input: string): string[][] {
  const text = input.replace(/^﻿/, "");
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i += 1;
        } else quoted = false;
      } else cell += ch;
      continue;
    }
    if (ch === '"') quoted = true;
    else if (ch === ",") {
      row.push(cell);
      cell = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i += 1;
      row.push(cell);
      cell = "";
      if (row.some((c) => c.trim() !== "")) rows.push(row);
      row = [];
    } else cell += ch;
  }
  row.push(cell);
  if (row.some((c) => c.trim() !== "")) rows.push(row);
  return rows;
}

/** A header as a comparison key: lower-case letters, digits and % only ("Commission %" -> "commission%"). */
export function headerKey(raw: string): string {
  return raw.toLowerCase().replace(/[^a-z0-9%]/g, "");
}
