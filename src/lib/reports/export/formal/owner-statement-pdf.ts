/**
 * Formal Owner Statement (Financials plan §9.5). A letter-style period
 * statement an agent sends a property owner: collections in, expenses out,
 * management fee, reserve holdback, and the net distribution — plus unpaid AP
 * still due. Uses the shared Blue Steel pdf-theme.
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
  drawWrappedText,
  ensurePageSpace,
  infoBlockHeight,
  wrappedTextHeight,
  PDF_COLORS,
  PDF_PAGE,
  type PdfTheme,
} from "@/lib/reports/export/pdf-theme";

const CONTENT_WIDTH = PDF_PAGE.width - PDF_PAGE.margin * 2;

export type OwnerStatementLine = { label: string; amount: string; emphasize?: boolean };

export type OwnerStatementDocument = {
  issueDate: string;
  periodFrom: string;
  periodTo: string;
  landlordName: string;
  landlordAddress: string;
  ownerName: string;
  propertyLabel: string;
  lines: OwnerStatementLine[];
  distribution: string;
  /** Omitted for the owner's own copy: unpaid bills are an operational (vendor) figure. */
  billsDue?: string;
};

const OWNER_STATEMENT_FOOTER =
  "Prepared from PropLane property records for the period shown. Distribution reflects cash collected less expenses paid, management fee, and reserve holdback. Unpaid bills (AP) are shown for information and are not yet deducted from cash.";

const OWNER_STATEMENT_FOOTER_OWNER_COPY =
  "Prepared from PropLane property records for the period shown. Distribution reflects cash collected less expenses paid, management fee, and reserve holdback.";

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

export async function buildOwnerStatementPdf(doc: OwnerStatementDocument): Promise<Uint8Array> {
  const theme = await createPdfTheme();
  const page = theme.pdf.addPage([PDF_PAGE.width, PDF_PAGE.height]);
  const y = drawDocumentHeader(page, theme, {
    title: "Owner Statement",
    subtitle: `Period: ${doc.periodFrom} through ${doc.periodTo}`,
    contentWidth: CONTENT_WIDTH,
  });
  const cursor: Cursor = { theme, page, y };

  block(cursor, "Managing agent", [doc.landlordName, ...doc.landlordAddress.split("\n")]);
  block(cursor, "Owner", [doc.ownerName]);
  block(cursor, "Property", [doc.propertyLabel]);
  line(cursor, `Issued: ${doc.issueDate}`, 10);
  cursor.y -= 4;

  const widths = [CONTENT_WIDTH * 0.7, CONTENT_WIDTH * 0.3];
  reserve(cursor, 22);
  cursor.y = drawTableHeaderRow(cursor.page, cursor.theme, [{ label: "Line" }, { label: "Amount", align: "right" }], widths, PDF_PAGE.margin, cursor.y);
  doc.lines.forEach((item, index) => {
    reserve(cursor, 18);
    cursor.y = drawTableRow(
      cursor.page,
      cursor.theme,
      [{ value: item.label }, { value: item.amount, align: "right" }],
      widths,
      PDF_PAGE.margin,
      cursor.y,
      { zebra: index % 2 === 1, bold: item.emphasize },
    );
  });
  cursor.y -= 14;

  reserve(cursor, 30 + 12);
  cursor.y = drawHighlightLine(cursor.page, cursor.theme, { label: "Net distribution to owner", value: doc.distribution, x: PDF_PAGE.margin, y: cursor.y, width: CONTENT_WIDTH });
  cursor.y -= 10;
  if (doc.billsDue !== undefined) {
    line(cursor, `Unpaid bills (AP) outstanding: ${doc.billsDue}`, 9);
    cursor.y -= 6;
  }

  const footer = doc.billsDue !== undefined ? OWNER_STATEMENT_FOOTER : OWNER_STATEMENT_FOOTER_OWNER_COPY;
  reserve(cursor, 10 + wrappedTextHeight(theme.regular, footer, 8.5, CONTENT_WIDTH));
  cursor.y -= 10;
  drawWrappedText(cursor.page, footer, PDF_PAGE.margin, cursor.y, 8.5, theme.regular, CONTENT_WIDTH, PDF_COLORS.muted);

  drawStandardFooter(theme, CONTENT_WIDTH);
  return theme.pdf.save();
}
