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
    expect(src).toMatch(/navigate\(`\/admin\/axis-users\/\$\{encodeURIComponent\(adminAccountKey\(row\.kind, row\.id\)\)\}`\)/);
    expect(src).not.toContain("expandedKey");
    expect(src).not.toContain("ExpandedContent");
  });

  it("carries a settings gear into admin Settings, matching every manager list page", () => {
    expect(src).toContain('icon={Settings}');
    expect(src).toContain('navigate("/admin/profile")');
  });

  it("a manager row's facts are plan, workspaces and last sign-in, not the old tier/status pills", () => {
    expect(src).not.toContain("TierBadge");
    expect(src).not.toContain("<StatusPill");
    expect(src).toContain("billing?.planLabel");
    expect(src).toContain("workspaceCount");
    expect(src).toContain("lastSignInAt");
  });

  it("shows Disabled in red only on a disabled account", () => {
    expect(src).toContain('figure={row.active ? undefined : { value: "Disabled", tone: "bad" }}');
  });
});

describe("admin-account-record-page: header, rail and one read", () => {
  const src = read("src/components/portal/admin-account-record-page.tsx");
  const sections = read("src/components/portal/admin-account-record-sections.tsx");
  const keys = read("src/lib/admin/admin-account-keys.ts");

  it("reads the whole record from GET /api/admin/accounts/<id>", () => {
    expect(src).toContain("/api/admin/accounts/${encodeURIComponent(id)}");
  });

  it("puts the View-as slot first in the header, then Disable and a red Delete", () => {
    const header = src.slice(src.indexOf("<PortalRecordActions>"), src.indexOf("</PortalRecordActions>"));
    expect(header.indexOf("<AdminViewAsAction")).toBeGreaterThan(-1);
    expect(header.indexOf("<AdminViewAsAction")).toBeLessThan(header.indexOf('data-attr="admin-account-toggle-active"'));
    expect(header.indexOf('data-attr="admin-account-toggle-active"')).toBeLessThan(
      header.indexOf('data-attr="admin-account-delete"'),
    );
    expect(header).toContain('tone="danger"');
  });

  it("groups the rail Account · Money · Activity", () => {
    expect(keys).toContain('{ label: "Account", ids: ["overview", "workspaces"] }');
    expect(keys).toContain('{ label: "Money", ids: ["billing", "payments"] }');
    expect(keys).toContain('{ label: "Activity", ids: ["communication", "audit", "support"] }');
    expect(keys).toContain('billing: "Billing & plan"');
    expect(keys).toContain('communication: "Communication log"');
    expect(keys).toContain('audit: "Audit trail"');
  });

  it("Billing & plan is Subscription · Trial & discounts · Limits fact cards, then the account's payments", () => {
    const detail = read("src/components/portal/admin-manager-account-detail.tsx");
    expect(sections).toContain("ManagerBillingCards");
    expect(sections).toContain('title="Payments from this account"');
    expect(sections).toContain("/api/admin/accounts/${encodeURIComponent(accountId)}/billing");
    for (const title of ["Subscription", "Trial & discounts", "Limits"]) {
      expect(detail).toContain(`title="${title}"`);
    }
    // The fact rows the plan names.
    for (const label of ["Plan", "Source", "Status", "Since", "Paid to date", "Promo", "Trial ends", "Complimentary", "Property cap", "Processing fees"]) {
      expect(detail).toContain(`label="${label}"`);
    }
  });

  it("changes are icon actions at each card's top right, never labelled buttons", () => {
    const detail = read("src/components/portal/admin-manager-account-detail.tsx");
    for (const label of ["Open in Stripe", "Change plan", "Extend trial", "Apply promo code"]) {
      expect(detail).toMatch(new RegExp(`<PortalIconAction[^>]*label="${label}"`, "s"));
    }
    expect(detail).toMatch(/label=\{complimentary \? "Remove complimentary" : "Make complimentary"\}/);
    expect(detail).toContain("headerActions=");
  });

  it("no grey overlay block and no muted explanation under a field", () => {
    const detail = read("src/components/portal/admin-manager-account-detail.tsx");
    expect(detail).not.toContain("Recorded only");
    expect(detail).not.toContain("billing does not read it yet");
    expect(detail).not.toContain("FEE_OVERRIDE_HELP_TEXT");
    expect(detail).not.toContain("bg-background/60");
    expect(detail).not.toMatch(/text-\[11px\] text-muted/);
  });

  it("every billing change opens the reason popup and sends the reason with it", () => {
    const detail = read("src/components/portal/admin-manager-account-detail.tsx");
    const dialog = read("src/components/portal/admin-billing-action-dialog.tsx");
    for (const id of ["plan", "trial", "promo", "comp", "cap"]) {
      expect(detail).toContain(`dataAttr="admin-billing-${id}-dialog"`);
    }
    // Required: the primary stays off until a reason is typed.
    expect(dialog).toContain("disabled: !canSubmit || !trimmed || busy");
    expect(dialog).toContain("required");
    expect((detail.match(/reason/g) ?? []).length).toBeGreaterThan(8);
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
    expect(src).toContain("<AdminAxisUsersClient detailId={detailId} detailSection={detailSection} />");
    expect(src).toContain("<AdminTestWorkspacesClient detailId={detailId} />");
  });
});
