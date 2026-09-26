// C282 — Settings → Forms → License agreement must show the real imported
// document's OWN sections, not one flat "General" bucket. Before this
// change, `mapLeaseTemplatePdfImport` never set `field.section` at all, so a
// manager importing a real PDF got a single undifferentiated list — the
// section grouping visible for Ida Cares only existed because that seed data
// was hand-authored with `section` already set. This pins the deterministic
// heading heuristic that now classifies real imports.
import { describe, expect, it } from "vitest";
import { leaseImportMappingToDraft, mapLeaseTemplatePdfImport } from "@/lib/lease-template-pdf-import";
import type { PdfColorRun, PdfImportSource } from "@/lib/pdf-import/pdf-source.server";

function block(text: string, start: number): { text: string; start: number; end: number } {
  return { text, start, end: start + text.length };
}

function sourceFromPageTexts(pageTexts: string[][], colorRunsByPage?: PdfColorRun[][]): PdfImportSource {
  return {
    sourceSha256: "a".repeat(64),
    fileName: "lease.pdf",
    pages: pageTexts.map((blocks, index) => ({
      pageNumber: index + 1,
      text: blocks.join("\n"),
      blocks: blocks.map((text, i) => block(text, i * 1000)),
      formFields: [],
      issues: [],
      colorRuns: colorRunsByPage?.[index] ?? [],
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

describe("mapLeaseTemplatePdfImport — red-flag emphasis from the PDF's own color (C276)", () => {
  // `sourceFromPageTexts` assigns each page block's [start, end) via `block()`
  // above — index `i` in the page's text array starts at `i * 1000` — so a
  // colorRun fixture must line up with THAT scheme (not the joined page
  // text's real character offsets) to overlap the clause block it targets.
  // The clause is always index 1 (after the "VIII. House rules" heading at
  // index 0), so its block spans [1000, 1000 + clause.length).
  const CLAUSE_BLOCK_START = 1000;

  it("flags a clause whose entire source span is covered by a red colorRun", () => {
    const clause = "No smoking is permitted anywhere on the property, including balconies and the yard.";
    const source = sourceFromPageTexts(
      [["VIII. House rules", clause]],
      [[{ start: CLAUSE_BLOCK_START, end: CLAUSE_BLOCK_START + clause.length, color: "red", hex: "#cc0d0d" }]],
    );
    const mapping = mapLeaseTemplatePdfImport(source);
    expect(mapping.questions).toHaveLength(1);
    expect(mapping.questions[0]!.flagged).toBe(true);
  });

  it("does not flag an ordinary black clause with no colorRun", () => {
    const source = sourceFromPageTexts([
      ["VIII. House rules", "Quiet hours are observed between 10pm and 7am on all days of the week."],
    ]);
    const mapping = mapLeaseTemplatePdfImport(source);
    expect(mapping.questions[0]!.flagged).toBeUndefined();
  });

  it("does not flag a clause where red covers only a minority of its characters", () => {
    const clause = "Quiet hours are observed between 10pm and 7am on all days of the week without exception.";
    const source = sourceFromPageTexts(
      [["VIII. House rules", clause]],
      // Only the first 10 characters ("Quiet hour") are red — well under half the clause.
      [[{ start: CLAUSE_BLOCK_START, end: CLAUSE_BLOCK_START + 10, color: "red", hex: "#cc0d0d" }]],
    );
    const mapping = mapLeaseTemplatePdfImport(source);
    expect(mapping.questions[0]!.flagged).toBeUndefined();
  });

  it("does not flag a clause colored a non-red 'other' hue", () => {
    const clause = "Guests may not stay for more than fourteen consecutive nights without written approval.";
    const source = sourceFromPageTexts(
      [["VIII. House rules", clause]],
      [[{ start: CLAUSE_BLOCK_START, end: CLAUSE_BLOCK_START + clause.length, color: "other", hex: "#1155cc" }]],
    );
    const mapping = mapLeaseTemplatePdfImport(source);
    expect(mapping.questions[0]!.flagged).toBeUndefined();
  });

  it("carries flagged through to the draft question config", () => {
    const clause = "No pets of any kind are permitted anywhere on the premises at any time.";
    const source = sourceFromPageTexts(
      [["VIII. House rules", clause]],
      [[{ start: CLAUSE_BLOCK_START, end: CLAUSE_BLOCK_START + clause.length, color: "red", hex: "#cc0d0d" }]],
    );
    const draft = leaseImportMappingToDraft(mapLeaseTemplatePdfImport(source));
    expect(draft.customApplicationFields[0]!.flagged).toBe(true);
  });
});
