import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import {
  LEASE_ESIGN_CONSENT_TEXT,
  LEASE_ESIGN_CONSENT_VERSION,
  documentFingerprintLabel,
  signedDocumentHashesDiverge,
} from "@/lib/lease-execution-evidence";
import { resolveSubmissionRoom } from "@/lib/listing-room-resolution";
import { formatRoomPriceAmount, resolveStayPricing } from "@/lib/room-pricing";
import type { LeaseGenerationContext } from "@/lib/generated-lease";
import type { LeasePipelineRow } from "@/lib/lease-pipeline-storage";
import { formatPacificDateTime } from "@/lib/pacific-time";

function dataUrlToBytes(dataUrl: string): Uint8Array {
  const base64 = dataUrl.split(",")[1] ?? "";
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function bytesToDataUrl(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]!);
  return `data:application/pdf;base64,${btoa(binary)}`;
}

function signatureLine(row: LeasePipelineRow, role: "resident" | "manager"): string {
  const sig = role === "resident" ? row.residentSignature : row.managerSignature;
  if (!sig?.name) return "Pending";
  return `Signed by ${sig.name} · ${formatPacificDateTime(new Date(sig.signedAtIso))}`;
}

function riderMoney(amount: number | undefined): string {
  return amount === undefined ? "Not set" : formatRoomPriceAmount(amount);
}

function riderLines(ctx: LeaseGenerationContext): string[] {
  const application = ctx.application;
  const property = ctx.leasedRoom ?? ctx.listingProperty;
  const room = resolveSubmissionRoom(ctx.submission, {
    roomChoices: [application.roomChoice1],
    unitLabel: property?.unitLabel,
  });
  const pricing = resolveStayPricing({ room, submission: ctx.submission, application });
  // The rider DECLARES ITSELF CONTROLLING and sits inside the signed hash, so the rate on it
  // has to be the rate that will actually be billed. resolveStayPricing cannot see a
  // negotiated or bundle rent from `application` alone: the signed rent travels separately,
  // and a bundle prices the whole group rather than the room. leaseBilling carries the figure
  // the ledger uses, so it wins when present, exactly as the long-form lease does.
  const billedMonthly = ctx.leaseBilling?.monthlyRent;
  const rate =
    pricing.basis === "daily"
      ? pricing.dailyRate
      : pricing.basis === "weekly"
        ? pricing.weeklyRate
        : (billedMonthly && billedMonthly > 0 ? billedMonthly : pricing.monthlyRate);
  const propertyName = property?.address?.trim() || ctx.submission?.address?.trim() || "Not set";
  const roomName = property?.unitLabel?.trim() || room?.name?.trim() || "Not set";
  const fees = [
    ctx.leaseBilling?.moveInFee ? `Move-in fee: ${riderMoney(ctx.leaseBilling.moveInFee)}` : "",
    ctx.leaseBilling?.applicationFee ? `Application fee: ${riderMoney(ctx.leaseBilling.applicationFee)}` : "",
    ctx.leaseBilling?.otherCostAmount
      ? `${ctx.leaseBilling.otherCostLabel?.trim() || "Other fee"}: ${riderMoney(ctx.leaseBilling.otherCostAmount)}`
      : "",
  ].filter(Boolean);

  return [
    `Resident / Tenant: ${application.fullLegalName?.trim() || "Resident"}`,
    `Property: ${propertyName}`,
    `Room / unit: ${roomName}`,
    `Stay dates: ${application.leaseStart?.trim() || "Not set"} to ${application.leaseEnd?.trim() || "Not set"}`,
    `Rent basis: ${pricing.basis === "daily" ? "Daily" : pricing.basis === "weekly" ? "Weekly" : "Monthly"}`,
    `${pricing.basis === "daily" ? "Daily rate" : pricing.basis === "weekly" ? "Weekly rent" : "Monthly rent"}: ${riderMoney(rate)}`,
    `Security deposit: ${riderMoney(pricing.deposit)}`,
    ...fees,
  ];
}

