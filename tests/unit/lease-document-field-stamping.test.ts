// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { extractText, getDocumentProxy } from "unpdf";
import { deriveInitials, pdfDataUrlToBytes, stampLeaseDocumentFields } from "@/lib/lease-document-field-stamping";
import type { LeaseDocumentField } from "@/lib/lease-document-library";

async function buildTwoPagePdfDataUrl(): Promise<string> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page1 = doc.addPage([612, 792]);
  page1.drawText("PAGE ONE — LEASE TERMS", { x: 50, y: 700, size: 14, font });
  const page2 = doc.addPage([612, 792]);
  page2.drawText("PAGE TWO — SIGNATURE PAGE", { x: 50, y: 700, size: 14, font });
  const bytes = await doc.save();
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return `data:application/pdf;base64,${btoa(binary)}`;
}

function field(overrides: Partial<LeaseDocumentField> = {}): LeaseDocumentField {
  return { id: "f1", page: 1, x: 0.1, y: 0.85, w: 0.3, h: 0.05, role: "resident", kind: "signature", ...overrides };
}

describe("stampLeaseDocumentFields", () => {
  it("returns null when no field has a value yet", async () => {
    const dataUrl = await buildTwoPagePdfDataUrl();
    const result = await stampLeaseDocumentFields(dataUrl, [field()], {});
    expect(result).toBeNull();
  });

  it("stamps a resident signature only onto its own page, not other pages", async () => {
    const dataUrl = await buildTwoPagePdfDataUrl();
    const result = await stampLeaseDocumentFields(dataUrl, [field()], { residentSignature: "Jordan Lee" });
    expect(result).not.toBeNull();

    const pdf = await getDocumentProxy(pdfDataUrlToBytes(result!));
    const { text } = await extractText(pdf);
    expect(Array.isArray(text)).toBe(true);
    const pages = text as string[];
    expect(pages).toHaveLength(2);
    expect(pages[1]).toContain("Jordan Lee");
    expect(pages[0]).not.toContain("Jordan Lee");
  });

  it("stamps each field only when its own value is present — a manager field stays blank until the manager signs", async () => {
    const dataUrl = await buildTwoPagePdfDataUrl();
    const fields = [
      field({ id: "r-sig", role: "resident", kind: "signature", page: 1, y: 0.7 }),
      field({ id: "m-sig", role: "manager", kind: "signature", page: 1, y: 0.8 }),
    ];
    const onlyResident = await stampLeaseDocumentFields(dataUrl, fields, { residentSignature: "Jordan Lee" });
    const pdf1 = await getDocumentProxy(pdfDataUrlToBytes(onlyResident!));
    const page1Text = ((await extractText(pdf1)).text as string[])[1];
    expect(page1Text).toContain("Jordan Lee");
    expect(page1Text).not.toContain("Pat Manager");

    const both = await stampLeaseDocumentFields(dataUrl, fields, {
      residentSignature: "Jordan Lee",
      managerSignature: "Pat Manager",
    });
    const pdf2 = await getDocumentProxy(pdfDataUrlToBytes(both!));
    const page2Text = ((await extractText(pdf2)).text as string[])[1];
    expect(page2Text).toContain("Jordan Lee");
    expect(page2Text).toContain("Pat Manager");
  });

  it("stamps a date field with the provided date text", async () => {
    const dataUrl = await buildTwoPagePdfDataUrl();
    const result = await stampLeaseDocumentFields(
      dataUrl,
      [field({ id: "d1", kind: "date", role: "resident" })],
      { residentDateSigned: "2026-09-25" },
    );
    const pdf = await getDocumentProxy(pdfDataUrlToBytes(result!));
    const page1Text = ((await extractText(pdf)).text as string[])[1];
    expect(page1Text).toContain("2026-09-25");
  });

  it("preserves the page count and never touches a field's declared page index incorrectly", async () => {
    const dataUrl = await buildTwoPagePdfDataUrl();
    const result = await stampLeaseDocumentFields(dataUrl, [field({ page: 0 })], { residentSignature: "Jordan Lee" });
    const pdf = await getDocumentProxy(pdfDataUrlToBytes(result!));
    const pages = (await extractText(pdf)).text as string[];
    expect(pages).toHaveLength(2);
    expect(pages[0]).toContain("Jordan Lee");
    expect(pages[1]).not.toContain("Jordan Lee");
  });
});

describe("deriveInitials", () => {
  it("takes the first letter of up to three words", () => {
    expect(deriveInitials("Jordan Lee")).toBe("JL");
    expect(deriveInitials("Mary Jane Watson Extra")).toBe("MJW");
    expect(deriveInitials("Cher")).toBe("C");
    expect(deriveInitials("  ")).toBe("—");
  });
});
