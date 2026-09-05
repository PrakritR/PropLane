import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DOCUMENT_TAB_DESTINATIONS } from "@/components/portal/pro-documents-panel";

describe("documents list chrome", () => {
  it("uses Properties/Tours-style command tabs instead of a left rail", () => {
    const source = readFileSync(
      join(process.cwd(), "src/components/portal/pro-documents-panel.tsx"),
      "utf8",
    );
    expect(source).toContain('variant="command"');
    expect(source).toContain("destinations={documentTabItems.map");
    expect(source).toContain("documentsCommandActions");
    expect(source).not.toContain("DocumentsDestinationNav");
    expect(source).not.toContain("lg:flex-row lg:items-start");
  });

  it("lists application, lease, and other document views only", () => {
    expect(DOCUMENT_TAB_DESTINATIONS.map((tab) => tab.id)).toEqual([
      "applications",
      "leases",
      "other",
    ]);
  });
});
