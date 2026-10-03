import { PDFDocument, type PDFPage } from "pdf-lib";
import {
  DAYS_RENTED_FOOTER,
  RENT_RECEIPT_FOOTER,
  type DaysRentedDocument,
  type FormalFieldKey,
  type PropertyRentReceiptDocument,
  type RentReceiptDocument,
} from "@/lib/reports/formal-documents/spec";
import {
  createPdfTheme,
  drawDocumentHeader,
  drawHighlightLine,
  drawInfoBlock,
  drawStandardFooter,
  drawText,
  drawWrappedText,
  ensurePageSpace,
  infoBlockHeight,
  wrappedTextHeight,
  PDF_COLORS,
  PDF_PAGE,
  type PdfTheme,
} from "@/lib/reports/export/pdf-theme";

function includes(fields: FormalFieldKey[] | undefined, key: FormalFieldKey): boolean {
  if (!fields?.length) return true;
  return fields.includes(key);
}

const CONTENT_WIDTH = PDF_PAGE.width - PDF_PAGE.margin * 2;

type FormCursor = { theme: PdfTheme; page: PDFPage; y: number };

async function createFormDocument(title: string): Promise<FormCursor> {
  const theme = await createPdfTheme();
  const page = theme.pdf.addPage([PDF_PAGE.width, PDF_PAGE.height]);
  const y = drawDocumentHeader(page, theme, { title, contentWidth: CONTENT_WIDTH });
  return { theme, page, y };
}

function reserve(cursor: FormCursor, needed: number) {
  const next = ensurePageSpace(cursor.theme, cursor.page, cursor.y, needed);
  cursor.page = next.page;
  cursor.y = next.y;
}

function drawLine(cursor: FormCursor, text: string, size = 10, bold = false) {
  reserve(cursor, size + 6);
  drawText(
    cursor.page,
    text,
    PDF_PAGE.margin,
    cursor.y,
    size,
    bold ? cursor.theme.bold : cursor.theme.regular,
    undefined,
    CONTENT_WIDTH,
  );
  cursor.y -= size + 6;
}

function drawBlock(cursor: FormCursor, label: string, lines: string[]) {
  reserve(cursor, infoBlockHeight(lines) + 10);
  cursor.y = drawInfoBlock(cursor.page, cursor.theme, {
    label,
    lines,
    x: PDF_PAGE.margin,
    y: cursor.y,
    width: CONTENT_WIDTH,
  });
  cursor.y -= 10;
}

function drawHighlight(cursor: FormCursor, label: string, value: string, gap: number) {
  reserve(cursor, 30 + gap);
  cursor.y = drawHighlightLine(cursor.page, cursor.theme, {
    label,
    value,
    x: PDF_PAGE.margin,
    y: cursor.y,
    width: CONTENT_WIDTH,
  });
  cursor.y -= gap;
}

function drawFooterNote(cursor: FormCursor, text: string, leadGap: number) {
  reserve(cursor, leadGap + wrappedTextHeight(cursor.theme.regular, text, 8.5, CONTENT_WIDTH));
  cursor.y -= leadGap;
  drawWrappedText(cursor.page, text, PDF_PAGE.margin, cursor.y, 8.5, cursor.theme.regular, CONTENT_WIDTH, PDF_COLORS.muted);
}

export async function buildRentReceiptPdf(
  doc: RentReceiptDocument,
  includeFields?: FormalFieldKey[],
): Promise<Uint8Array> {
  const cursor = await createFormDocument("Rent Receipt");
  const { theme } = cursor;

  if (includes(includeFields, "receiptNumber")) drawLine(cursor, `Receipt #: ${doc.receiptNumber}`, 11, true);
  if (includes(includeFields, "issueDate")) drawLine(cursor, `Issue date: ${doc.issueDate}`, 10);
  cursor.y -= 4;

  if (includes(includeFields, "landlordBlock")) {
    drawBlock(cursor, "Received by (landlord)", [doc.landlordName, ...doc.landlordAddress.split("\n")]);
  }

  if (includes(includeFields, "tenantBlock")) {
    drawBlock(cursor, "Paid by (tenant)", [doc.tenantName, doc.tenantEmail]);
  }

  if (includes(includeFields, "propertyBlock")) {
    drawBlock(cursor, "Rental property", [`${doc.propertyLabel} · ${doc.unitLabel}`, doc.propertyAddress]);
  }

  if (includes(includeFields, "amount")) {
    drawHighlight(cursor, "Amount received", doc.amount, 12);
  }
  if (doc.processingFeeLabel?.trim()) drawLine(cursor, `Processing fee: ${doc.processingFeeLabel.trim()}`);
  if (doc.totalChargedLabel?.trim()) drawLine(cursor, `Total charged: ${doc.totalChargedLabel.trim()}`, 11, true);

  if (includes(includeFields, "paymentDate")) drawLine(cursor, `Payment date: ${doc.paymentDate}`);
  if (includes(includeFields, "paymentMethod")) drawLine(cursor, `Payment method: ${doc.paymentMethod}`);
  if (includes(includeFields, "periodCovered")) drawLine(cursor, `Period / description: ${doc.periodCovered}`);
  if (includes(includeFields, "category")) drawLine(cursor, `Category: ${doc.category}`);
  if (includes(includeFields, "daysRented") && doc.daysRented != null) {
    drawLine(cursor, `Days rented (period): ${doc.daysRented}`);
  }
  if (includes(includeFields, "daysAvailable") && doc.daysAvailable != null) {
    drawLine(cursor, `Days available (period): ${doc.daysAvailable}`);
  }
  if (includes(includeFields, "balanceAfter") && doc.balanceAfter) {
    drawLine(cursor, `Balance after payment: ${doc.balanceAfter}`);
  }

  drawFooterNote(cursor, RENT_RECEIPT_FOOTER, 10);

  drawStandardFooter(theme, CONTENT_WIDTH);
  return theme.pdf.save();
}

