import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/** STD-6: rent-receipt rows must not show raw ISO in list labels. */
describe("portal list dates — rent receipts", () => {
  it("resident-documents-panel formats receipt meta and detail copy", () => {
    const source = readFileSync(
      join(process.cwd(), "src/components/portal/resident-documents-panel.tsx"),
      "utf8",
    );
    expect(source).toContain("formatPortalListDate");
    expect(source).toMatch(/meta:\s*formatPortalListDate\(row\.date\)/);
  });

  it("documents-download-all-modal formats receipt row labels", () => {
    const source = readFileSync(
      join(process.cwd(), "src/components/portal/documents-download-all-modal.tsx"),
      "utf8",
    );
    expect(source).toMatch(/formatPortalListDate\(row\.date\)/);
  });
});
