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

  it("heads the sidebar: unheaded Dashboard + Communication, then Accounts, Money, Portfolio, Support", () => {
    expect(groups.map((g) => [g.label, g.sections] as const)).toEqual([
      [null, ["dashboard", "communication"]],
      ["Accounts", ["axis-users", "subscribers", "test-accounts"]],
      ["Money", ["payments", "promo-codes", "finances"]],
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

  it("groups real nav items into the same six buckets", () => {
    const items = adminPortal.sections.map((s) => ({ section: s.section }));
    expect(groupNavItems("admin", items).map((g) => g.id)).toEqual([
      "home",
      "accounts",
      "money",
      "portfolio",
      "support",
      "marketing",
    ]);
  });
});

describe("admin Money and Subscribers sections resolve", () => {
  const sections = [
    { section: "subscribers", label: "Subscribers", handler: "AdminSubscribersPanel" },
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
    expect(read("next.config.ts")).not.toMatch(/source:\s*"\/admin\/(payments|subscribers|promo-codes|finances)/);
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
