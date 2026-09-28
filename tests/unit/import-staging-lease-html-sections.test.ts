// F016: reversing a lease template's rendered HTML back into {title, body}
// sections, well enough to diff against a freshly parsed import. Adapts
// the existing `parseLeaseHtmlSections` splitter rather than reimplementing it.
import { describe, expect, it } from "vitest";
import { extractLeaseSectionsFromHtml } from "@/lib/import-staging/lease-html-sections";
import { buildProplaneLeaseHtmlFromSections } from "@/lib/lease-pdf-parse";

describe("extractLeaseSectionsFromHtml", () => {
  it("round-trips sections produced by buildProplaneLeaseHtmlFromSections (sourceOnly, the imported-template shape)", () => {
    const html = buildProplaneLeaseHtmlFromSections({
      sections: [
        { title: "Fees", body: "Rent is $1,200 per month.\n\nA $50 late fee applies after the 5th." },
        { title: "Pets", body: "No pets allowed." },
      ],
      docName: "Sample lease",
      sourceOnly: true,
    });
    const sections = extractLeaseSectionsFromHtml(html);
    expect(sections).toHaveLength(2);
    expect(sections[0]!.title).toBe("Fees");
    expect(sections[0]!.body).toBe("Rent is $1,200 per month.\n\nA $50 late fee applies after the 5th.");
    expect(sections[1]!.title).toBe("Pets");
    expect(sections[1]!.body).toBe("No pets allowed.");
  });

  it("strips a numbered heading prefix so it matches the parser's own un-numbered title", () => {
    const html = buildProplaneLeaseHtmlFromSections({
      sections: [{ title: "Fees", body: "Rent details." }],
      docName: "Sample lease",
      sourceOnly: false,
    });
    const sections = extractLeaseSectionsFromHtml(html);
    expect(sections.some((s) => s.title === "Fees")).toBe(true);
  });

  it("drops any preamble before the first heading rather than treating it as a section", () => {
    const html = `<!DOCTYPE html><html><body><p class="note">Imported note.</p><h2>Fees</h2><p>Rent details.</p></body></html>`;
    const sections = extractLeaseSectionsFromHtml(html);
    expect(sections.map((s) => s.title)).toEqual(["Fees"]);
  });

  it("returns an empty list for HTML with no <h2> headings", () => {
    expect(extractLeaseSectionsFromHtml("<p>Just a paragraph, no headings.</p>")).toEqual([]);
  });

  it("returns an empty list for empty input", () => {
    expect(extractLeaseSectionsFromHtml("")).toEqual([]);
    expect(extractLeaseSectionsFromHtml("   ")).toEqual([]);
  });

  it("decodes HTML entities in both title and body", () => {
    const html = "<h2>Terms &amp; Conditions</h2><p>Rent &gt; $1,000 &amp; due monthly.</p>";
    const sections = extractLeaseSectionsFromHtml(html);
    expect(sections[0]!.title).toBe("Terms & Conditions");
    expect(sections[0]!.body).toBe("Rent > $1,000 & due monthly.");
  });
});
