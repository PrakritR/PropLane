/**
 * Client-built document files for the `/demo` sandbox. The real Documents tabs
 * download application PDFs and rent receipts from authenticated API routes;
 * the demo builds equivalent PDFs in the browser (pdf-lib is already the PDF
 * engine for the server application PDF) and hands back data URLs that work in
 * both the inline preview iframe and the download anchor. Import this module
 * dynamically from demo code paths only — it must stay out of the real portal
 * bundles.
 */
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import type { DemoApplicantRow } from "@/data/demo-portal";
import type { CosignerSubmission } from "@/lib/cosigner-submissions-storage";
import { buildApplicationPdf } from "@/lib/manager-application-pdf";
import { buildBackgroundCheckReportHtml } from "@/lib/background-check-report-html";

function bytesToPdfDataUrl(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return `data:application/pdf;base64,${btoa(binary)}`;
}

/** The resident's rental application as a locally-built PDF data URL. */
export async function buildDemoApplicationPdfDataUrl(
  row: DemoApplicantRow,
  roomLabel?: string,
  cosignerSubmissions?: CosignerSubmission[],
  groupMembers?: import("@/lib/rental-application/application-groups").ApplicationGroupMember[],
): Promise<string> {
  const bytes = await buildApplicationPdf(row, { roomLabel, cosignerSubmissions, groupMembers });
  return bytesToPdfDataUrl(bytes);
}

/** A one-payment rent receipt as a locally-built PDF data URL. */
export async function buildDemoReceiptPdfDataUrl(input: {
  residentName: string;
  description: string;
  amountLabel: string;
  dateLabel: string;
}): Promise<string> {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([612, 792]);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const regular = await pdf.embedFont(StandardFonts.Helvetica);
  const ink = rgb(0.13, 0.15, 0.19);
  const muted = rgb(0.42, 0.45, 0.52);

  let y = 716;
  const line = (text: string, font = regular, size = 11, color = ink) => {
    page.drawText(text, { x: 72, y, size, font, color });
    y -= size + 12;
  };

  line("RENT RECEIPT", bold, 18);
  line("PropLane Housing Management · Seattle, WA", regular, 10, muted);
  y -= 16;
  line(`Received from:  ${input.residentName}`);
  line(`For:            ${input.description}`);
  line(`Amount paid:    ${input.amountLabel}`);
  line(`Payment date:   ${input.dateLabel}`);
  line("Payment method: PropLane ACH");
  y -= 16;
  line("Thank you — this receipt confirms your payment was recorded.", regular, 10, muted);
  line("Sample receipt generated for the PropLane interactive demo.", regular, 9, muted);

  return bytesToPdfDataUrl(await pdf.save());
}

function stripHtml(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Screening / background-check report as a locally-built PDF data URL for `/demo`. */
export async function buildDemoBackgroundCheckPdfDataUrl(row: DemoApplicantRow): Promise<string> {
  const bg = row.backgroundCheck;
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([612, 792]);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const regular = await pdf.embedFont(StandardFonts.Helvetica);
  const ink = rgb(0.13, 0.15, 0.19);
  const muted = rgb(0.42, 0.45, 0.52);

  let y = 716;
  const line = (text: string, font = regular, size = 11, color = ink) => {
    const maxWidth = 468;
    let chunk = text;
    while (chunk.length > 0) {
      let slice = chunk.length;
      while (slice > 0 && font.widthOfTextAtSize(chunk.slice(0, slice), size) > maxWidth) slice -= 1;
      if (slice === 0) slice = 1;
      page.drawText(chunk.slice(0, slice), { x: 72, y, size, font, color });
      chunk = chunk.slice(slice).trimStart();
      y -= size + 10;
      if (y < 72) break;
    }
  };

  line("BACKGROUND CHECK REPORT", bold, 18);
  line("PropLane Housing · Demo screening record", regular, 10, muted);
  y -= 8;
  line(`Applicant: ${row.name || "Applicant"}`);
  line(`PropLane ID: ${row.id}`);
  if (bg) {
    line(`Status: ${bg.status}`);
    line(`Result: ${bg.result ?? "Pending"}`);
    line(`Package: ${bg.packageSlug}`);
    if (bg.orderedAt) line(`Ordered: ${new Date(bg.orderedAt).toLocaleDateString()}`);
    if (bg.completedAt) line(`Completed: ${new Date(bg.completedAt).toLocaleDateString()}`);
  }
  y -= 8;
  const summary = stripHtml(buildBackgroundCheckReportHtml(row));
  if (summary) {
    line("Report summary", bold, 12);
    line(summary.slice(0, 2400), regular, 9, muted);
  }
  line("Sample report generated for the PropLane interactive demo.", regular, 9, muted);

  return bytesToPdfDataUrl(await pdf.save());
}

/** Trigger a browser download of the demo screening PDF. */
export async function downloadDemoBackgroundCheckPdf(row: DemoApplicantRow): Promise<void> {
  const url = await buildDemoBackgroundCheckPdfDataUrl(row);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `screening-report-${row.id}.pdf`;
  anchor.rel = "noopener";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
}
