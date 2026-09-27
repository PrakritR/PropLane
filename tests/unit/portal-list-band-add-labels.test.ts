/**
 * Night QA findings #3/#4/#8: several list-band primaries read a custom
 * label ("New promotion", "Upload document", "Request payment", "Upload")
 * instead of the mandated "Add <noun>" (`portalListAddPrimaryLabel`,
 * `src/components/portal/portal-list-control-stack.tsx`), and Admin Accounts
 * put labelled status/tier pills straight in the guarded list band instead
 * of behind the shared Filter sheet. The dev-mode
 * `[portal-list-control-stack]` guard flags both on every render; this pins
 * the fix at the source level so it cannot silently regress.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

describe("list-band primary labels use portalListAddPrimaryLabel, not a bespoke string", () => {
  it.each([
    ["Promotion", "src/components/portal/pro-promotion.tsx", "New promotion"],
    ["Documents", "src/components/portal/pro-documents-panel.tsx", "Upload document"],
    ["Vendor Documents", "src/components/portal/vendor-documents-panel.tsx", "Upload"],
    ["Vendor Invoices/Finances", "src/components/portal/vendor-finances-panel.tsx", "Request payment"],
  ])("%s no longer hard-codes the old label", (_name, path, oldLabel) => {
    const src = read(path);
    expect(src).toContain("portalListAddPrimaryLabel");
    // The literal used to appear as a `label=` prop value; it may still
    // appear in an onClick handler name or comment, so check specifically
    // that it is gone as a quoted label prop.
    expect(src).not.toMatch(new RegExp(`label(=|:)\\s*"${oldLabel}"`));
  });
});

describe("Admin Accounts filter is behind the shared Filter sheet, not raw pills in the list band", () => {
  const src = read("src/components/portal/admin-axis-users-client.tsx");

  it("uses PortalFilterSortSheet for status/tier instead of PORTAL_TOOLBAR_PILL_BUTTON", () => {
    expect(src).toContain("PortalFilterSortSheet");
    expect(src).not.toContain("PORTAL_TOOLBAR_PILL_BUTTON");
    expect(src).not.toContain("PORTAL_TOOLBAR_GROUP");
  });

  it("still lets staff filter by status and plan tier", () => {
    expect(src).toContain("AccountStatusFilterField");
    expect(src).toContain("AccountTierFilterField");
  });
});
