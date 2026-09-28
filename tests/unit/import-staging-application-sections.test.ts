// F004: grouping resolved application fields into diffable {title, body}
// sections, one per RENTAL_APPLICATION_SECTIONS bucket.
import { describe, expect, it } from "vitest";
import { applicationFieldsToImportSections } from "@/lib/import-staging/application-sections";
import { diffImportSections } from "@/lib/import-staging/section-diff";

describe("applicationFieldsToImportSections", () => {
  it("groups fields by section id and skips empty sections", () => {
    const sections = applicationFieldsToImportSections([
      { id: "full_name", label: "Full name", type: "text", required: true, section: "personal" },
      { id: "employer", label: "Employer", type: "text", required: false, section: "employment" },
    ]);
    expect(sections.map((s) => s.key)).toEqual(["personal", "employment"]);
  });

  it("produces the same body for the same fields regardless of input order (stable signature)", () => {
    const a = applicationFieldsToImportSections([
      { id: "f1", label: "One", type: "text", required: true, section: "personal" },
      { id: "f2", label: "Two", type: "text", required: false, section: "personal" },
    ]);
    const b = applicationFieldsToImportSections([
      { id: "f2", label: "Two", type: "text", required: false, section: "personal" },
      { id: "f1", label: "One", type: "text", required: true, section: "personal" },
    ]);
    expect(a).toEqual(b);
  });

  it("feeds a diff that reports a new question in a section as changed", () => {
    const current = applicationFieldsToImportSections([
      { id: "full_name", label: "Full name", type: "text", required: true, section: "personal" },
    ]);
    const incoming = applicationFieldsToImportSections([
      { id: "full_name", label: "Full name", type: "text", required: true, section: "personal" },
      { id: "dob", label: "Date of birth", type: "text", required: true, section: "personal" },
    ]);
    const summary = diffImportSections(current, incoming);
    expect(summary.changedCount).toBe(1);
    expect(summary.entries.find((e) => e.key === "personal")?.status).toBe("changed");
  });

  it("a brand-new section not present today is added, and changed", () => {
    const current = applicationFieldsToImportSections([]);
    const incoming = applicationFieldsToImportSections([
      { id: "employer", label: "Employer", type: "text", required: false, section: "employment" },
    ]);
    const summary = diffImportSections(current, incoming);
    expect(summary.totalIncoming).toBe(1);
    expect(summary.changedCount).toBe(1);
    expect(summary.entries[0]!.status).toBe("added");
  });

  it("falls back to grouping by the raw section id for an unrecognized section value", () => {
    const sections = applicationFieldsToImportSections([
      { id: "weird", label: "Weird", type: "text", required: false, section: "not-a-real-section" },
    ]);
    expect(sections).toHaveLength(1);
    expect(sections[0]!.key).toBe("not-a-real-section");
  });
});
