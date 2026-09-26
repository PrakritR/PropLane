import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ACTIVE_PDF_MESSAGE,
  assertSafePdfForImport,
  classifyFillColorHex,
  parsePdfForImport,
  PROTECTED_PDF_MESSAGE,
} from "@/lib/pdf-import/pdf-source.server";
import { parseUploadedLeasePdfBytes } from "@/lib/uploaded-lease-parse.server";
import { parseLeasePdfBuffer } from "@/lib/lease-pdf-parse.server";
import { uploadedLeaseConversionBlocker, uploadedLeaseSourceIssueKey } from "@/lib/uploaded-lease-extraction";
import { PDFDocument, PDFName, PDFString, StandardFonts, cmyk, grayscale, rgb } from "pdf-lib";

const fixture = (name: string) =>
  new Uint8Array(readFileSync(join(process.cwd(), "tests/fixtures/portfolio-import", name)));

describe("PDF source import", () => {
  it("keeps separate PDF text lines separate in a converted lease", async () => {
    const pdf = await PDFDocument.create();
    const page = pdf.addPage([300, 300]);
    const font = await pdf.embedFont(StandardFonts.Helvetica);
    page.drawText("Rent is due on the first.", { x: 20, y: 260, size: 12, font });
    page.drawText("Pets require written consent.", { x: 20, y: 235, size: 12, font });
    const bytes = await pdf.save();
    const source = await parsePdfForImport({ bytes, fileName: "lease.pdf" });
    expect(source.pages[0]?.text).toContain("first.\nPets");
    const converted = await parseLeasePdfBuffer({ bytes: Buffer.from(bytes), docName: "lease.pdf" });
    expect(converted.parsed.plainText).toContain("first.\nPets");
    expect(converted.html).toContain("Pets require written consent.");
  });

  it("keeps every extracted character in ordered page spans", async () => {
    const source = await parsePdfForImport({ bytes: fixture("rent-roll.pdf"), fileName: "Rent roll.pdf" });
    expect(source.pages.length).toBeGreaterThan(0);
    for (const page of source.pages) {
      expect(page.blocks.map((block) => block.text).join("")).toBe(page.text);
      expect(page.blocks[0]?.start).toBe(0);
      expect(page.blocks.at(-1)?.end ?? 0).toBe(page.text.length);
    }
    expect(source.coverage.representedCharacters).toBe(source.coverage.extractedCharacters);
    expect(source.sourceSha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it("separates image-only extraction coverage from unresolved page review", async () => {
    const source = await parsePdfForImport({ bytes: fixture("scan-no-text.pdf"), fileName: "Scan.pdf" });
    expect(source.coverage.complete).toBe(true);
    expect(source.issues).toEqual(expect.arrayContaining([expect.objectContaining({ code: "unreadable_page" })]));
    const parsed = await parseUploadedLeasePdfBytes({ bytes: fixture("scan-no-text.pdf"), fileName: "Scan.pdf" });
    expect(uploadedLeaseConversionBlocker(parsed)).toMatch(/Resolve every source-page issue/);
    expect(uploadedLeaseConversionBlocker(parsed, parsed.sourceIssues?.map(uploadedLeaseSourceIssueKey))).toBeNull();
  });

  it("reads a clean scanned page with local OCR and requires word review", async () => {
    const source = await parsePdfForImport({ bytes: fixture("scan-application-ocr.pdf"), fileName: "Scan.pdf" });
    expect(source.pages[0]?.text).toContain("RENTAL APPLICATION");
    expect(source.pages[0]?.text).toContain("Jane Tenant");
    expect(source.issues).toEqual(expect.arrayContaining([expect.objectContaining({ code: "ocr_requires_review" })]));
    expect(source.coverage.complete).toBe(true);
  });

  it("retains fillable field names and choice options for application mapping", async () => {
    const source = await parsePdfForImport({ bytes: fixture("fillable-application.pdf"), fileName: "Form.pdf" });
    const fields = source.pages[0]?.formFields ?? [];
    expect(fields).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "Full legal name" }),
      expect.objectContaining({ name: "Preferred contact method", options: ["Email", "Phone", "Text"] }),
    ]));
    expect(source.issues).toEqual(expect.arrayContaining([expect.objectContaining({ code: "form_fields_present" })]));
  });

  it("treats a page made entirely of fillable fields as readable", async () => {
    const pdf = await PDFDocument.create();
    const page = pdf.addPage([300, 300]);
    pdf.getForm().createTextField("Legal name").addToPage(page, { x: 20, y: 250, width: 200, height: 20 });
    const source = await parsePdfForImport({ bytes: await pdf.save(), fileName: "fields-only.pdf" });
    expect(source.pages[0]?.formFields).toEqual(expect.arrayContaining([expect.objectContaining({ name: "Legal name" })]));
    expect(source.issues.map((issue) => issue.code)).toContain("form_fields_present");
    expect(source.issues.map((issue) => issue.code)).not.toContain("unreadable_page");
  });

  it("carries fillable lease field labels, values, and options into the converted document", async () => {
    const result = await parseLeasePdfBuffer({ bytes: Buffer.from(fixture("fillable-application.pdf")), docName: "Fillable source.pdf" });
    expect(result.parsed.plainText).toContain("PDF form field: Full legal name");
    expect(result.parsed.plainText).toContain("PDF form field: Preferred contact method");
    expect(result.parsed.plainText).toContain("Options: Email, Phone, Text");
    expect(result.html).toContain("Preferred contact method");
    const uploaded = await parseUploadedLeasePdfBytes({ bytes: fixture("fillable-application.pdf"), fileName: "Fillable source.pdf" });
    const uploadedText = uploaded.sections.map((section) => section.title + section.body).join("");
    expect(uploadedText).toContain("PDF form field: Full legal name");
    expect(uploadedText).toContain("Options: Email, Phone, Text");
  });

  it("rejects a disguised PDF", async () => {
    await expect(parsePdfForImport({ bytes: new TextEncoder().encode("fake pdf file"), fileName: "fake.pdf" }))
      .rejects.toThrow("not a PDF");
  });

  it.each(["JavaScript", "Launch", "GoTo-next-JavaScript"])("rejects an annotation %s action before storage", async (kind) => {
    const pdf = await PDFDocument.create();
    const page = pdf.addPage([200, 200]);
    const malicious = pdf.context.obj({ S: PDFName.of(kind === "GoTo-next-JavaScript" ? "GoTo" : kind) });
    if (kind === "JavaScript") malicious.set(PDFName.of("JS"), PDFString.of("app.alert('x')"));
    if (kind === "GoTo-next-JavaScript") malicious.set(PDFName.of("Next"), pdf.context.obj({ S: PDFName.of("JavaScript"), JS: PDFString.of("app.alert('x')") }));
    const link = pdf.context.obj({ Type: PDFName.of("Annot"), Subtype: PDFName.of("Link"), Rect: [0, 0, 20, 20], A: malicious });
    page.node.set(PDFName.of("Annots"), pdf.context.obj([pdf.context.register(link)]));
    await expect(parsePdfForImport({ bytes: await pdf.save(), fileName: "active.pdf" })).rejects.toThrow(/active|unsupported/);
  });

  it("rejects widget additional actions and catalog JavaScript in compressed objects", async () => {
    const pdf = await PDFDocument.create();
    const page = pdf.addPage([200, 200]);
    const script = pdf.context.obj({ S: PDFName.of("JavaScript"), JS: PDFString.of("app.alert('x')") });
    const widget = pdf.context.obj({ Type: PDFName.of("Annot"), Subtype: PDFName.of("Widget"), Rect: [0, 0, 20, 20], AA: { F: script } });
    page.node.set(PDFName.of("Annots"), pdf.context.obj([pdf.context.register(widget)]));
    await expect(parsePdfForImport({ bytes: await pdf.save({ useObjectStreams: true }), fileName: "widget.pdf" })).rejects.toThrow(/active|unsupported/);
    page.node.delete(PDFName.of("Annots"));
    pdf.catalog.set(PDFName.of("OpenAction"), script);
    await expect(parsePdfForImport({ bytes: await pdf.save({ useObjectStreams: true }), fileName: "catalog.pdf" })).rejects.toThrow(/active|unsupported/);
  });

  it("allows an ordinary URI link", async () => {
    const pdf = await PDFDocument.create();
    const page = pdf.addPage([200, 200]);
    const link = pdf.context.obj({ Type: PDFName.of("Annot"), Subtype: PDFName.of("Link"), Rect: [0, 0, 20, 20], A: { S: PDFName.of("URI"), URI: PDFString.of("https://example.com") } });
    page.node.set(PDFName.of("Annots"), pdf.context.obj([pdf.context.register(link)]));
    const result = await parsePdfForImport({ bytes: await pdf.save(), fileName: "link.pdf" });
    expect(result.pages).toHaveLength(1);
  });

  // Word / Google Docs exports are tagged: structure elements carry `/A`
  // attribute objects (`/O /Layout ...`). These are not actions, and treating
  // them as one rejected nearly every real lease a manager exported from Word.
  function taggedPdf(pdf: PDFDocument, attributes: unknown) {
    const rootDict = pdf.context.obj({ Type: PDFName.of("StructTreeRoot") });
    const root = pdf.context.register(rootDict);
    const element = pdf.context.obj({ Type: PDFName.of("StructElem"), S: PDFName.of("P"), P: root, A: attributes });
    rootDict.set(PDFName.of("K"), pdf.context.obj([pdf.context.register(element)]));
    pdf.catalog.set(PDFName.of("StructTreeRoot"), root);
    pdf.catalog.set(PDFName.of("MarkInfo"), pdf.context.obj({ Marked: true }));
  }

  it.each([
    ["a single attribute object", { O: PDFName.of("Layout"), Placement: PDFName.of("Block") }],
    ["an attribute array with a revision number", [{ O: PDFName.of("List"), ListNumbering: PDFName.of("Decimal") }, 0]],
  ])("allows a tagged PDF whose structure element has %s", async (_label, attributes) => {
    const pdf = await PDFDocument.create();
    pdf.addPage([200, 200]);
    taggedPdf(pdf, pdf.context.obj(attributes as never));
    await expect(assertSafePdfForImport(await pdf.save({ useObjectStreams: true }))).resolves.toBeUndefined();
  });

  it("still rejects a JavaScript action hidden in a structure element's /A", async () => {
    const pdf = await PDFDocument.create();
    pdf.addPage([200, 200]);
    taggedPdf(pdf, pdf.context.obj({ O: PDFName.of("Layout"), S: PDFName.of("JavaScript"), JS: PDFString.of("app.alert('x')") }));
    await expect(assertSafePdfForImport(await pdf.save())).rejects.toThrow(ACTIVE_PDF_MESSAGE);
  });

  it("rejects a structure attribute object that chains a /Next action", async () => {
    const pdf = await PDFDocument.create();
    pdf.addPage([200, 200]);
    taggedPdf(pdf, pdf.context.obj({ O: PDFName.of("Layout"), Next: { S: PDFName.of("Launch"), F: PDFString.of("calc.exe") } }));
    await expect(assertSafePdfForImport(await pdf.save())).rejects.toThrow(ACTIVE_PDF_MESSAGE);
  });

  it.each(["Launch", "SubmitForm", "GoToR", "Named"])(
    "rejects an outline item that mimics a structure element to hide a %s action",
    async (kind) => {
      const pdf = await PDFDocument.create();
      const page = pdf.addPage([200, 200]);
      const outlinesDict = pdf.context.obj({ Type: PDFName.of("Outlines") });
      const outlines = pdf.context.register(outlinesDict);
      const item = pdf.context.obj({
        Title: PDFString.of("Start"),
        Parent: outlines,
        S: PDFName.of("Sect"),
        P: page.ref,
        A: { O: PDFName.of("Layout"), Next: { S: PDFName.of(kind), F: PDFString.of("x") } },
      });
      const itemRef = pdf.context.register(item);
      outlinesDict.set(PDFName.of("First"), itemRef);
      outlinesDict.set(PDFName.of("Last"), itemRef);
      pdf.catalog.set(PDFName.of("Outlines"), outlines);
      await expect(assertSafePdfForImport(await pdf.save())).rejects.toThrow(ACTIVE_PDF_MESSAGE);
      // Same attack without /Next: the shape alone must not earn a skip either.
      item.set(PDFName.of("A"), pdf.context.obj({ O: PDFName.of("Layout") }));
      await expect(assertSafePdfForImport(await pdf.save())).rejects.toThrow(ACTIVE_PDF_MESSAGE);
    },
  );

  it("allows an /OpenAction destination array (open at page 1)", async () => {
    const pdf = await PDFDocument.create();
    const page = pdf.addPage([200, 200]);
    pdf.catalog.set(PDFName.of("OpenAction"), pdf.context.obj([page.ref, PDFName.of("Fit")]));
    await expect(assertSafePdfForImport(await pdf.save())).resolves.toBeUndefined();
  });

  it("names a password-protected PDF instead of calling it active content", async () => {
    const pdf = await PDFDocument.create();
    pdf.addPage([200, 200]);
    const bytes = Buffer.from(await pdf.save({ useObjectStreams: false })).toString("latin1")
      .replace("trailer\n<<", "trailer\n<<\n/Encrypt << /Filter /Standard /V 1 /R 2 >>");
    await expect(assertSafePdfForImport(new Uint8Array(Buffer.from(bytes, "latin1")))).rejects.toThrow(PROTECTED_PDF_MESSAGE);
  });

  it("never turns an unsafe uploaded lease into an approvable failed parse", async () => {
    const pdf = await PDFDocument.create();
    const page = pdf.addPage([200, 200]);
    const link = pdf.context.obj({ Type: PDFName.of("Annot"), Subtype: PDFName.of("Link"), Rect: [0, 0, 20, 20], A: { S: PDFName.of("JavaScript"), JS: PDFString.of("app.alert('x')") } });
    page.node.set(PDFName.of("Annots"), pdf.context.obj([pdf.context.register(link)]));
    await expect(parseUploadedLeasePdfBytes({ bytes: await pdf.save(), fileName: "unsafe.pdf" })).rejects.toThrow(/active|unsupported/);
  });
});

