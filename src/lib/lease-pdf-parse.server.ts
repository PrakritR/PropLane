import { parsePdfForImport, pdfImportPageContent } from "@/lib/pdf-import/pdf-source.server";
import {
  inferLeaseKindFromText,
  parseLeasePlainText,
  parsedLeaseToHtml,
  type ParsedLeaseDocument,
} from "@/lib/lease-pdf-parse";
import { assertSectionsPartition, joinLeasePages, splitLeasePagesIntoSections } from "@/lib/uploaded-lease-extraction";
import type { PropertyLeaseTemplateKind } from "@/lib/property-lease-templates";

export async function parseLeasePdfBuffer(args: {
  bytes: Buffer;
  docName: string;
  docUrl?: string | null;
  kindHint?: PropertyLeaseTemplateKind;
}): Promise<{
  html: string;
  parsed: ParsedLeaseDocument;
  sourceSha256: string;
  sourceIssues: Array<{ pageNumber: number | null; code: string; message: string }>;
  coverage: { extractedCharacters: number; representedCharacters: number; complete: boolean };
}> {
  const source = await parsePdfForImport({ bytes: new Uint8Array(args.bytes), fileName: args.docName });
  const document = joinLeasePages(source.pages.map(pdfImportPageContent));
  const plainText = document.text;
  if (!plainText.trim()) {
    throw new Error("Could not read text from that PDF. Try a text-based PDF or a clearer scan.");
  }

  const inferredKind = args.kindHint ?? inferLeaseKindFromText(plainText);
  const sourceSections = splitLeasePagesIntoSections(document);
  assertSectionsPartition(document, sourceSections);
  const sections = sourceSections.map((section) => ({
    title: section.title,
    body: section.body,
  }));
  const parsed: ParsedLeaseDocument = {
    sections,
    inferredKind,
    plainText,
  };
  const html = parsedLeaseToHtml(parsed, args.docName, args.docUrl);
  return {
    html,
    parsed,
    sourceSha256: source.sourceSha256,
    sourceIssues: source.issues,
    coverage: source.coverage,
  };
}

export { parseLeasePlainText };