/**
 * Build the terms PropLane resolved for this placement as a separate rider.
 * The manager's PDF is never edited or reconstructed. The caller appends this
 * page after the base PDF and before the electronic-signature certificate.
 */
export async function buildLeaseTermsRiderPdf(ctx: LeaseGenerationContext): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([612, 792]);
  const regular = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const margin = 54;
  const maxWidth = 612 - margin * 2;
  let y = 720;
  const safe = (text: string) => text.replace(/[^\x20-\x7E\xA0-\xFF]/g, "?");

  const drawWrapped = (text: string, size: number, font = regular, lead = 8) => {
    let line = "";
    for (const word of safe(text).split(/\s+/)) {
      const candidate = line ? `${line} ${word}` : word;
      if (line && font.widthOfTextAtSize(candidate, size) > maxWidth) {
        page.drawText(line, { x: margin, y, size, font, color: rgb(0.1, 0.1, 0.1) });
        y -= size + lead;
        line = word;
      } else {
        line = candidate;
      }
    }
    if (line) {
      page.drawText(line, { x: margin, y, size, font, color: rgb(0.1, 0.1, 0.1) });
      y -= size + lead;
    }
  };

  drawWrapped("TERMS RIDER", 16, bold, 12);
  drawWrapped(
    "This Terms Rider is attached to the manager's lease document. If this Terms Rider conflicts with the base document, this Terms Rider controls for that conflict.",
    10,
  );
  y -= 8;
  for (const line of riderLines(ctx)) drawWrapped(line, 11, regular, 8);
  return pdf.save();
}

/** Append the binding terms rider to the untouched manager PDF. */
export async function appendLeaseTermsRiderToPdf(
  originalDataUrl: string,
  ctx: LeaseGenerationContext,
): Promise<string> {
  const baseDoc = await PDFDocument.load(dataUrlToBytes(originalDataUrl));
  const riderDoc = await PDFDocument.load(await buildLeaseTermsRiderPdf(ctx));
  const pages = await baseDoc.copyPages(riderDoc, riderDoc.getPageIndices());
  for (const page of pages) baseDoc.addPage(page);
  return bytesToDataUrl(await baseDoc.save());
}

/** Per-signature evidence lines, omitted for signatures recorded before they existed. */
function signatureEvidenceLines(row: LeasePipelineRow, role: "resident" | "manager"): string[] {
  const sig = role === "resident" ? row.residentSignature : row.managerSignature;
  if (!sig?.name) return [];
  const fingerprint = documentFingerprintLabel(sig.documentSha256);
  return [
    fingerprint ? `Document signed (fingerprint begins) ${fingerprint}` : "",
    // Only a version we can quote back counts as an attestation.
    sig.consentVersion === LEASE_ESIGN_CONSENT_VERSION ? "Consented to transact electronically before signing." : "",
  ].filter(Boolean);
}