describe("PDF source import — fill color extraction (C276)", () => {
  it("classifies a small palette from raw hex: black/gray default, true red red, blue other", () => {
    expect(classifyFillColorHex("#000000")).toBe("default");
    expect(classifyFillColorHex("#666666")).toBe("default");
    expect(classifyFillColorHex("#cc0d0d")).toBe("red");
    expect(classifyFillColorHex("#ff0000")).toBe("red");
    expect(classifyFillColorHex("#e53935")).toBe("red");
    expect(classifyFillColorHex("#1155cc")).toBe("other");
    expect(classifyFillColorHex("#0a8a3f")).toBe("other");
    expect(classifyFillColorHex("not-a-color")).toBe("default");
  });

  it("marks a red-filled line as a red colorRun and leaves black lines untagged, without changing the plain text", async () => {
    const pdf = await PDFDocument.create();
    const page = pdf.addPage([400, 200]);
    const font = await pdf.embedFont(StandardFonts.Helvetica);
    page.drawText("Black clause text here.", { x: 20, y: 150, size: 14, font, color: rgb(0, 0, 0) });
    page.drawText("This is a RED flagged rule.", { x: 20, y: 100, size: 14, font, color: rgb(0.8, 0.05, 0.05) });
    page.drawText("More black text after.", { x: 20, y: 50, size: 14, font, color: rgb(0, 0, 0) });
    const bytes = await pdf.save();

    const source = await parsePdfForImport({ bytes, fileName: "colored-lease.pdf" });
    const [pageOne] = source.pages;
    expect(pageOne?.text).toBe("Black clause text here.\nThis is a RED flagged rule.\nMore black text after.");

    const runs = pageOne?.colorRuns ?? [];
    expect(runs).toHaveLength(1);
    const run = runs[0]!;
    expect(run.color).toBe("red");
    expect(pageOne!.text.slice(run.start, run.end)).toBe("This is a RED flagged rule.");

    // Additive: the existing plain-text/offset contract is untouched.
    expect(pageOne!.blocks.map((block) => block.text).join("")).toBe(pageOne!.text);
  });

  it("merges a red rule spanning several lines into one colorRun", async () => {
    const pdf = await PDFDocument.create();
    const page = pdf.addPage([400, 200]);
    const font = await pdf.embedFont(StandardFonts.Helvetica);
    page.drawText("This entire rule is red", { x: 20, y: 150, size: 14, font, color: rgb(0.8, 0.05, 0.05) });
    page.drawText("and spans two full lines.", { x: 20, y: 130, size: 14, font, color: rgb(0.8, 0.05, 0.05) });
    const bytes = await pdf.save();

    const source = await parsePdfForImport({ bytes, fileName: "multiline-red.pdf" });
    const pageOne = source.pages[0]!;
    expect(pageOne.text).toBe("This entire rule is red\nand spans two full lines.");
    expect(pageOne.colorRuns).toHaveLength(1);
    expect(pageOne.text.slice(pageOne.colorRuns[0]!.start, pageOne.colorRuns[0]!.end)).toBe(pageOne.text);
  });

  it("normalizes gray and CMYK fills the same way as RGB, with no red colorRun for either", async () => {
    const pdf = await PDFDocument.create();
    const page = pdf.addPage([400, 200]);
    const font = await pdf.embedFont(StandardFonts.Helvetica);
    page.drawText("Gray body text.", { x: 20, y: 150, size: 14, font, color: grayscale(0.4) });
    page.drawText("Blue emphasis text.", { x: 20, y: 100, size: 14, font, color: cmyk(1, 0.5, 0, 0) });
    const bytes = await pdf.save();

    const source = await parsePdfForImport({ bytes, fileName: "gray-cmyk.pdf" });
    const pageOne = source.pages[0]!;
    expect(pageOne.colorRuns.some((run) => run.color === "red")).toBe(false);
  });

  it("reports no colorRuns for an OCR'd (image-only) page", async () => {
    const fixturePath = join(process.cwd(), "tests/fixtures/portfolio-import", "scan-application-ocr.pdf");
    const source = await parsePdfForImport({ bytes: new Uint8Array(readFileSync(fixturePath)), fileName: "Scan.pdf" });
    expect(source.pages[0]?.colorRuns).toEqual([]);
  });
});
