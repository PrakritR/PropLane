import "server-only";

import { createHash } from "node:crypto";
import { extractText, getDocumentProxy } from "unpdf";
import { parsePdfForImport, pdfImportPageContent, UnsafePdfImportError } from "@/lib/pdf-import/pdf-source.server";
import type { PdfImportSource } from "@/lib/pdf-import/pdf-source.server";
import {
  buildUploadedLeaseParse,
  failedUploadedLeaseParse,
  type UploadedLeaseParse,
} from "@/lib/uploaded-lease-extraction";

/** Shared page extraction for resident document classification. */
export async function extractLeasePdfPages(bytes: Uint8Array): Promise<string[]> {
  const pdf = await getDocumentProxy(new Uint8Array(bytes));
  const { text } = await extractText(pdf);
  return Array.isArray(text) ? text.map((page) => String(page ?? "")) : [String(text ?? "")];
}

export function dataUrlToPdfBytes(dataUrl: string): Uint8Array {
  const comma = dataUrl.indexOf(",");
  const base64 = comma === -1 ? dataUrl : dataUrl.slice(comma + 1);
  return new Uint8Array(Buffer.from(base64, "base64"));
}

/**
 * Parse uploaded PDF bytes into PropLane's lease structure.
 *
 * Never throws for a document-shaped problem: an unreadable or oversized PDF
 * comes back as a `failed` parse carrying the reason, because a failure still
 * has to keep the confirm-before-sign gate closed rather than disappear.
 */
export async function parseUploadedLeasePdfBytes(args: {
  bytes: Uint8Array;
  fileName: string;
  nowIso?: string;
}): Promise<UploadedLeaseParse> {
  let source: PdfImportSource;
  try {
    source = await parsePdfForImport({ bytes: args.bytes, fileName: args.fileName });
  } catch (error) {
    if (error instanceof UnsafePdfImportError) throw error;
    return {
      ...failedUploadedLeaseParse(
        args.fileName,
        "This file could not be opened as a PDF. Review the original document instead.",
      ),
      sourceSha256: createHash("sha256").update(args.bytes).digest("hex"),
    };
  }
  return buildUploadedLeaseParse({
    pages: source.pages.map(pdfImportPageContent),
    fileName: args.fileName,
    sourceSha256: source.sourceSha256,
    extractedAtIso: args.nowIso ?? new Date().toISOString(),
    sourceIssues: source.issues,
    sourceCoverage: source.coverage,
  });
}
