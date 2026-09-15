#!/usr/bin/env node
/**
 * Generates the portfolio-import test fixtures: appfolio-rent-roll.csv,
 * buildium-rent-roll.xlsx, generic.csv. All three carry the identical data
 * set described in the portfolio-import task brief, so the same expected
 * draft counts can be asserted against each (modulo each format's one
 * deliberately-unmapped decorative column).
 *
 * Run: node scripts/testing/generate-portfolio-import-fixtures.mjs
 */
import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as XLSX from "xlsx";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.resolve(__dirname, "../../tests/fixtures/portfolio-import");

function csvField(value) {
  const s = value === undefined || value === null ? "" : String(value);
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}
function toCsv(rows) {
  return rows.map((row) => row.map(csvField).join(",")).join("\r\n") + "\r\n";
}

// -----------------------------------------------------------------------
// AppFolio-flavored fixture
// -----------------------------------------------------------------------
const appfolioHeaders = [
  "Property", "Address", "City", "State", "Zip", "Unit", "Tenant", "Status",
  "Sq Ft", "Email", "Phone", "Rent", "Deposit", "Lease From", "Lease To",
  "Move-in", "Past Due", "Notes",
];
const appfolioRows = [
  ["Maple Court", "220 Maple Ave", "Seattle", "WA", "98103", "1A", "Dana Whitfield", "Occupied", "640", "dana.w@gmail.com", "(206) 555-0134", "1850", "1850", "2026-03-01", "2027-02-28", "", "", ""],
  ["Maple Court", "220 Maple Ave", "Seattle", "WA", "98103", "1B", "Marcus Bell", "Occupied", "620", "mbell@outlook.com", "(206) 555-0177", "1795", "1795", "2025-11-15", "2026-11-14", "", "350", ""],
  ["Maple Court", "220 Maple Ave", "Seattle", "WA", "98103", "2A", "", "Vacant", "655", "", "", "1900", "", "", "", "", "", ""],
  ["Maple Court", "220 Maple Ave", "Seattle", "WA", "98103", "2B", "Priya Nair & Tom Ellis", "Occupied", "780", "priya.nair@me.com", "(425) 555-0190", "2100", "2100", "2026-06-01", "2027-05-31", "", "", ""],
  ["", "1412 Pine St", "Seattle", "WA", "98101", "Room 1", "Jae Park", "Occupied", "", "jae.park@proton.me", "(206) 555-0102", "950", "950", "2026-01-01", "", "", "", ""],
  ["", "1412 Pine St", "Seattle", "WA", "98101", "Room 2", "", "Vacant", "", "", "", "925", "", "", "", "", "", ""],
  ["", "1412 Pine St", "Seattle", "WA", "98101", "Room 3", "Luis Ortega", "Occupied", "", "", "(206) 555-0166", "975", "975", "2025-11-01", "2026-10-31", "", "", ""],
  ["Total", "", "", "", "", "", "", "", "", "", "", "10495", "", "", "", "", "", ""],
];
writeFileSync(path.join(outDir, "appfolio-rent-roll.csv"), toCsv([appfolioHeaders, ...appfolioRows]), "utf8");

// -----------------------------------------------------------------------
// Buildium-flavored fixture (xlsx). Adds one deliberately-unmapped
// "Market Rent" column proving it never collides with monthlyRent.
// -----------------------------------------------------------------------
const buildiumHeaders = [
  "Property Name", "Address", "City", "State", "Zip", "Unit", "Tenants", "Status",
  "Square Feet", "Email", "Phone", "Monthly Rent", "Market Rent", "Deposits Held",
  "Lease Start", "Lease End", "Move In Date", "Balance Due", "Notes",
];
const buildiumRows = [
  ["Maple Court", "220 Maple Ave", "Seattle", "WA", "98103", "1A", "Dana Whitfield", "Occupied", "640", "dana.w@gmail.com", "(206) 555-0134", "1850", "1975", "1850", "2026-03-01", "2027-02-28", "", "", ""],
  ["Maple Court", "220 Maple Ave", "Seattle", "WA", "98103", "1B", "Marcus Bell", "Occupied", "620", "mbell@outlook.com", "(206) 555-0177", "1795", "1895", "1795", "2025-11-15", "2026-11-14", "", "350", ""],
  ["Maple Court", "220 Maple Ave", "Seattle", "WA", "98103", "2A", "", "Vacant", "655", "", "", "1900", "1975", "", "", "", "", "", ""],
  ["Maple Court", "220 Maple Ave", "Seattle", "WA", "98103", "2B", "Priya Nair & Tom Ellis", "Occupied", "780", "priya.nair@me.com", "(425) 555-0190", "2100", "2195", "2100", "2026-06-01", "2027-05-31", "", "", ""],
  ["", "1412 Pine St", "Seattle", "WA", "98101", "Room 1", "Jae Park", "Occupied", "", "jae.park@proton.me", "(206) 555-0102", "950", "995", "950", "2026-01-01", "", "", "", ""],
  ["", "1412 Pine St", "Seattle", "WA", "98101", "Room 2", "", "Vacant", "", "", "", "925", "975", "", "", "", "", "", ""],
  ["", "1412 Pine St", "Seattle", "WA", "98101", "Room 3", "Luis Ortega", "Occupied", "", "", "(206) 555-0166", "975", "1025", "975", "2025-11-01", "2026-10-31", "", "", ""],
  ["Total", "", "", "", "", "", "", "", "", "", "", "10495", "", "", "", "", "", "", ""],
];

