import "server-only";

import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { getDocumentProxy, getResolvedPDFJS, renderPageAsImage } from "unpdf";
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFRef, PDFStream } from "pdf-lib";

const MAX_BYTES = 8 * 1024 * 1024;
const MAX_PAGES = 60;
const MAX_CHARACTERS = 250_000;
const MAX_OCR_PAGES = 4;
const OCR_PAGE_TIMEOUT_MS = 12_000;

export class UnsafePdfImportError extends Error {}

/** Inspect decoded PDF objects, including object streams, before retaining bytes. */
export async function assertSafePdfForImport(bytes: Uint8Array): Promise<void> {
  try { await inspectPdfObjects(bytes); }
  catch { throw new UnsafePdfImportError("PDF contains active or unsupported content and cannot be imported."); }
}

async function inspectPdfObjects(bytes: Uint8Array): Promise<void> {
  const document = await PDFDocument.load(bytes, { ignoreEncryption: false, updateMetadata: false });
  const context = document.context;
  const visited = new Set<object>();
  const scanned = new Set<object>();
  const inspectAction = (value: unknown): void => {
    if (value instanceof PDFRef) return inspectAction(context.lookup(value));
    if (!value || typeof value !== "object" || visited.has(value)) return;
    visited.add(value);
    if (value instanceof PDFArray) {
      for (let index = 0; index < value.size(); index += 1) inspectAction(value.get(index));
      return;
    }
    if (!(value instanceof PDFDict)) throw new Error("PDF contains an unsupported action and cannot be imported.");
    const kind = value.get(PDFName.of("S"));
    if (!(kind instanceof PDFName) || !["/URI", "/GoTo"].includes(kind.toString())) {
      throw new Error("PDF contains an active or unsupported action and cannot be imported.");
    }
    if (value.has(PDFName.of("Next"))) inspectAction(value.get(PDFName.of("Next")));
  };
  const scanDictionary = (dict: PDFDict): void => {
    if (scanned.has(dict)) return;
    scanned.add(dict);
    if (dict.get(PDFName.of("Type"))?.toString() === "/EmbeddedFile" || dict.get(PDFName.of("Subtype"))?.toString() === "/FileAttachment") {
      throw new Error("PDF contains embedded files and cannot be imported.");
    }
    for (const key of ["JavaScript", "JS", "EmbeddedFiles", "EF", "XFA", "RichMedia", "Launch"]) {
      if (dict.has(PDFName.of(key))) throw new Error("PDF contains active actions or embedded files and cannot be imported.");
    }
    for (const key of ["A", "AA", "OpenAction"]) {
      const action = dict.get(PDFName.of(key));
      if (!action) continue;
      if (key === "AA") {
        const additional = context.lookup(action);
        if (!(additional instanceof PDFDict)) throw new Error("PDF contains an unsupported action and cannot be imported.");
        for (const [, nested] of additional.entries()) inspectAction(nested);
      } else inspectAction(action);
    }
    for (const [, value] of dict.entries()) {
      const resolved = value instanceof PDFRef ? context.lookup(value) : value;
      if (resolved instanceof PDFDict) scanDictionary(resolved);
      if (resolved instanceof PDFStream) scanDictionary(resolved.dict);
      if (resolved instanceof PDFArray) {
        for (let index = 0; index < resolved.size(); index += 1) {
          const item = resolved.get(index);
          const nested = item instanceof PDFRef ? context.lookup(item) : item;
          if (nested instanceof PDFDict) scanDictionary(nested);
          if (nested instanceof PDFStream) scanDictionary(nested.dict);
        }
      }
    }
  };
  for (const [, object] of context.enumerateIndirectObjects()) {
    if (object instanceof PDFDict) scanDictionary(object);
    if (object instanceof PDFStream) scanDictionary(object.dict);
  }
  scanDictionary(document.catalog);
}

