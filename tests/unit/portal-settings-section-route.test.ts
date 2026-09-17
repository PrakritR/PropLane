/**
 * `/portal/settings/<tab>` is a live settings page. Hub bookmarks that used
 * `?tab=properties` land on Applications.
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

function readRedirectSources(): string[] {
  const src = readFileSync(resolve(__dirname, "../../next.config.ts"), "utf8");
  const start = src.indexOf("async redirects()");
  if (start === -1) throw new Error("next.config.ts no longer has a redirects() function — update this test.");
  const tail = src.slice(start);
  return [...tail.matchAll(/source:\s*"([^"]+)"/g)].map((m) => m[1]!);
}

describe("next.config.ts does not fold /portal/settings into the hub", () => {
  const sources = readRedirectSources();

  it("found at least the redirects() block's other entries", () => {
    expect(sources.length).toBeGreaterThan(10);
  });

  it("leaves /portal/settings as a live page instead of redirecting into Main Settings", () => {
    expect(sources).not.toContain("/portal/settings");
    expect(sources).not.toContain("/portal/settings/:tab");
    expect(sources).not.toContain("/portal/settings/automation");
    expect(sources).not.toContain("/portal/settings/communication");
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

  it("maps leases, reminders, residents, and retired properties aliases", () => {
    expect(parseManagerSettingsAreaTab("leases")).toBe("lease");
    expect(parseManagerSettingsAreaTab("reminders")).toBe("automation");
    expect(parseManagerSettingsAreaTab("residents")).toBe("resident");
    expect(parseManagerSettingsAreaTab("properties")).toBe("applications");
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
    expect(managerSettingsHubTab("properties")).toBe("applications");
    expect(managerSettingsHubTab(null)).toBe("applications");
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
