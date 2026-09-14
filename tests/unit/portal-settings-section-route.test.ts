/**
 * `/portal/settings/<tab>` used to be unreachable: `next.config.ts` carried an unconditional
 * `/portal/settings/:path*` redirect to `/portal/profile`, and `redirects()` outranks the app
 * router, so the section 307'd away before `render-portal-section.tsx` ever ran (AGENTS.md: "grep
 * before adding a section; delete the redirect when you delete the section"). This suite is that
 * regression guard, plus coverage for the pure area→tab resolver the section route and the modal's
 * own "Open in Settings" link both key off.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { routeResolves } from "../helpers/route-resolves";
import {
  DEFAULT_MANAGER_SETTINGS_TAB,
  MANAGER_PORTAL_SETTINGS_TABS,
  parseManagerSettingsAreaTab,
} from "@/lib/portal-settings-section";

/**
 * A tiny stand-in for Next's own `path-to-regexp`-based redirect matcher, covering exactly the
 * two `source` shapes this file uses (`/foo`, `/foo/:path*`) — the same two forms every other
 * redirect in `next.config.ts` already uses. Good enough to prove a given source WOULD or would
 * NOT intercept a given pathname; it does not need to be a general router.
 */
function sourceMatches(source: string, pathname: string): boolean {
  if (source.endsWith("/:path*")) {
    const prefix = source.slice(0, -"/:path*".length);
    return pathname === prefix || pathname.startsWith(`${prefix}/`);
  }
  if (source.endsWith("/:path+")) {
    const prefix = source.slice(0, -"/:path+".length);
    return pathname !== prefix && pathname.startsWith(`${prefix}/`);
  }
  return source === pathname;
}

/** Every `source: "…"` string literal inside next.config.ts's `redirects()` block. */
function readRedirectSources(): string[] {
  const src = readFileSync(resolve(__dirname, "../../next.config.ts"), "utf8");
  const start = src.indexOf("async redirects()");
  if (start === -1) throw new Error("next.config.ts no longer has a redirects() function — update this test.");
  const tail = src.slice(start);
  return [...tail.matchAll(/source:\s*"([^"]+)"/g)].map((m) => m[1]!);
}

describe("next.config.ts must never swallow /portal/settings again", () => {
  const sources = readRedirectSources();

  it("found at least the redirects() block's other entries (sanity — a false pass is not possible)", () => {
    // If this is empty the regex/slice above broke, and every assertion below would vacuously pass.
    expect(sources.length).toBeGreaterThan(10);
  });

  it("no redirect source would intercept /portal/settings or /portal/settings/tours", () => {
    const targets = ["/portal/settings", "/portal/settings/tours", "/portal/settings/automation"];
    for (const source of sources) {
      for (const target of targets) {
        expect(sourceMatches(source, target), `"${source}" must not match "${target}"`).toBe(false);
      }
    }
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

/**
 * Same pattern and same helper as `tests/unit/claw-resident-links.test.ts`'s own route-existence
 * suite: the app router resolves `/portal/settings/<anything>` through the existing
 * `portal/[section]/[[...tab]]/page.tsx` catch-all, same as every other `/portal/*` section — real
 * coverage that the segment shape itself is a live route, on top of (not instead of) the
 * redirect-config guard above, which is the part that actually broke this before.
 *
 * `/portal/[section]/[[...tab]]` is itself a catch-all, so it is not a useful place to prove the
 * shared `routeResolves` helper can say "false" — reuse the app's own `/auth` fixtures for that,
 * exactly as `claw-resident-links.test.ts` does.
 */
describe("the settings section route resolves against src/app", () => {
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