async function ocrBlankPages(pdf: Awaited<ReturnType<typeof getDocumentProxy>>, pageNumbers: number[]) {
  const results = new Map<number, string>();
  if (pageNumbers.length === 0) return results;
  const { createWorker } = await import("tesseract.js");
  const require = createRequire(import.meta.url);
  const langPath = join(dirname(require.resolve("@tesseract.js-data/eng")), "4.0.0");
  const worker = await createWorker("eng", 1, {
    langPath,
    cacheMethod: "none",
  });
  try {
    for (const pageNumber of pageNumbers) {
      let timedOut = false;
      try {
        const image = await renderPageAsImage(pdf, pageNumber, {
          scale: 1.5,
          canvasImport: () => import("@napi-rs/canvas"),
        });
        let timeout: ReturnType<typeof setTimeout> | undefined;
        const recognized = await Promise.race([
          worker.recognize(Buffer.from(image)),
          new Promise<never>((_, reject) => {
            timeout = setTimeout(() => {
              timedOut = true;
              reject(new Error("OCR timed out"));
            }, OCR_PAGE_TIMEOUT_MS);
          }),
        ]).finally(() => {
          if (timeout) clearTimeout(timeout);
        });
        const text = recognized.data.text.replace(/\r\n/g, "\n").trim();
        if (text) results.set(pageNumber, text);
      } catch {
        // A page still appears in issues and blocks automatic publication.
      }
      if (timedOut) break;
    }
  } finally {
    await worker.terminate();
  }
  return results;
}

export type PdfImportIssue = {
  pageNumber: number | null;
  code: string;
  message: string;
};

export type PdfImportSource = {
  sourceSha256: string;
  fileName: string;
  pages: Array<{
    pageNumber: number;
    text: string;
    blocks: Array<{ text: string; start: number; end: number }>;
    formFields: Array<{ name: string; value: string; options: string[]; required: boolean }>;
    issues: string[];
  }>;
  issues: PdfImportIssue[];
  coverage: {
    extractedCharacters: number;
    representedCharacters: number;
    complete: boolean;
  };
};

/** Keep widget labels, values, and choices alongside each page's visible text. */
export function pdfImportPageContent(page: PdfImportSource["pages"][number]): string {
  const fields = page.formFields.map((field) => [
    `PDF form field: ${field.name || "Unnamed field"}`,
    field.value ? `Value: ${field.value}` : null,
    field.options.length ? `Options: ${field.options.join(", ")}` : null,
    field.required ? "Required" : null,
  ].filter(Boolean).join(" | "));
  return [page.text, ...fields].filter(Boolean).join("\n");
}

/**
 * Extract source spans without changing their words or sending them to a model.
 * A complete result means every machine-extracted character has a source block;
 * it does not certify that a scan, image, or handwritten mark was read.
 */
