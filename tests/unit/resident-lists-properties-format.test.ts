/**
 * Every resident list page follows the manager Properties list: one band card (tabs with counts,
 * search, the round +) and one record card per row. No dashed "+ Apply" / "+ Schedule tour" create
 * card, no "Incomplete" word, no group header, and no standalone tab bar floating outside a band.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const read = (name: string) => readFileSync(join(process.cwd(), "src/components/portal", name), "utf8");

const RESIDENT_LIST_PAGES = [
  "resident-applications-panel.tsx",
  "resident-tour-panel.tsx",
  "resident-payments-panel.tsx",
  "resident-lease-panel.tsx",
  "resident-lease-list.tsx",
  "resident-documents-panel.tsx",
  "resident-other-documents.tsx",
  "resident-services-panel.tsx",
  "resident-portal-data-list.tsx",
  "resident-portal-grouped-data-list.tsx",
  "resident-record-card-row.tsx",
];

describe("resident list pages use the Properties format", () => {
  it.each(RESIDENT_LIST_PAGES)("%s draws no dashed create card", (file) => {
    const src = read(file);
    expect(src).not.toContain("PortalListAddRow");
    expect(src).not.toContain("border-dashed");
  });

  it.each(RESIDENT_LIST_PAGES)("%s draws no Incomplete word and no group header", (file) => {
    const src = read(file);
    expect(src).not.toMatch(/>\s*Incomplete\s*</);
    expect(src).not.toMatch(/\bPortalListGroup\b/);
    expect(src).not.toContain("ApplicationHouseholdCluster");
  });

  it("each list's create action is the band's round + named Add <noun>", () => {
    expect(read("resident-applications-panel.tsx")).toContain('portalListAddPrimaryLabel("application")');
    expect(read("resident-tour-panel.tsx")).toContain('portalListAddPrimaryLabel("tour")');
    expect(read("resident-documents-panel.tsx")).toContain('portalListAddPrimaryLabel("document")');
    expect(read("resident-services-panel.tsx")).toContain('portalListAddPrimaryLabel("service")');
  });

  it("every list band carries a search box", () => {
    for (const file of [
      "resident-applications-panel.tsx",
      "resident-tour-panel.tsx",
      "resident-payments-panel.tsx",
      "resident-lease-panel.tsx",
      "resident-documents-panel.tsx",
      "resident-services-panel.tsx",
    ]) {
      expect(read(file)).toMatch(/search=\{\{/);
    }
  });

  it("the stay-length choice is a Filter in the band, never a second tab bar above it", () => {
    for (const file of ["resident-payments-panel.tsx", "resident-lease-panel.tsx"]) {
      const src = read(file);
      expect(src).toContain("ResidentTermBandFilter");
      expect(src).not.toContain("<ResidentTermTabs");
    }
  });

  it("the application record's Withdraw is a header icon, not a labeled button", () => {
    const src = read("resident-applications-panel.tsx");
    expect(src).toMatch(/<PortalIconAction[^>]*label="Withdraw"/s);
  });
});
