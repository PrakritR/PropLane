/**
 * `/portal/settings/<tab>` now folds into Main Settings. Redirects in
 * next.config.ts plus render-portal-section keep old bookmarks working.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { routeResolves } from "../helpers/route-resolves";
import {
  DEFAULT_MANAGER_SETTINGS_TAB,
  MANAGER_PORTAL_SETTINGS_TABS,
  managerSettingsHubTab,
  parseManagerSettingsAreaTab,
} from "@/lib/portal-settings-section";

function sourceMatches(source: string, pathname: string): boolean {
  if (source.endsWith("/:path*")) {
    const prefix = source.slice(0, -"/:path*".length);
    return pathname === prefix || pathname.startsWith(`${prefix}/`);
  }
  if (source.endsWith("/:path+")) {
    const prefix = source.slice(0, -"/:path+".length);
    return pathname !== prefix && pathname.startsWith(`${prefix}/`);
  }
  if (source.endsWith("/:tab")) {
    const prefix = source.slice(0, -"/:tab".length);
    if (pathname === prefix || !pathname.startsWith(`${prefix}/`)) return false;
    return pathname.slice(prefix.length + 1).split("/").length === 1;
  }
  return source === pathname;
}

function readRedirectSources(): string[] {
  const src = readFileSync(resolve(__dirname, "../../next.config.ts"), "utf8");
  const start = src.indexOf("async redirects()");
  if (start === -1) throw new Error("next.config.ts no longer has a redirects() function — update this test.");
  const tail = src.slice(start);
  return [...tail.matchAll(/source:\s*"([^"]+)"/g)].map((m) => m[1]!);
}

describe("next.config.ts folds /portal/settings into the hub", () => {
  const sources = readRedirectSources();

  it("found at least the redirects() block's other entries", () => {
    expect(sources.length).toBeGreaterThan(10);
  });

  it("redirects /portal/settings and /portal/settings/:tab into Main Settings", () => {
    expect(sources).toContain("/portal/settings");
    expect(sources).toContain("/portal/settings/:tab");
    expect(sources).toContain("/portal/settings/automation");
    expect(sources).toContain("/portal/settings/communication");
    expect(sourceMatches("/portal/settings/:tab", "/portal/settings/tours")).toBe(true);
    expect(sourceMatches("/portal/settings", "/portal/settings")).toBe(true);
  });

  it("leaves the sibling /resident/settings and /admin/settings redirects alone", () => {
    expect(sources).toContain("/resident/settings");
    expect(sources).toContain("/resident/settings/:path*");
    expect(sources).toContain("/admin/settings");
    expect(sources).toContain("/admin/settings/:path*");
  });
});

describe("parseManagerSettingsAreaTab", () => {
  it.each(MANAGER_PORTAL_SETTINGS_TABS)("resolves its own url segment ($id) back to itself", ({ id }) => {
    expect(parseManagerSettingsAreaTab(id)).toBe(id);
  });

  it("maps leases, reminders, and residents aliases", () => {
    expect(parseManagerSettingsAreaTab("leases")).toBe("lease");
    expect(parseManagerSettingsAreaTab("reminders")).toBe("automation");
    expect(parseManagerSettingsAreaTab("residents")).toBe("resident");
  });

  it("returns null for an area this registry does not recognize", () => {
    expect(parseManagerSettingsAreaTab("not-a-real-module")).toBeNull();
    expect(parseManagerSettingsAreaTab("")).toBeNull();
    expect(parseManagerSettingsAreaTab(undefined)).toBeNull();
    expect(parseManagerSettingsAreaTab(null)).toBeNull();
  });

  it("the default bare-/portal/settings target is itself a real module", () => {
    expect(parseManagerSettingsAreaTab(DEFAULT_MANAGER_SETTINGS_TAB)).toBe(DEFAULT_MANAGER_SETTINGS_TAB);
  });
});

describe("managerSettingsHubTab", () => {
  it("folds communication into messaging and automation into reminders", () => {
    expect(managerSettingsHubTab("communication")).toBe("messaging");
    expect(managerSettingsHubTab("automation")).toBe("reminders");
    expect(managerSettingsHubTab("properties")).toBe("properties");
    expect(managerSettingsHubTab(null)).toBe("properties");
  });
});

describe("the settings section route still resolves against src/app", () => {
  it("resolves this test's own fixtures, so a false pass is not possible", () => {
    expect(routeResolves("/auth/sign-in")).toBe(true);
    expect(routeResolves("/auth/definitely-not-a-real-page-xyz")).toBe(false);
  });

  it("resolves /portal/settings and every /portal/settings/<tab>", () => {
    expect(routeResolves("/portal/settings")).toBe(true);
    for (const { id } of MANAGER_PORTAL_SETTINGS_TABS) {
      expect(routeResolves(`/portal/settings/${id}`)).toBe(true);
    }
  });
});