export async function parsePdfForImport(args: {
  bytes: Uint8Array;
  fileName: string;
}): Promise<PdfImportSource> {
  const { bytes } = args;
  if (bytes.length < 8 || bytes.length > MAX_BYTES) {
    throw new Error("PDF must be between 8 bytes and 8 MB.");
  }
  if (Buffer.from(bytes.subarray(0, 5)).toString("ascii") !== "%PDF-") {
    throw new Error("File content is not a PDF.");
  }
  await assertSafePdfForImport(bytes);

  const sourceSha256 = createHash("sha256").update(bytes).digest("hex");
  const pdf = await getDocumentProxy(new Uint8Array(bytes));
  {
    if (pdf.numPages < 1 || pdf.numPages > MAX_PAGES) {
      throw new Error(`PDF must have between 1 and ${MAX_PAGES} pages.`);
    }
    const [documentActions, attachments] = await Promise.all([
      pdf.getJSActions(),
      pdf.getAttachments(),
    ]);
    if ((documentActions && Object.keys(documentActions).length > 0) || (attachments && attachments.size > 0)) {
      throw new Error("PDF contains active actions or embedded files and cannot be imported.");
    }
    // PDF.js marks the end of each visual text line. `unpdf.extractText`
    // discards that marker and can join two lease clauses as "end.Start".
    // Preserve line boundaries before recording source offsets or converting.
    const pageTexts = await Promise.all(Array.from({ length: pdf.numPages }, async (_, index) => {
      const page = await pdf.getPage(index + 1);
      const content = await page.getTextContent();
      return content.items.map((item) => "str" in item ? `${item.str}${item.hasEOL ? "\n" : ""}` : "").join("");
    }));
    const blankPageNumbers = Array.from({ length: pdf.numPages }, (_, index) => index + 1)
      .filter((pageNumber) => !(pageTexts[pageNumber - 1] ?? "").trim());
    let ocrText = new Map<number, string>();
    if (blankPageNumbers.length <= MAX_OCR_PAGES) {
      try {
        ocrText = await ocrBlankPages(pdf, blankPageNumbers);
      } catch {
        // Missing native OCR resources leave the original available for review.
      }
    }
    const issues: PdfImportIssue[] = [];
    const { OPS } = await getResolvedPDFJS();
    const imageOperations = new Set([
      OPS.paintImageXObject,
      OPS.paintInlineImageXObject,
      OPS.paintImageMaskXObject,
      OPS.paintImageXObjectRepeat,
      OPS.paintImageMaskXObjectRepeat,
    ]);
    let extractedCharacters = 0;
    let representedCharacters = 0;
    const pages = [] as PdfImportSource["pages"];

    for (let index = 0; index < pdf.numPages; index += 1) {
      const pageNumber = index + 1;
      const text = ocrText.get(pageNumber) ?? pageTexts[index] ?? "";
      extractedCharacters += text.length;
      if (extractedCharacters > MAX_CHARACTERS) {
        throw new Error("PDF contains too much text to import in one document.");
      }

      // Each line is a source span. Keep whitespace in its offsets so joining
      // the spans reproduces the extractor's exact text, including line breaks.
      const blocks: PdfImportSource["pages"][number]["blocks"] = [];
      const lines = text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
      let offset = 0;
      for (const line of lines) {
        blocks.push({ text: line, start: offset, end: offset + line.length });
        offset += line.length;
      }
      representedCharacters += offset;

      const pageIssues: string[] = [];
      const formFields: PdfImportSource["pages"][number]["formFields"] = [];
      if (ocrText.has(pageNumber)) {
        const code = "ocr_requires_review";
        pageIssues.push(code);
        issues.push({
          pageNumber,
          code,
          message: `Page ${pageNumber} was read with OCR. Compare every word with the original before approving the converted document.`,
        });
      }
      // Widget annotations may contain labels or values that aren't part of
      // the page text stream. Require an explicit review instead of losing them.
      const page = await pdf.getPage(pageNumber);
      const pageActions = await page.getJSActions();
      if (pageActions && Object.keys(pageActions).length > 0) {
        throw new Error("PDF contains active page actions and cannot be imported.");
      }
      try {
        const annotations = await page.getAnnotations();
        if (annotations.some((annotation) => annotation.subtype === "Widget")) {
          const code = "form_fields_present";
          pageIssues.push(code);
          issues.push({
            pageNumber,
            code,
            message: `Page ${pageNumber} contains PDF form fields. Compare their labels, options, and values with the converted draft.`,
          });
        }
        for (const annotation of annotations) {
          if (annotation.subtype !== "Widget") continue;
          const field = annotation as Record<string, unknown>;
          const rawOptions = Array.isArray(field.options) ? field.options : [];
          formFields.push({
            name: typeof field.fieldName === "string" ? field.fieldName.slice(0, 300) : "",
            value: typeof field.fieldValue === "string" ? field.fieldValue.slice(0, 1000) : "",
            options: rawOptions.flatMap((option) => {
              if (typeof option === "string") return [option.slice(0, 300)];
              if (!option || typeof option !== "object") return [];
              const row = option as Record<string, unknown>;
              const label = row.displayValue ?? row.exportValue;
              return typeof label === "string" ? [label.slice(0, 300)] : [];
            }).slice(0, 100),
            required: field.required === true || (typeof field.fieldFlags === "number" && (field.fieldFlags & 2) !== 0),
          });
        }
        const operators = await page.getOperatorList();
        if (operators.fnArray.some((operation) => imageOperations.has(operation))) {
          const code = "image_requires_review";
          pageIssues.push(code);
          issues.push({
            pageNumber,
            code,
            message: `Page ${pageNumber} contains an image. Compare it with the source and account for any content in the converted draft.`,
          });
        }
      } catch {
        const code = "annotation_scan_failed";
        pageIssues.push(code);
        issues.push({
          pageNumber,
          code,
          message: `Page ${pageNumber} annotations could not be inspected. Review the original page.`,
        });
      }
      if (!text.trim() && formFields.length === 0) {
        const code = "unreadable_page";
        pageIssues.push(code);
        issues.push({
          pageNumber,
          code,
          message: `Page ${pageNumber} has no extractable text. Compare the original and transcribe or use the original PDF.`,
        });
      }
      pages.push({ pageNumber, text, blocks, formFields, issues: pageIssues });
    }

    return {
      sourceSha256,
      fileName: args.fileName.slice(0, 240) || "Imported.pdf",
      pages,
      issues,
      coverage: {
        extractedCharacters,
        representedCharacters,
        // Coverage measures whether extracted text is represented by source
        // spans. Human-review findings remain separate and must be resolved
        // against the original before a converted document can be signed.
        complete: extractedCharacters === representedCharacters,
      },
    };
  }
}
