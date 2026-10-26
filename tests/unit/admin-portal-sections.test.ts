/**
 * The admin sidebar: seven rows (Dashboard, Communication, Accounts, Money, Service, Support, Growth;
 * the grouped ones show their sections as a tab strip), and the Health
 * section wired through the registry, the nav groups, the renderer and the route tree.
 *
 * A section that is in one of these and not the others is a live nav row that lands nowhere (the
 * `/admin/billing` mistake), and nothing about it fails a build - so each hop is pinned.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { routeResolves } from "../helpers/route-resolves";
import { findSection } from "@/lib/portals";
import { ADMIN_PORTAL_SMOKE_PATHS, adminPortal } from "@/lib/portals/admin";
import {
  ADMIN_NAV_ROW_SECTIONS,
  ADMIN_SECTION_TABS,
  PORTAL_NAV_GROUPS,
  collapseAdminNavItems,
  groupNavItems,
} from "@/lib/portals/nav-groups";
import { hrefForSection } from "@/components/portal/portal-nav-model";
import { isInAppPath } from "@/lib/platform/parity";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

describe("admin nav groups", () => {
  const groups = PORTAL_NAV_GROUPS.admin;
  const rows = groups.flatMap((g) => g.sections);
  const registry = adminPortal.sections.map((s) => s.section);

  it("folds into eight rows: Settings first, then Dashboard, Communication, Accounts, Money, Service, Support, Growth", () => {
    expect(ADMIN_NAV_ROW_SECTIONS).toEqual([
      "profile",
      "dashboard",
      "communication",
      "axis-users",
      "payments",
      "service",
      "bugs-feedback",
      "growth",
    ]);
  });

  it("has no Property management group and no Properties or Subscribers section (Oct 25)", () => {
    expect(registry).not.toContain("properties");
    expect(registry).not.toContain("subscribers");
    expect(groups.map((g) => g.id)).not.toContain("property-management");
    expect(rows).not.toContain("properties");
    expect(rows).not.toContain("subscribers");
    expect(findSection(adminPortal, "properties")).toBeUndefined();
    expect(findSection(adminPortal, "subscribers")).toBeUndefined();
    expect(ADMIN_PORTAL_SMOKE_PATHS.map((p) => p.path)).not.toContain("/admin/properties");
    expect(ADMIN_PORTAL_SMOKE_PATHS.map((p) => p.path)).not.toContain("/admin/subscribers");
  });

  it("is one headed half (Software) after Dashboard/Communication and before Support/Growth, listing every section in row order so an unfolded caller buckets too", () => {
    expect(groups.map((g) => [g.id, g.label] as const)).toEqual([
      ["home", null],
      ["software", "Software"],
      ["platform", null],
    ]);
    expect(groups.find((g) => g.id === "software")?.sections).toEqual([
      "axis-users",
      "payments",
      "promo-codes",
      "finances",
      "managed-finance",
      "service",
      "proplane-line",
      "unassigned-leads",
    ]);
    // `test-accounts` is the operator-only inner Test tab of Accounts: routed, not a sidebar row.
    // Settings (`profile`) is the first item of the account menu, not a sidebar row (captain, Oct 25).
    expect(rows).toEqual([
      "dashboard",
      "communication",
      "axis-users",
      "payments",
      "promo-codes",
      "finances",
      "managed-finance",
      "service",
      "proplane-line",
      "unassigned-leads",
      "bugs-feedback",
      "events",
      "health",
      "growth",
    ]);
  });

  it("Service is ONE row whose tabs are Workspaces, PropLane line and Unassigned leads", () => {
    expect(ADMIN_SECTION_TABS.service).toEqual({
      label: "Service",
      sections: ["service", "proplane-line", "unassigned-leads"],
    });
    expect(ADMIN_SECTION_TABS.accounts).toBeUndefined();
    expect(findSection(adminPortal, "service")?.label).toBe("Workspaces");
  });

  it("reaches every admin section exactly once, through a row or a tab (Settings is the first row)", () => {
    const tabbed = Object.values(ADMIN_SECTION_TABS).flatMap((t) => t.sections);
    const rowsWithoutGroupKeys = ADMIN_NAV_ROW_SECTIONS.filter((id) => !tabbed.includes(id));
    // Test accounts is reached from Accounts' own Test tab, so it is the one section outside rows and strips.
    const reach = [...rowsWithoutGroupKeys, ...tabbed, "test-accounts"];
    expect(new Set(reach).size).toBe(reach.length);
    expect([...reach].sort()).toEqual([...registry].sort());
    // each grouped row key is the first tab of its group
    for (const group of Object.values(ADMIN_SECTION_TABS)) {
      expect(ADMIN_NAV_ROW_SECTIONS).toContain(group.sections[0]);
    }
  });

  it("keeps the registry in sidebar order so the native bar and the web nav agree", () => {
    const folded = collapseAdminNavItems(adminPortal.sections)
      .map((s) => s.section)
      .filter((id) => id !== "test-accounts");
    expect(folded).toEqual(ADMIN_NAV_ROW_SECTIONS);
  });

  it("groups the folded rows under the Software heading, with no row for Test accounts", () => {
    const items = collapseAdminNavItems(
      adminPortal.sections.map((s) => ({ section: s.section, label: s.label })),
    );
    const grouped = groupNavItems("admin", items);
    expect(grouped.map((g) => [g.id, g.label] as const)).toEqual([
      ["home", null],
      ["software", "Software"],
      ["platform", null],
    ]);
    expect(grouped.map((g) => g.items.map((i) => i.label))).toEqual([
      ["Dashboard", "Communication"],
      ["Accounts", "Money", "Service"],
      ["Support", "Growth"],
    ]);
  });

  it("leaves an unfolded caller (the command palette) every section as its own destination", () => {
    const items = adminPortal.sections.map((s) => ({ section: s.section, label: s.label }));
    const grouped = groupNavItems("admin", items);
    const flat = grouped.flatMap((g) => g.items);
    expect(flat.map((i) => i.section)).toEqual(rows);
    expect(flat.map((i) => i.label)).toContain("Promo codes");
    expect(flat.map((i) => i.label)).toContain("Health");
    expect(flat.map((i) => i.label)).toContain("PropLane line");
    // Test accounts and Settings are the routed sections with no row.
    expect(flat).toHaveLength(registry.length - 2);
  });

  it("has no Settings row in the sidebar, though the section stays registered and routable", () => {
    const items = collapseAdminNavItems(adminPortal.sections.map((s) => ({ section: s.section, label: s.label })));
    const sidebar = groupNavItems("admin", items).flatMap((g) => g.items);
    expect(sidebar.map((i) => i.section)).not.toContain("profile");
    expect(sidebar.map((i) => i.label)).not.toContain("Settings");
    expect(registry).toContain("profile");
    expect(routeResolves("/admin/profile")).toBe(true);
  });
});

describe("admin landing", () => {
  it("opens on Settings: Settings is the first registry section and /admin redirects to it", () => {
    expect(adminPortal.sections[0]!.section).toBe("profile");
    expect(ADMIN_PORTAL_SMOKE_PATHS[0]).toEqual({ label: "Settings", path: "/admin/profile" });
    expect(read("src/app/admin/page.tsx")).toContain('redirect("/admin/profile")');
    expect(routeResolves("/admin/profile")).toBe(true);
  });
});

describe("admin Money sections resolve", () => {
  const sections = [
    { section: "payments", label: "Payments", handler: "AdminPaymentsPanel" },
    { section: "promo-codes", label: "Promo codes", handler: "AdminPromoCodesPanel" },
    { section: "finances", label: "Finances", handler: "AdminFinancesPanel" },
  ] as const;

  it.each(sections)("$section is registered, linked, a smoke path and a real route", ({ section, label }) => {
    const path = `/admin/${section}`;
    expect(findSection(adminPortal, section)).toMatchObject({ section, label });
    expect(hrefForSection(adminPortal, section)).toBe(path);
    expect(routeResolves(path)).toBe(true);
    expect(isInAppPath(path)).toBe(true);
    expect(ADMIN_PORTAL_SMOKE_PATHS.some((p) => p.path === path)).toBe(true);
  });

  it.each(sections)("$section is rendered by its own handler, before any legacy rewrite", ({ section, handler }) => {
    const render = read("src/lib/render-portal-section.tsx");
    expect(render).toContain(`kind === "admin" && section === "${section}"`);
    expect(render).toContain(`<${handler}`);
    expect(read("src/lib/render-portal-section/admin.tsx")).toContain(handler);
  });

  it("no next.config redirect shadows /admin/payments, and the legacy finances rewrite skips admin", () => {
    expect(read("next.config.ts")).not.toMatch(/source:\s*"\/admin\/(payments|promo-codes|finances)/);
    expect(read("src/lib/render-portal-section.tsx")).toContain('section === "finances" && kind !== "admin"');
  });

  it("a payment record is one decoded segment under /admin/payments", () => {
    expect(routeResolves("/admin/payments/txn_123")).toBe(true);
    expect(routeResolves("/admin/promo-codes/abc")).toBe(true);
  });

  it("keeps /admin/billing without a route", () => {
    expect(findSection(adminPortal, "billing")).toBeUndefined();
  });
});

describe("admin Health section resolves", () => {
  it("is a registered admin section with a nav row", () => {
    expect(findSection(adminPortal, "health")).toMatchObject({ section: "health", label: "Health" });
    expect(hrefForSection(adminPortal, "health")).toBe("/admin/health");
  });

  it("/admin/health resolves to a real app route and is a smoke path", () => {
    expect(routeResolves("/admin/health")).toBe(true);
    expect(isInAppPath("/admin/health")).toBe(true);
    expect(ADMIN_PORTAL_SMOKE_PATHS.some((p) => p.path === "/admin/health")).toBe(true);
  });

  it("is rendered by a handler, not caught by a redirect", () => {
    const render = read("src/lib/render-portal-section.tsx");
    expect(render).toContain('kind === "admin" && section === "health"');
    expect(render).toContain("<AdminHealthClient />");
    expect(read("src/lib/render-portal-section/admin.tsx")).toContain("AdminHealthClient");
    // next.config redirects() outrank the app router (AGENTS.md routing precedence).
    expect(read("next.config.ts")).not.toMatch(/source:\s*"\/admin\/health/);
  });

  it("an account's rail sections are a second path segment the renderer forwards", () => {
    const render = read("src/lib/render-portal-section.tsx");
    expect(render).toContain("detailSection");
    expect(render).toMatch(/\(tabParts\?\.length \?\? 0\) > 2\) notFound\(\)/);
  });
});

describe("admin Growth section resolves", () => {
  it("is a registered admin section with a nav row and a smoke path", () => {
    expect(findSection(adminPortal, "growth")).toMatchObject({ section: "growth", label: "Growth" });
    expect(hrefForSection(adminPortal, "growth")).toBe("/admin/growth");
    expect(ADMIN_PORTAL_SMOKE_PATHS.some((p) => p.path === "/admin/growth")).toBe(true);
  });

  it("every Growth route resolves to a real app route", () => {
    for (const path of ["/admin/growth", "/admin/growth/calendar", "/admin/growth/engage", "/admin/growth/post/abc", "/admin/growth/accounts", "/admin/growth/analytics"]) {
      expect(routeResolves(path)).toBe(true);
      expect(isInAppPath(path)).toBe(true);
    }
  });

  it("is rendered by a handler wired through the admin panel map", () => {
    expect(read("src/lib/render-portal-section.tsx")).toContain('kind === "admin" && section === "growth"');
    expect(read("src/lib/render-portal-section/admin.tsx")).toContain("GrowthAdminClient");
    expect(read("next.config.ts")).not.toMatch(/source:\s*"\/admin\/growth/);
  });
});

describe("admin Service sections resolve", () => {
  const sections = [
    { section: "service", label: "Workspaces" },
    { section: "proplane-line", label: "PropLane line" },
    { section: "unassigned-leads", label: "Unassigned leads" },
  ] as const;

  it.each(sections)("$section is registered, linked, a smoke path and a real route", ({ section, label }) => {
    const path = `/admin/${section}`;
    expect(findSection(adminPortal, section)).toMatchObject({ section, label });
    expect(hrefForSection(adminPortal, section)).toBe(path);
    expect(routeResolves(path)).toBe(true);
    expect(isInAppPath(path)).toBe(true);
    expect(ADMIN_PORTAL_SMOKE_PATHS.some((p) => p.path === path)).toBe(true);
  });

  it("renders Service and PropLane line through their own handlers, before any legacy rewrite", () => {
    const src = read("src/lib/render-portal-section.tsx");
    expect(src).toMatch(/section === "service"[\s\S]{0,120}<AdminServicePanel \/>/);
    expect(src).toMatch(/section === "proplane-line"[\s\S]{0,120}<AdminProplaneLinePanel \/>/);
  });

  it("no next.config redirect shadows a Service route", () => {
    const cfg = read("next.config.ts");
    expect(cfg).not.toMatch(/source: "\/admin\/(service|proplane-line)/);
  });
});

describe("retired admin sections redirect, they do not 404 (Oct 25)", () => {
  const cfg = read("next.config.ts");

  it("sends /admin/properties and every record under it to the Service row", () => {
    expect(cfg).toContain('{ source: "/admin/properties", destination: "/admin/service", permanent: false }');
    expect(cfg).toContain('{ source: "/admin/properties/:path*", destination: "/admin/service", permanent: false }');
  });

  it("sends /admin/subscribers to Accounts, keeping an old ?tab= bucket as the Plan filter", () => {
    expect(cfg).toMatch(/source: "\/admin\/subscribers",\s*has: \[\{ type: "query", key: "tab", value: "\(\?<plan>paid\|trial\|promo\|free\)" \}\],\s*destination: "\/admin\/axis-users\?category=management&plan=:plan"/);
    expect(cfg).toContain('{ source: "/admin/subscribers", destination: "/admin/axis-users", permanent: false }');
  });

  it("has no panel handler, API route or page left for either", () => {
    const render = read("src/lib/render-portal-section.tsx");
    expect(render).not.toContain(`kind === "admin" && section === "properties"`);
    expect(render).not.toContain(`kind === "admin" && section === "subscribers"`);
    expect(existsSync(join(process.cwd(), "src/app/api/admin/subscribers"))).toBe(false);
    expect(existsSync(join(process.cwd(), "src/components/portal/admin-subscribers-panel.tsx"))).toBe(false);
    expect(existsSync(join(process.cwd(), "src/components/portal/admin-properties-client.tsx"))).toBe(false);
  });
});