const wb = XLSX.utils.book_new();
// A short unrelated "Summary" sheet first, so the sheet-picking heuristic is
// actually exercised: the rent-roll sheet has far more mappable headers.
const summarySheet = XLSX.utils.aoa_to_sheet([
  ["Portfolio Summary"],
  ["Generated", "2026-09-14"],
  ["Properties", "2"],
]);
XLSX.utils.book_append_sheet(wb, summarySheet, "Summary");
const rentRollSheet = XLSX.utils.aoa_to_sheet([buildiumHeaders, ...buildiumRows]);
XLSX.utils.book_append_sheet(wb, rentRollSheet, "Rent Roll");
XLSX.writeFile(wb, path.join(outDir, "buildium-rent-roll.xlsx"));

// -----------------------------------------------------------------------
// Generic fixture: odd headers, two of which ("Rent/mo", "Owed") are left
// unmapped on purpose — the test applies a manual column mapping for them,
// exactly like the wizard's "Match columns" step would.
// -----------------------------------------------------------------------
const genericHeaders = [
  "Bldg", "Address", "City", "State", "Zip", "Apt", "Occupant", "Status",
  "Size", "Email", "Cell", "Rent/mo", "Security Deposit", "Lease Start",
  "Lease End", "Move In Date", "Owed", "Notes",
];
const genericRows = [
  ["Maple Court", "220 Maple Ave", "Seattle", "WA", "98103", "1A", "Dana Whitfield", "Occupied", "640", "dana.w@gmail.com", "(206) 555-0134", "1850", "1850", "2026-03-01", "2027-02-28", "", "", ""],
  ["Maple Court", "220 Maple Ave", "Seattle", "WA", "98103", "1B", "Marcus Bell", "Occupied", "620", "mbell@outlook.com", "(206) 555-0177", "1795", "1795", "2025-11-15", "2026-11-14", "", "350", ""],
  ["Maple Court", "220 Maple Ave", "Seattle", "WA", "98103", "2A", "", "Vacant", "655", "", "", "1900", "", "", "", "", "", ""],
  ["Maple Court", "220 Maple Ave", "Seattle", "WA", "98103", "2B", "Priya Nair & Tom Ellis", "Occupied", "780", "priya.nair@me.com", "(425) 555-0190", "2100", "2100", "2026-06-01", "2027-05-31", "", "", ""],
  ["", "1412 Pine St", "Seattle", "WA", "98101", "Room 1", "Jae Park", "Occupied", "", "jae.park@proton.me", "(206) 555-0102", "950", "950", "2026-01-01", "", "", "", ""],
  ["", "1412 Pine St", "Seattle", "WA", "98101", "Room 2", "", "Vacant", "", "", "", "925", "", "", "", "", "", ""],
  ["", "1412 Pine St", "Seattle", "WA", "98101", "Room 3", "Luis Ortega", "Occupied", "", "", "(206) 555-0166", "975", "975", "2025-11-01", "2026-10-31", "", "", ""],
  ["Total", "", "", "", "", "", "", "", "", "", "", "10495", "", "", "", "", "", ""],
];
writeFileSync(path.join(outDir, "generic.csv"), toCsv([genericHeaders, ...genericRows]), "utf8");

console.log("Wrote fixtures to", outDir);
