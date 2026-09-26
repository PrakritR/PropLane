/**
 * Admin Accounts and Test accounts rows open a real, deep-linkable record page
 * instead of an inline accordion (C165, C168) — following the flat-cards
 * shape `admin-property-record-page.tsx` (C163) established. This reads
 * source rather than rendering, the same pattern as
 * tests/unit/admin-list-surface-adoption.test.ts.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

describe("admin Accounts rows open a routed record page", () => {
  const src = read("src/components/portal/admin-axis-users-client.tsx");

  it("accepts a detailId and navigates rows into /admin/axis-users/<kind>-<id>", () => {
    expect(src).toContain("detailId");
    expect(src).toMatch(/navigate\(`\/admin\/axis-users\/\$\{encodeURIComponent\(rowKeyOf\(row\)\)\}`\)/);
    expect(src).not.toContain("expandedKey");
    expect(src).not.toContain("ExpandedContent");
  });

  it("carries a settings gear into admin Settings, matching every manager list page", () => {
    expect(src).toContain('icon={Settings}');
    expect(src).toContain('navigate("/admin/profile")');
  });

  it("a manager row's figure is its plan and comms credit, not the old tier/status pills", () => {
    expect(src).not.toContain("TierBadge");
    expect(src).not.toContain("<StatusPill");
    expect(src).toContain("billing?.planLabel");
    expect(src).toContain("commsCreditLabel");
  });
});

describe("admin-account-record-page renders Overview / Plan & billing / Danger zone", () => {
  const src = read("src/components/portal/admin-account-record-page.tsx");

  it("has the three cards the redesign calls for", () => {
    expect(src).toContain('title="Overview"');
    expect(src).toContain('title="Plan & billing"');
    expect(src).toContain('title="Danger zone"');
  });

  it("only a manager carries a plan and billing card", () => {
    expect(src).toMatch(/row\.kind === "manager" \? \(\s*<RecordFactCard title="Plan & billing"/);
  });
});

describe("admin Test accounts rows open a routed record page", () => {
  const src = read("src/components/portal/admin-test-workspaces-client.tsx");

  it("accepts a detailId and navigates rows into /admin/test-accounts/<id>", () => {
    expect(src).toContain("detailId");
    expect(src).toMatch(/navigate\(`\/admin\/test-accounts\/\$\{encodeURIComponent\(workspace\.id\)\}`\)/);
    expect(src).not.toContain("expandedId");
  });

  it("replaces the labelled Create workspace button with the round + primary", () => {
    expect(src).toContain("PortalPrimaryIconAction");
    expect(src).not.toMatch(/>\s*Create workspace\s*<\/Button>/);
  });
});

describe("admin routes forward a detail segment for properties, accounts and test workspaces", () => {
  const src = read("src/lib/render-portal-section.tsx");

  it("properties, axis-users and test-accounts each pass detailId through", () => {
    expect(src).toContain("<AdminPropertiesClient detailId={detailId} />");
    expect(src).toContain("<AdminAxisUsersClient detailId={detailId} />");
    expect(src).toContain("<AdminTestWorkspacesClient detailId={detailId} />");
  });
});
