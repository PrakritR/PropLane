import { describe, expect, it } from "vitest";
import type { DemoApplicantRow } from "@/data/demo-portal";
import { buildCheckrTenantReportHtml } from "@/lib/checkr/tenant-report-html";

/**
 * The report's stat tiles printed the literal string "null" under five of six
 * headings — Eviction records, Criminal, Sex offender registry, Global
 * watchlist, On-time payments.
 *
 * `statCard` fell back to `: null` for a missing sub-label, and a template
 * literal stringifies null rather than dropping it. JSX would have rendered
 * nothing; an HTML string builder prints the word. This is the one place in
 * the report built as a string, which is why only it was affected.
 */
function applicant(overrides: Partial<DemoApplicantRow> = {}): DemoApplicantRow {
  return {
    id: "PROPLANE-TESTBG1",
    name: "Mason Clark",
    email: "mason@test.proplane.local",
    property: "Ballard House",
    stage: "Active",
    bucket: "pending",
    detail: "",
    // A completed check with NO snapshot — the state that exposed the bug,
    // because every count tile then renders without a sub-label.
    backgroundCheck: { status: "complete", result: "clear", packageSlug: "starter" },
    ...overrides,
  } as DemoApplicantRow;
}

describe("buildCheckrTenantReportHtml", () => {
  it("never prints the literal word null", () => {
    const html = buildCheckrTenantReportHtml(applicant());
    expect(html).not.toMatch(/>\s*null\s*</);
    expect(html).not.toContain("null</p>");
  });

  it("still renders the tiles and their headings", () => {
    const html = buildCheckrTenantReportHtml(applicant());
    for (const label of [
      "Eviction records",
      "Criminal",
      "Sex offender registry",
      "Global watchlist",
    ]) {
      expect(html).toContain(label);
    }
  });

  it("keeps a sub-label where one is supplied", () => {
    // "Est. debt/rent payments" is the one tile that passes a sub.
    expect(buildCheckrTenantReportHtml(applicant())).toContain("Monthly obligations");
  });
});
