import { describe, expect, it } from "vitest";
import { formatPageList, summarizeImportIssues } from "@/lib/pdf-import/import-issue-summary";

describe("PDF import issue summary", () => {
  it("collapses consecutive pages into ranges", () => {
    expect(formatPageList([4])).toBe("page 4");
    expect(formatPageList([3, 1, 2, 2, 5, 7, 8])).toBe("pages 1-3, 5, 7-8");
  });

  it("groups one line per issue kind in first-seen order", () => {
    const issue = (pageNumber: number | null, code: string, message = "m") => ({ pageNumber, code, message });
    expect(
      summarizeImportIssues([
        issue(1, "image_requires_review"),
        issue(2, "form_fields_present"),
        issue(2, "image_requires_review"),
        issue(3, "image_requires_review"),
        issue(null, "new_code", "Something new happened."),
      ]),
    ).toEqual([
      { key: "image_requires_review", label: "Images", pages: "pages 1-3" },
      { key: "form_fields_present", label: "Form fields", pages: "page 2" },
      { key: "new_code:Something new happened.", label: "Something new happened.", pages: null },
    ]);
  });
});
