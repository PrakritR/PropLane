/**
 * Regenerates the portfolio-import PDF test fixtures with pdf-lib.
 *
 *   node scripts/testing/generate-portfolio-import-pdf-fixtures.mjs
 *
 * `rent-roll.pdf` is a real, text-based two-property rent roll used to test
 * text extraction and the AI table read. `scan-no-text.pdf` is a one-page PDF
 * with only a drawn rectangle and no text, used to test the unreadable-scan
 * path.
 */
import { writeFile } from "node:fs/promises";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";

const RENT_ROLL_LINES = [
  "Rent Roll — as of Sep 14, 2026",
  "",
  "Maple Court — 220 Maple Ave, Seattle, WA 98103",
  "1A  Dana Whitfield  dana.w@gmail.com  (206) 555-0134  $1,850  $1,850  03/01/2026  02/28/2027",
  "1B  Marcus Bell  mbell@outlook.com  (206) 555-0177  $1,795  $1,795  11/15/2025  11/14/2026  Past due $350",
  "2A  Vacant  $1,900",
  "2B  Priya Nair & Tom Ellis  priya.nair@me.com  (425) 555-0190  $2,100  $2,100  06/01/2026  05/31/2027",
  "",
  "1412 Pine St — Seattle, WA 98101",
  "Room 1  Jae Park  jae.park@proton.me  (206) 555-0102  $950  $950  01/01/2026  month-to-month",
  "Room 2  Vacant  $925",
  "Room 3  Luis Ortega  (206) 555-0166  $975  $975  11/01/2025  10/31/2026",
  "Total  $9,495",
];

async function buildRentRollPdf() {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const size = 10;
  let page = pdf.addPage([612, 792]);
  let y = 748;
  for (const line of RENT_ROLL_LINES) {
    if (y < 60) {
      page = pdf.addPage([612, 792]);
      y = 748;
    }
    page.drawText(line, { x: 46, y, size, font });
    y -= 16;
  }
  return pdf.save();
}

async function buildScanNoTextPdf() {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([612, 792]);
  // Only a drawn rectangle — no text layer, the way a photo-scanned page looks
  // to a text extractor.
  page.drawRectangle({ x: 100, y: 400, width: 400, height: 300, color: rgb(0.85, 0.85, 0.85) });
  return pdf.save();
}

const rentRollBytes = await buildRentRollPdf();
const scanBytes = await buildScanNoTextPdf();

await writeFile("tests/fixtures/portfolio-import/rent-roll.pdf", rentRollBytes);
await writeFile("tests/fixtures/portfolio-import/scan-no-text.pdf", scanBytes);

console.log("Wrote tests/fixtures/portfolio-import/rent-roll.pdf and scan-no-text.pdf");
