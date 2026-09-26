// C282 — Settings → Forms → License agreement must show the real imported
// document's OWN sections, not one flat "General" bucket. Before this
// change, `mapLeaseTemplatePdfImport` never set `field.section` at all, so a
// manager importing a real PDF got a single undifferentiated list — the
// section grouping visible for Ida Cares only existed because that seed data
// was hand-authored with `section` already set. This pins the deterministic
// heading heuristic that now classifies real imports.
import { describe, expect, it } from "vitest";
import { leaseImportMappingToDraft, mapLeaseTemplatePdfImport } from "@/lib/lease-template-pdf-import";
import type { PdfImportSource } from "@/lib/pdf-import/pdf-source.server";

function block(text: string, start: number): { text: string; start: number; end: number } {
  return { text, start, end: start + text.length };
}

function sourceFromPageTexts(pageTexts: string[][]): PdfImportSource {
  return {
    sourceSha256: "a".repeat(64),
    fileName: "lease.pdf",
    pages: pageTexts.map((blocks, index) => ({
      pageNumber: index + 1,
      text: blocks.join("\n"),
      blocks: blocks.map((text, i) => block(text, i * 1000)),
      formFields: [],
      issues: [],
    })),
    issues: [],
    coverage: { extractedCharacters: 1000, representedCharacters: 1000, complete: true },
  };
}

describe("mapLeaseTemplatePdfImport — section classification (C282)", () => {
  it("groups clauses under a roman-numeral heading, in source order", () => {
    const source = sourceFromPageTexts([
      [
        "I. Fees",
        "Resident agrees to pay a monthly license fee as described in this agreement and any addenda hereto.",
        "II. House rules",
        "Quiet hours are observed between 10pm and 7am on all days of the week without exception.",
      ],
    ]);
    const mapping = mapLeaseTemplatePdfImport(source);
    expect(mapping.questions).toHaveLength(2);
    expect(mapping.questions[0]!.section).toBe("I. Fees");
    expect(mapping.questions[1]!.section).toBe("II. House rules");
  });

  it("groups clauses under a short, unpunctuated title-style heading", () => {
    const source = sourceFromPageTexts([
      [
        "Acknowledgements",
        "I understand that this agreement does not constitute a standard residential lease under state law.",
      ],
    ]);
    const mapping = mapLeaseTemplatePdfImport(source);
    expect(mapping.questions).toHaveLength(1);
    expect(mapping.questions[0]!.section).toBe("Acknowledgements");
  });

  it("never emits the heading itself as a clause row", () => {
    const source = sourceFromPageTexts([
      ["I. Fees", "Resident agrees to pay a monthly license fee as described in this agreement."],
    ]);
    const mapping = mapLeaseTemplatePdfImport(source);
    expect(mapping.questions.some((q) => q.label === "I. Fees" || q.description === "I. Fees")).toBe(false);
  });

  it("falls back to General before any heading is seen", () => {
    const source = sourceFromPageTexts([
      ["Resident agrees to pay a monthly license fee as described in this agreement and any addenda hereto."],
    ]);
    const mapping = mapLeaseTemplatePdfImport(source);
    expect(mapping.questions[0]!.section).toBe("General");
  });

  it("carries a section across a page boundary until the next heading", () => {
    const source = sourceFromPageTexts([
      ["I. Fees", "Resident agrees to pay a monthly license fee as described in this agreement."],
      ["A late fee of $50 applies to any payment received after the fifth day of the month."],
    ]);
    const mapping = mapLeaseTemplatePdfImport(source);
    expect(mapping.questions).toHaveLength(2);
    expect(mapping.questions[1]!.section).toBe("I. Fees");
  });

  it("still reports every non-heading, non-clause block as an issue — never silently dropped", () => {
    // Ends in a period, so it is never mistaken for a heading — just a real,
    // too-short block (e.g. a stray page mark).
    const source = sourceFromPageTexts([["I. Fees", "Yes."]]);
    const mapping = mapLeaseTemplatePdfImport(source);
    expect(mapping.questions).toHaveLength(0);
    expect(mapping.issues.some((i) => i.code === "lease_clause_too_short_for_review")).toBe(true);
  });

  it("carries the classified section through to the draft question config", () => {
    const source = sourceFromPageTexts([
      ["I. Fees", "Resident agrees to pay a monthly license fee as described in this agreement."],
    ]);
    const draft = leaseImportMappingToDraft(mapLeaseTemplatePdfImport(source));
    expect(draft.customApplicationFields[0]!.section).toBe("I. Fees");
  });
});
