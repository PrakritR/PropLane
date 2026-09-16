import * as XLSX from "xlsx";
import { writeFileSync } from "node:fs";
const wb = XLSX.utils.book_new();
// Tab 1: an owner's own sheet — title rows, merged header, blank spacer rows, a totals row, market rent AND rent columns.
const s1 = [
  ["Prakrit Rentals — 2026 Rent Roll", "", "", "", "", ""],
  ["", "", "", "", "", ""],
  ["House", "Room / Unit", "Market Rent", "Rent", "Deposit", "Notes"],
  ["400 Pike Street, Seattle WA 98101", "A", 1150, 1050, 1050, "corner room"],
  ["", "B", 1050, 975, 975, ""],
  ["", "C", 1000, 925, 925, ""],
  ["", "D", 1050, 950, 950, "shares bath w/ C"],
  ["", "", "", "", "", ""],
  ["5031 Brooklyn Ave NE, Seattle WA 98105", "1", 1000, 950, 950, ""],
  ["", "2", 1000, 950, 950, ""],
  ["", "3", 1050, 975, 975, ""],
  ["", "4", 1000, 925, 925, ""],
  ["", "5", 1000, 950, 950, ""],
  ["", "", "", "", "", ""],
  ["TOTAL", "", 10450, 9650, 9650, ""],
];
XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(s1), "Houses");
// Tab 2: whole-place condos, one per row, in a different layout.
const s2 = [
  ["Condos (whole place)"],
  [],
  ["Address", "City", "Zip", "Beds", "Baths", "Monthly", "Sec Dep"],
  ["918 Harvard Ave E", "Seattle", "", 2, 1, 2650, 2650],
  ["77 S Washington St #4", "Seattle", 98104, 1, 1, 1900, 1900],
  [],
  ["Subtotal", "", "", "", "", 4550, 4550],
];
XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(s2), "Condos");
// Tab 3: totals only
XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([["Summary"], ["Gross monthly", 14200], ["Deposits held", 14200]]), "Summary");
writeFileSync("tests/fixtures/portfolio-import/owner-messy.xlsx", XLSX.write(wb, { type: "buffer", bookType: "xlsx" }));
console.log("wrote owner-messy.xlsx");
