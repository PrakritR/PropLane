/** Short labels for the source-review codes `parsePdfForImport` emits. */
const ISSUE_LABELS: Record<string, string> = {
  image_requires_review: "Images",
  form_fields_present: "Form fields",
  ocr_requires_review: "Read with OCR",
  unreadable_page: "No readable text",
  annotation_scan_failed: "Not fully inspected",
};

/** `[1, 2, 3, 5]` -> `"pages 1-3, 5"`; `[4]` -> `"page 4"`. */
export function formatPageList(pages: number[]): string {
  const sorted = [...new Set(pages)].sort((a, b) => a - b);
  const ranges: string[] = [];
  for (let i = 0; i < sorted.length; i += 1) {
    const start = sorted[i]!;
    while (sorted[i + 1] === sorted[i]! + 1) i += 1;
    ranges.push(start === sorted[i] ? `${start}` : `${start}-${sorted[i]}`);
  }
  return `${sorted.length === 1 ? "page" : "pages"} ${ranges.join(", ")}`;
}

/**
 * One line per kind of issue, in first-seen order, instead of one sentence per
 * page. An unknown code keeps its own message so nothing is silently dropped.
 */
export function summarizeImportIssues(
  issues: Array<{ pageNumber: number | null; code: string; message: string }>,
): Array<{ key: string; label: string; pages: string | null }> {
  const groups = new Map<string, { label: string; pages: number[] }>();
  for (const issue of issues) {
    const label = ISSUE_LABELS[issue.code];
    const key = label ? issue.code : `${issue.code}:${issue.message}`;
    const group = groups.get(key) ?? { label: label ?? issue.message, pages: [] };
    if (issue.pageNumber) group.pages.push(issue.pageNumber);
    groups.set(key, group);
  }
  return [...groups].map(([key, { label, pages }]) => ({
    key,
    label,
    pages: pages.length ? formatPageList(pages) : null,
  }));
}
