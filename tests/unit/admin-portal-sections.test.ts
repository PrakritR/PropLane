/**
 * The admin sidebar: Dashboard, Communication · Accounts · Portfolio · Support, and the new Health
 * section wired through the registry, the nav groups, the renderer and the route tree.
 *
 * A section that is in one of these and not the others is a live nav row that lands nowhere (the
 * `/admin/billing` mistake), and nothing about it fails a build - so each hop is pinned.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { routeResolves } from "../helpers/route-resolves";
import { findSection } from "@/lib/portals";
import { ADMIN_PORTAL_SMOKE_PATHS, adminPortal } from "@/lib/portals/admin";
import { PORTAL_NAV_GROUPS, groupNavItems } from "@/lib/portals/nav-groups";
import { hrefForSection } from "@/components/portal/portal-nav-model";
import { isInAppPath } from "@/lib/platform/parity";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

describe("admin nav groups", () => {
  const groups = PORTAL_NAV_GROUPS.admin;
  const grouped = groups.flatMap((g) => g.sections);

  it("heads the sidebar: unheaded Dashboard + Communication, then Accounts, Portfolio, Support", () => {
    expect(groups.map((g) => [g.label, g.sections] as const)).toEqual([
      [null, ["dashboard", "communication"]],
      ["Accounts", ["axis-users", "test-accounts"]],
      ["Portfolio", ["properties"]],
      ["Support", ["bugs-feedback", "events", "health"]],
      ["Marketing", ["growth"]],
    ]);
  });

  it("places every admin section exactly once (Settings is reached from the account menu, not a row)", () => {
    expect(new Set(grouped).size).toBe(grouped.length);
    const registry = adminPortal.sections.map((s) => s.section).filter((s) => s !== "profile");
    expect([...grouped].sort()).toEqual([...registry].sort());
  });

  it("keeps the registry in sidebar order so the native bar and the web nav agree", () => {
    const registry = adminPortal.sections.map((s) => s.section).filter((s) => s !== "profile");
    expect(registry).toEqual(grouped);
  });

  it("groups real nav items into the same five buckets", () => {
    const items = adminPortal.sections.map((s) => ({ section: s.section }));
    expect(groupNavItems("admin", items).map((g) => g.id)).toEqual(["home", "accounts", "portfolio", "support", "marketing"]);
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
    for (const path of ["/admin/growth", "/admin/growth/calendar", "/admin/growth/post/abc", "/admin/growth/accounts", "/admin/growth/analytics"]) {
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
