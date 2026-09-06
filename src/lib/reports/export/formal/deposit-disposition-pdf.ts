/**
 * Formal Security Deposit Disposition Statement (Financials plan §9.4). A
 * move-out letter itemizing amounts withheld from a held deposit and the
 * refund due to the resident — the document a manager mails/emails to satisfy
 * state security-deposit accounting statutes. Uses the shared Blue Steel
 * pdf-theme so it reads as one system with the other formal documents.
 */
import type { PDFPage } from "pdf-lib";
import {
  createPdfTheme,
  drawDocumentHeader,
  drawHighlightLine,
  drawInfoBlock,
  drawStandardFooter,
  drawTableHeaderRow,
  drawTableRow,
  drawText,
  drawTotalsRow,
  drawWrappedText,
  ensurePageSpace,
  infoBlockHeight,
  wrappedTextHeight,
  PDF_COLORS,
  PDF_PAGE,
  type PdfTheme,
} from "@/lib/reports/export/pdf-theme";

const CONTENT_WIDTH = PDF_PAGE.width - PDF_PAGE.margin * 2;

export type DepositDispositionLine = { label: string; amount: string };

export type DepositDispositionDocument = {
  issueDate: string;
  landlordName: string;
  landlordAddress: string;
  residentName: string;
  residentEmail: string;
  propertyLabel: string;
  unitLabel: string;
  depositReceivedDate: string;
  dispositionType: string;
  depositHeld: string;
  itemization: DepositDispositionLine[];
  totalWithheld: string;
  refundDue: string;
  priorRefunds?: string;
  evidenceReferences?: string[];
};

const DISPOSITION_FOOTER =
  "This statement itemizes deductions from the security deposit held in trust and the balance refunded. Retain for your records. If you dispute any deduction, contact your property manager in writing within the period allowed by your state's security-deposit statute.";

type Cursor = { theme: PdfTheme; page: PDFPage; y: number };

function reserve(cursor: Cursor, needed: number) {
  const next = ensurePageSpace(cursor.theme, cursor.page, cursor.y, needed);
  cursor.page = next.page;
  cursor.y = next.y;
}

function line(cursor: Cursor, text: string, size = 10, bold = false) {
  reserve(cursor, size + 6);
  drawText(cursor.page, text, PDF_PAGE.margin, cursor.y, size, bold ? cursor.theme.bold : cursor.theme.regular, undefined, CONTENT_WIDTH);
  cursor.y -= size + 6;
}

function block(cursor: Cursor, label: string, lines: string[]) {
  reserve(cursor, infoBlockHeight(lines) + 10);
  cursor.y = drawInfoBlock(cursor.page, cursor.theme, { label, lines, x: PDF_PAGE.margin, y: cursor.y, width: CONTENT_WIDTH });
  cursor.y -= 10;
}

export async function buildDepositDispositionPdf(doc: DepositDispositionDocument): Promise<Uint8Array> {
  const theme = await createPdfTheme();
  const page = theme.pdf.addPage([PDF_PAGE.width, PDF_PAGE.height]);
  const y = drawDocumentHeader(page, theme, { title: "Security Deposit Disposition", subtitle: `Issued ${doc.issueDate}`, contentWidth: CONTENT_WIDTH });
  const cursor: Cursor = { theme, page, y };

  block(cursor, "Landlord / Agent", [doc.landlordName, ...doc.landlordAddress.split("\n")]);
  block(cursor, "Resident", [doc.residentName, doc.residentEmail]);
  block(cursor, "Rental property", [`${doc.propertyLabel}${doc.unitLabel ? ` · ${doc.unitLabel}` : ""}`]);

  line(cursor, `Deposit received: ${doc.depositReceivedDate}`, 10);
  line(cursor, `Disposition type: ${doc.dispositionType}`, 10);
  cursor.y -= 2;

  reserve(cursor, 30 + 10);
  cursor.y = drawHighlightLine(cursor.page, cursor.theme, { label: "Deposit held", value: doc.depositHeld, x: PDF_PAGE.margin, y: cursor.y, width: CONTENT_WIDTH });
  cursor.y -= 14;

  line(cursor, "Itemized deductions", 11, true);
  const widths = [CONTENT_WIDTH * 0.7, CONTENT_WIDTH * 0.3];
  reserve(cursor, 22);
  cursor.y = drawTableHeaderRow(cursor.page, cursor.theme, [{ label: "Description" }, { label: "Amount", align: "right" }], widths, PDF_PAGE.margin, cursor.y);
  if (doc.itemization.length === 0) {
    reserve(cursor, 18);
    cursor.y = drawTableRow(cursor.page, cursor.theme, [{ value: "No deductions" }, { value: "$0.00", align: "right" }], widths, PDF_PAGE.margin, cursor.y, {});
  } else {
    doc.itemization.forEach((item, index) => {
      reserve(cursor, 18);
      cursor.y = drawTableRow(cursor.page, cursor.theme, [{ value: item.label }, { value: item.amount, align: "right" }], widths, PDF_PAGE.margin, cursor.y, { zebra: index % 2 === 1 });
    });
  }
  reserve(cursor, 22);
  cursor.y = drawTotalsRow(cursor.page, cursor.theme, [{ value: "Total withheld" }, { value: doc.totalWithheld, align: "right" }], widths, PDF_PAGE.margin, cursor.y);
  cursor.y -= 14;

  reserve(cursor, 30 + 12);
  cursor.y = drawHighlightLine(cursor.page, cursor.theme, { label: "Refund due to resident", value: doc.refundDue, x: PDF_PAGE.margin, y: cursor.y, width: CONTENT_WIDTH });
  cursor.y -= 14;

  if (doc.priorRefunds) line(cursor, `Previously refunded: ${doc.priorRefunds}`);
  if (doc.evidenceReferences?.length) {
    line(cursor, "Supporting evidence references", 11, true);
    for (const reference of doc.evidenceReferences) {
      const height = wrappedTextHeight(theme.regular, reference, 8.5, CONTENT_WIDTH);
      reserve(cursor, height + 8);
      drawWrappedText(cursor.page, reference, PDF_PAGE.margin, cursor.y, 8.5, theme.regular, CONTENT_WIDTH, PDF_COLORS.muted);
      cursor.y -= height + 8;
    }
  }

  reserve(cursor, 10 + wrappedTextHeight(theme.regular, DISPOSITION_FOOTER, 8.5, CONTENT_WIDTH));
  cursor.y -= 10;
  drawWrappedText(cursor.page, DISPOSITION_FOOTER, PDF_PAGE.margin, cursor.y, 8.5, theme.regular, CONTENT_WIDTH, PDF_COLORS.muted);

  drawStandardFooter(theme, CONTENT_WIDTH);
  return theme.pdf.save();
}
