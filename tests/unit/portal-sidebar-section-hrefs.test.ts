/**
 * Sidebar list hrefs must match what render-portal-section actually serves.
 * Finances and Documents are tab-only routes — no `/pending` bucket segment.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MANAGER_PORTAL_SMOKE_PATHS } from "@/lib/portals/pro";

describe("portal sidebar section hrefs", () => {
  const sidebarSrc = readFileSync(
    join(process.cwd(), "src/components/portal/portal-sidebar.tsx"),
    "utf8",
  );

  it("does not append /pending to tab-only manager sections", () => {
    expect(sidebarSrc).not.toContain("${meta.tabs[0].id}/pending");
    expect(sidebarSrc).toContain('if (section === "tasks") return `${def.basePath}/tasks`');
  });

  it("matches smoke paths for Finances and Documents", () => {
    const finances = MANAGER_PORTAL_SMOKE_PATHS.find((p) => p.label === "Finances");
    const documents = MANAGER_PORTAL_SMOKE_PATHS.find((p) => p.label === "Documents");
    expect(finances?.path).toBe("/portal/financials/income");
    expect(documents?.path).toBe("/portal/documents/library");
    expect(finances?.path).not.toContain("/pending");
    expect(documents?.path).not.toContain("/pending");
  });
});

describe("legacy /pending suffix on Finances and Documents", () => {
  const renderSrc = readFileSync(
    join(process.cwd(), "src/lib/render-portal-section.tsx"),
    "utf8",
  );

  it("redirects manager finances/documents /pending bookmarks to the tab root", () => {
    expect(renderSrc).toContain('tabParts[1] === "pending"');
    expect(renderSrc).toContain("redirect(`${basePath}/financials/${tabParts[0]}`)");
    expect(renderSrc).toContain("redirect(`${basePath}/documents/${docTab}`)");
  });
});
