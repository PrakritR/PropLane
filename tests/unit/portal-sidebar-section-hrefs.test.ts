/**
 * Sidebar list hrefs must match what render-portal-section actually serves.
 * Finances and Documents are tab-only routes — no `/pending` bucket segment.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { hrefForSection } from "@/components/portal/portal-nav-model";
import { MANAGER_PORTAL_SMOKE_PATHS, proPortal } from "@/lib/portals/pro";

describe("portal sidebar section hrefs", () => {
  const sidebarSrc = readFileSync(
    join(process.cwd(), "src/components/portal/portal-nav-model.ts"),
    "utf8",
  );

  it("does not append /pending to tab-only manager sections", () => {
    expect(sidebarSrc).not.toContain("${meta.tabs[0].id}/pending");
    // Tasks has real tabs now (Open · Assigned · Scheduled · Completed): it links to its first tab like any
    // other tabbed section, with no special case.
    expect(sidebarSrc).not.toContain('if (section === "tasks")');
    expect(hrefForSection(proPortal, "tasks")).toBe("/portal/tasks/open");
    expect(hrefForSection(proPortal, "financials")).toBe("/portal/financials/overview");
    expect(hrefForSection(proPortal, "documents")).toBe("/portal/documents/applications");
  });

  it("matches smoke paths for Finances and Documents", () => {
    const finances = MANAGER_PORTAL_SMOKE_PATHS.find((p) => p.label === "Finances");
    const documents = MANAGER_PORTAL_SMOKE_PATHS.find((p) => p.label === "Documents");
    expect(finances?.path).toBe("/portal/financials/overview");
    expect(documents?.path).toBe("/portal/documents/applications");
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