export async function buildDaysRentedPdf(
  doc: DaysRentedDocument,
  includeFields?: FormalFieldKey[],
): Promise<Uint8Array> {
  const cursor = await createFormDocument("Days Rented Statement");
  const { theme } = cursor;

  if (includes(includeFields, "issueDate")) drawLine(cursor, `Issue date: ${doc.issueDate}`);
  drawLine(cursor, `Period: ${doc.periodFrom} — ${doc.periodTo}`);
  drawLine(cursor, `Scope: ${doc.scopeLabel}`, 10, true);
  cursor.y -= 4;

  if (includes(includeFields, "landlordBlock")) {
    drawBlock(cursor, "Landlord", [doc.landlordName, ...doc.landlordAddress.split("\n")]);
  }

  drawLine(cursor, "Occupancy summary", 11, true);
  for (const row of doc.rows.slice(0, 30)) {
    drawLine(
      cursor,
      `${row.property} · ${row.unit} · ${row.resident}: ${row.daysRented} days rented / ${row.daysAvailable} available`,
      9,
    );
  }
  cursor.y -= 4;

  if (includes(includeFields, "daysRented")) {
    drawHighlight(cursor, "Total days rented", String(doc.totalDaysRented), 10);
  }
  if (includes(includeFields, "daysAvailable")) drawLine(cursor, `Units in scope: ${doc.unitCount}`);

  if (includes(includeFields, "personalUseNote")) {
    drawFooterNote(cursor, DAYS_RENTED_FOOTER, 8);
  }

  drawStandardFooter(theme, CONTENT_WIDTH);
  return theme.pdf.save();
}

export async function buildRentReceiptsCombinedPdf(
  documents: RentReceiptDocument[],
  includeFields?: FormalFieldKey[],
): Promise<Uint8Array> {
  if (documents.length === 1) {
    return buildRentReceiptPdf(documents[0]!, includeFields);
  }
  const pdf = await PDFDocument.create();
  for (const doc of documents) {
    const single = await buildRentReceiptPdf(doc, includeFields);
    const loaded = await PDFDocument.load(single);
    const pages = await pdf.copyPages(loaded, loaded.getPageIndices());
    for (const p of pages) pdf.addPage(p);
  }
  return pdf.save();
}

export async function buildPropertyRentReceiptPdf(
  doc: PropertyRentReceiptDocument,
  includeFields?: FormalFieldKey[],
): Promise<Uint8Array> {
  const cursor = await createFormDocument("Property Rent Receipt");
  const { theme } = cursor;

  if (includes(includeFields, "issueDate")) drawLine(cursor, `Issue date: ${doc.issueDate}`);
  drawLine(cursor, `Period: ${doc.periodFrom} — ${doc.periodTo}`);
  cursor.y -= 4;

  if (includes(includeFields, "landlordBlock")) {
    drawBlock(cursor, "Landlord", [doc.landlordName, ...doc.landlordAddress.split("\n")]);
  }

  if (includes(includeFields, "propertyBlock")) {
    drawBlock(cursor, "Rental property", [doc.propertyLabel]);
  }

  if (includes(includeFields, "amount")) {
    drawHighlight(cursor, "Rent collected", doc.rentCollected, 12);
  }

  drawLine(cursor, "Occupancy & income summary", 11, true);
  if (includes(includeFields, "daysRented")) drawLine(cursor, `Total days rented: ${doc.daysRented}`, 11, true);
  if (includes(includeFields, "daysAvailable")) drawLine(cursor, `Total days available: ${doc.daysAvailable}`);
  drawLine(cursor, `Rental use: ${doc.rentalUsePct}%`);
  if (includes(includeFields, "periodCovered")) drawLine(cursor, `Payment receipts: ${doc.receiptCount}`);
  cursor.y -= 4;

  drawLine(cursor, "By unit", 11, true);
  for (const unit of doc.units.slice(0, 25)) {
    drawLine(
      cursor,
      `${unit.unit} · ${unit.resident}: ${unit.daysRented}/${unit.daysAvailable} days · ${unit.rentCollected} (${unit.receiptCount} receipt${unit.receiptCount === 1 ? "" : "s"})`,
      9,
    );
  }

  if (includes(includeFields, "personalUseNote")) {
    drawFooterNote(cursor, DAYS_RENTED_FOOTER, 8);
  }

  drawStandardFooter(theme, CONTENT_WIDTH);
  return theme.pdf.save();
}

export async function buildPropertyRentReceiptsCombinedPdf(
  documents: PropertyRentReceiptDocument[],
  includeFields?: FormalFieldKey[],
): Promise<Uint8Array> {
  if (documents.length === 1) {
    return buildPropertyRentReceiptPdf(documents[0]!, includeFields);
  }
  const pdf = await PDFDocument.create();
  for (const doc of documents) {
    const single = await buildPropertyRentReceiptPdf(doc, includeFields);
    const loaded = await PDFDocument.load(single);
    const pages = await pdf.copyPages(loaded, loaded.getPageIndices());
    for (const p of pages) pdf.addPage(p);
  }
  return pdf.save();
}