export async function buildLeaseSignaturePagePdf(row: LeasePipelineRow): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([612, 792]);
  const regular = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const margin = 54;
  const maxWidth = 612 - margin * 2;
  let y = 720;

  // The standard fonts are WinAnsi-only and pdf-lib THROWS on anything outside
  // it. Resident names, unit labels and (soon) template ids are free text, so an
  // emoji or a CJK character would abort the whole certificate, and the caller
  // swallows that, silently shipping a signed PDF with no certificate page.
  // Losing one glyph beats losing the evidence.
  const winAnsiSafe = (text: string) => text.replace(/[^\x20-\x7E\xA0-\xFF]/g, "?");

  const put = (text: string, size: number, font: typeof regular, lead: number) => {
    if (y < margin) return; // never draw off the bottom of the page
    page.drawText(winAnsiSafe(text), { x: margin, y, size, font, color: rgb(0.1, 0.1, 0.1) });
    y -= size + lead;
  };

  const draw = (text: string, size: number, font = regular) => put(text, size, font, 10);

  const drawWrapped = (text: string, size: number, font = regular) => {
    let line = "";
    for (const word of winAnsiSafe(text).split(/\s+/)) {
      const candidate = line ? `${line} ${word}` : word;
      if (line && font.widthOfTextAtSize(candidate, size) > maxWidth) {
        put(line, size, font, 3);
        line = word;
        continue;
      }
      line = candidate;
    }
    if (line) put(line, size, font, 10);
  };

  draw("Electronic Signature Certificate", 16, bold);
  y -= 6;
  draw(`Property: ${row.unit}`, 11);
  draw(`Resident: ${row.residentName}`, 11);
  draw(`Lease record: ${row.id}`, 10);
  y -= 8;
  draw("Resident / Tenant", 12, bold);
  draw(signatureLine(row, "resident"), 11);
  for (const line of signatureEvidenceLines(row, "resident")) draw(line, 9);
  y -= 8;
  draw("Landlord / Manager", 12, bold);
  draw(signatureLine(row, "manager"), 11);
  for (const line of signatureEvidenceLines(row, "manager")) draw(line, 9);
  y -= 16;
  draw("Signatures apply to the attached lease document.", 10);
  draw("Typed names captured through the PropLane portal constitute electronic signatures.", 9);

  if (signedDocumentHashesDiverge(row)) {
    y -= 6;
    drawWrapped(
      "Warning: the two parties did not sign identical documents. Each fingerprint above identifies the document that party actually signed.",
      9,
      bold,
    );
  }

  // The FULL digest, not the readable prefix. A 64-bit prefix is a convenience
  // for comparing two certificates by eye, not something to stand behind.
  const provenance = [
    row.documentSha256 ? `Document fingerprint (SHA-256): ${row.documentSha256}` : "",
    row.templateVersion ? `Lease template: ${row.templateVersion}` : "",
    row.executedJurisdiction ? `Executed under: ${row.executedJurisdiction}` : "",
  ].filter(Boolean);
  if (provenance.length > 0) {
    y -= 6;
    // Wrapped, not `draw`: template id and jurisdiction are free strings.
    for (const line of provenance) drawWrapped(line, 9);
    drawWrapped(
      "The fingerprint is a SHA-256 checksum of the lease document exactly as it was presented for signature; it does not cover this certificate page. Any later change to the document, however small, produces a different fingerprint.",
      8,
    );
  }

  const consented =
    row.residentSignature?.consentVersion === LEASE_ESIGN_CONSENT_VERSION ||
    row.managerSignature?.consentVersion === LEASE_ESIGN_CONSENT_VERSION;
  if (consented) {
    y -= 4;
    drawWrapped(`Consent accepted before signing: "${LEASE_ESIGN_CONSENT_TEXT}"`, 8);
  }

  return pdf.save();
}

export async function appendSignaturePageToPdf(originalDataUrl: string, row: LeasePipelineRow): Promise<string> {
  const baseDoc = await PDFDocument.load(dataUrlToBytes(originalDataUrl));
  const sigBytes = await buildLeaseSignaturePagePdf(row);
  const sigDoc = await PDFDocument.load(sigBytes);
  const [sigPage] = await baseDoc.copyPages(sigDoc, [0]);
  baseDoc.addPage(sigPage);
  return bytesToDataUrl(await baseDoc.save());
}

export function getLeasePdfBaseDataUrl(row: LeasePipelineRow): string | null {
  const pdf = row.managerUploadedPdf;
  if (!pdf?.dataUrl) return null;
  return pdf.originalDataUrl ?? pdf.dataUrl;
}

export function getLeasePdfForDisplay(row: LeasePipelineRow): string | null {
  return row.managerUploadedPdf?.dataUrl ?? null;
}

export async function mergeUploadedLeasePdfWithSignatures(row: LeasePipelineRow): Promise<string | null> {
  const base = getLeasePdfBaseDataUrl(row);
  if (!base) return null;
  if (!row.residentSignature && !row.managerSignature) return base;
  return appendSignaturePageToPdf(base, row);
}
