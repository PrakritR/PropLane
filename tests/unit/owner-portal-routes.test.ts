/**
 * The owner portal is retired (captain, Oct 19): an owner uses the Property portal, the manager shell, like everyone else.
 * Every old /portal/owner URL is a permanent redirect to its Property-portal home, the pages and components are gone, and
 * the sign-in, invite and chooser paths no longer name an Owner destination.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { OWNER_PORTAL_REDIRECTS } from "@/lib/property-owner/legacy-redirects";
import { TEAM_ROLE_INVITE_OPTIONS, TEAM_ROLE_LABELS, TEAM_ROLE_SELECT_OPTIONS } from "@/lib/co-manager-team-roles";

const read = (rel: string) => readFileSync(path.join(process.cwd(), rel), "utf8");
const dest = (source: string) => OWNER_PORTAL_REDIRECTS.find((r) => r.source === source)?.destination;

describe("/portal/owner/* redirects to the Property portal", () => {
  it("sends every old owner page to its Property-portal home, permanently", () => {
    expect(dest("/portal/owner")).toBe("/portal/dashboard");
    expect(dest("/portal/owner/finances")).toBe("/portal/financials/owner-payouts");
    expect(dest("/portal/owner/statements")).toBe("/portal/financials/owner-statement");
    expect(dest("/portal/owner/statements/:month")).toBe("/portal/financials/owner-statement?month=:month");
    expect(dest("/portal/owner/documents")).toBe("/portal/documents");
    expect(dest("/portal/owner/messages")).toBe("/portal/communication/active");
    expect(dest("/portal/owner/properties")).toBe("/portal/properties");
    expect(dest("/portal/owner/properties/:propertyId")).toBe("/portal/properties/all/:propertyId");
    expect(dest("/portal/owner/profile")).toBe("/portal/profile");
    // Anything else under /portal/owner (a typed or stale path) lands on the dashboard, never a 404.
    expect(dest("/portal/owner/:path*")).toBe("/portal/dashboard");
    for (const r of OWNER_PORTAL_REDIRECTS) {
      expect(r.permanent, r.source).toBe(true);
      expect(r.destination.startsWith("/portal/"), r.source).toBe(true);
      expect(r.destination, r.source).not.toContain("/portal/owner");
    }
  });

  it("is wired into next.config before the app router can answer, and no owner page is left behind", () => {
    expect(read("next.config.ts")).toContain("...OWNER_PORTAL_REDIRECTS");
    expect(existsSync(path.join(process.cwd(), "src/app/portal/owner"))).toBe(false);
    expect(existsSync(path.join(process.cwd(), "src/components/owner"))).toBe(false);
    expect(existsSync(path.join(process.cwd(), "src/components/owner/owner-portal-shell.tsx"))).toBe(false);
    expect(existsSync(path.join(process.cwd(), "src/lib/property-owner/sections.ts"))).toBe(false);
  });

  it("lands the redirected tabs on routes that resolve: Owner payouts and Owner statement are Financials tabs", () => {
    const render = read("src/lib/render-portal-section.tsx");
    const tabs = /const FINANCIALS_TABS = \[([^\]]*)\]/.exec(render)?.[1] ?? "";
    expect(tabs).toContain('"owner-payouts"');
    expect(tabs).toContain('"owner-statement"');
    expect(tabs.indexOf('"owner-payouts"')).toBeGreaterThan(tabs.indexOf('"payout-history"'));
  });
});

describe("owner-only accounts get the one manager shell", () => {
  it("the portal layout has no owner branch and mounts the view-only strip under the black top bar", () => {
    const layout = read("src/app/portal/layout.tsx");
    expect(layout).not.toMatch(/OwnerPortalShell|ownerOnly|OWNER_HOME_PATH|ownerRedirectFor/);
    expect(layout).toContain("PortalTopBar");
    expect(layout.indexOf("<ManagedReadOnlyStrip")).toBeGreaterThan(layout.indexOf("<PortalTopBar"));
    expect(layout.indexOf("<ManagedReadOnlyStrip")).toBeLessThan(layout.indexOf("<PortalWorkspaceRail"));
    expect(layout).toContain("PortalAssistantRail");
  });

  it("render-portal-section no longer redirects an owner-only account away from a manager section", () => {
    expect(read("src/lib/render-portal-section.tsx")).not.toMatch(/OWNER_HOME_PATH|getOwnerAccessState|ownerOnly/);
  });

  it("the chooser has no Owner entry and the roles route no longer reports ownerOnly", () => {
    const chooser = read("src/app/auth/choose-portal/page.tsx");
    expect(chooser).not.toMatch(/OWNER_ROLE_META|label: "Owner"|ownerOnly/);
    expect(chooser).toContain('label: "Property"');
    expect(read("src/app/api/auth/portal-roles/route.ts")).not.toContain("ownerOnly");
  });

  it("an accepted owner invite and every emailed owner link land in the Property portal", () => {
    expect(read("src/app/invite/[token]/invite-link-client.tsx")).not.toContain("/portal/owner");
    const senders = [
      "src/lib/owner-management/owner-line.server.ts",
      "src/lib/owner-management/monthly-statements.server.ts",
      "src/lib/managed-finance/vendor-bills.server.ts",
    ];
    // policies.server.ts sends the owner nothing since the fee agreement stopped being signed (captain, Oct 20):
    // it must still never name an owner-portal path, but it has no link of its own to check.
    for (const file of [...senders, "src/lib/owner-management/policies.server.ts"]) {
      expect(read(file), file).not.toContain("/portal/owner");
    }
    for (const file of senders) {
      expect(read(file), file).toContain("/portal/financials/owner-payouts");
    }
  });
});

describe("the invite role picker", () => {
  it("no longer offers Property owner; a house owner who should only look is a Viewer", () => {
    expect(TEAM_ROLE_INVITE_OPTIONS.map((o) => o.value)).not.toContain("property_owner");
    expect(TEAM_ROLE_INVITE_OPTIONS.map((o) => o.value)).toContain("viewer");
    // Existing rows are untouched: the role still parses and still has a label.
    expect(TEAM_ROLE_SELECT_OPTIONS.map((o) => o.value)).toContain("property_owner");
    expect(TEAM_ROLE_LABELS.property_owner).toBe("Property owner");
  });
});
