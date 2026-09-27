import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import type { LeaseDocumentField } from "@/lib/lease-document-library";

/**
 * Stamps placed signature fields onto the ORIGINAL uploaded lease bytes,
 * producing a SIGNED COPY — a separate, derived artifact from what each party
 * hashed and signed (night/custom-lease, item 3).
 *
 * Evidence rule this file must never violate: the SHA-256 every party's
 * signature records (`lease-execution-evidence.ts`'s `leaseDocumentSha256`)
 * is taken over `managerUploadedPdf.originalDataUrl`, computed BEFORE this
 * stamping ever runs. This module only ever reads that same original —
 * never the certificate-merged `dataUrl` — and its output is stored
 * separately (`managerUploadedPdf.stampedDataUrl` /
 * `stampedDocumentSha256`), with its own hash, never folded back into the
 * hashed original. A stamped copy is a convenience rendering of what the
 * parties already agreed to, not a second thing to sign.
 *
 * Field coordinates are normalized 0..1 top-left-origin (matching CSS/click
 * coordinates, the same convention the placement editor uses) and are
 * converted here to pdf-lib's bottom-left-origin page space.
 */

export const pdfDataUrlToBytes = (dataUrl: string): Uint8Array => {
  const base64 = dataUrl.slice(dataUrl.indexOf(",") + 1);
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
};

const bytesToDataUrl = (bytes: Uint8Array): string => {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]!);
  return `data:application/pdf;base64,${btoa(binary)}`;
};

// The standard fonts are WinAnsi-only and pdf-lib throws on anything outside
// it — same guard `lease-pdf-signing.ts` uses for the certificate page.
// Losing one glyph beats losing the stamped copy entirely.
const winAnsiSafe = (text: string) => text.replace(/[^\x20-\x7E\xA0-\xFF]/g, "?");

/** First letter of up to the first three words of a typed name, e.g. "Jordan Lee" -> "JL". */
export function deriveInitials(name: string): string {
  const letters = name
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 3)
    .map((word) => word[0]?.toUpperCase() ?? "")
    .join("");
  return letters || "—";
}

export type LeaseFieldStampValues = {
  residentSignature?: string | null;
  /** Auto-derived from the typed signature name — there is no separate initials input today. */
  residentInitials?: string | null;
  residentDateSigned?: string | null;
  managerSignature?: string | null;
  managerInitials?: string | null;
  managerDateSigned?: string | null;
};

function valueForField(field: LeaseDocumentField, values: LeaseFieldStampValues): string | null {
  if (field.role === "resident") {
    if (field.kind === "signature") return values.residentSignature ?? null;
    if (field.kind === "initials") return values.residentInitials ?? null;
    return values.residentDateSigned ?? null;
  }
  if (field.kind === "signature") return values.managerSignature ?? null;
  if (field.kind === "initials") return values.managerInitials ?? null;
  return values.managerDateSigned ?? null;
}

/**
 * Returns null when there is nothing new to stamp (no fields, or no value for
 * any of them yet — e.g. only the resident has signed so far and every placed
 * field belongs to the manager). Callers keep the prior stamped copy in that
 * case; a stamped copy only ever gains stamps as signatures accumulate.
 */
export async function stampLeaseDocumentFields(
  originalDataUrl: string,
  fields: LeaseDocumentField[],
  values: LeaseFieldStampValues,
): Promise<string | null> {
  const toStamp = fields.filter((f) => valueForField(f, values));
  if (toStamp.length === 0) return null;

  const doc = await PDFDocument.load(pdfDataUrlToBytes(originalDataUrl));
  const pages = doc.getPages();
  const signatureFont = await doc.embedFont(StandardFonts.TimesRomanItalic);
  const plainFont = await doc.embedFont(StandardFonts.Helvetica);

  for (const field of toStamp) {
    const page = pages[field.page];
    if (!page) continue;
    const text = valueForField(field, values);
    if (!text) continue;
    const pageWidth = page.getWidth();
    const pageHeight = page.getHeight();
    const boxX = field.x * pageWidth;
    const boxTopY = field.y * pageHeight;
    const boxW = field.w * pageWidth;
    const boxH = field.h * pageHeight;
    const font = field.kind === "date" ? plainFont : signatureFont;
    // Fit the text to the box: shrink from a size proportional to box height
    // until it fits the box width, floored so a long name never renders
    // invisibly small.
    let size = Math.max(7, Math.min(boxH * 0.62, 16));
    const safe = winAnsiSafe(text);
    while (size > 7 && font.widthOfTextAtSize(safe, size) > boxW) size -= 0.5;
    // Normalized y is top-left origin (CSS-style); PDF space is bottom-left
    // origin, so invert and land the baseline near the box's bottom edge.
    const baselineY = pageHeight - boxTopY - boxH + (boxH - size) / 2;
    page.drawText(safe, {
      x: boxX,
      y: baselineY,
      size,
      font,
      color: rgb(0.06, 0.06, 0.45),
    });
  }

  return bytesToDataUrl(await doc.save());
}
