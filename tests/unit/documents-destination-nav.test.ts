// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DOCUMENT_NAV_TAB_IDS } from "@/components/portal/documents-destination-nav";
import { DOCUMENT_TABS } from "@/components/portal/manager-documents-panel";

describe("documents destination nav", () => {
  it("lists every document view in one flat rail", () => {
    expect(DOCUMENT_NAV_TAB_IDS).toEqual(DOCUMENT_TABS.map((tab) => tab.id));
    expect(DOCUMENT_NAV_TAB_IDS).toContain("applications");
    expect(DOCUMENT_NAV_TAB_IDS).toContain("leases");
    expect(DOCUMENT_NAV_TAB_IDS).toContain("income-documents");
    expect(DOCUMENT_NAV_TAB_IDS).toContain("expense-documents");
  });

  it("uses a left rail on desktop and a single mobile row (no grouped tiers)", () => {
    const source = readFileSync(
      join(process.cwd(), "src/components/portal/documents-destination-nav.tsx"),
      "utf8",
    );
    expect(source).toContain("hidden min-w-[11.5rem] shrink-0 flex-col gap-0.5 lg:flex");
    expect(source).toContain("lg:hidden");
    expect(source).not.toContain("DOCUMENT_NAV_GROUPS");
    expect(source).not.toContain('appearance="command"');
  });
});
