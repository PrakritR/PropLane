import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DOCUMENT_TABS } from "@/components/portal/manager-documents-panel";

describe("documents list chrome", () => {
  it("uses Properties/Tours-style command tabs instead of a left rail", () => {
    const source = readFileSync(
      join(process.cwd(), "src/components/portal/manager-documents-panel.tsx"),
      "utf8",
    );
    expect(source).toContain('variant="command"');
    expect(source).toContain("destinations={documentTabItems.map");
    expect(source).toContain("documentsCommandActions");
    expect(source).not.toContain("DocumentsDestinationNav");
    expect(source).not.toContain("lg:flex-row lg:items-start");
  });

  it("lists application and leasing document views first", () => {
    expect(DOCUMENT_TABS.slice(0, 4).map((tab) => tab.id)).toEqual([
      "applications",
      "leases",
      "income-documents",
      "expense-documents",
    ]);
  });
});
