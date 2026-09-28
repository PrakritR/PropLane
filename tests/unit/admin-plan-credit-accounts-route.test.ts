/**
 * The global Plan credit table (S27) landed pointed at `/admin/billing`, but
 * `"billing"` was never registered in `adminPortal.sections`
 * (`src/lib/portals/admin.ts`) — `render-portal-section.tsx`'s `findSection`
 * lookup 404s an incoming `/admin/billing` request before any branch for it
 * could run, so the feature was landed but unreachable. The fix mounts it on
 * the real Accounts section (`axis-users`) instead of resurrecting a separate
 * `/admin/billing` route.
 *
 * This is the same "a path the app actually resolves" contract
 * `tests/unit/claw-resident-links.test.ts` enforces for the resident/manager
 * link builders (`tests/helpers/route-resolves.ts`), applied to the admin
 * section registry and its render handlers.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { routeResolves } from "../helpers/route-resolves";
import { findSection, getPortalDefinition } from "@/lib/portals";
import { adminPortal, ADMIN_PORTAL_SMOKE_PATHS } from "@/lib/portals/admin";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

describe("admin Accounts (axis-users) resolves against the registered admin sections", () => {
  it("axis-users is a registered admin section", () => {
    expect(findSection(adminPortal, "axis-users")).toBeTruthy();
  });

  it("/admin/axis-users resolves to a real app route", () => {
    expect(routeResolves("/admin/axis-users")).toBe(true);
  });

  it("getPortalDefinition(\"admin\") also exposes axis-users", async () => {
    const def = await getPortalDefinition("admin");
    expect(findSection(def, "axis-users")).toBeTruthy();
  });

  it("render-portal-section.tsx has a real handler for axis-users", () => {
    const src = read("src/lib/render-portal-section.tsx");
    expect(src).toContain('section === "axis-users"');
    expect(src).toContain("<AdminAxisUsersClient");
  });
});

describe("billing is not a registered admin section, and /admin/billing has no live destination", () => {
  it("\"billing\" is absent from adminPortal.sections", () => {
    expect(findSection(adminPortal, "billing")).toBeUndefined();
  });

  it("admin.ts has no billing nav row", () => {
    const src = read("src/lib/portals/admin.ts");
    expect(src).not.toMatch(/section:\s*"billing"/);
  });

  it("the admin smoke-test path list no longer claims /admin/billing works", () => {
    expect(ADMIN_PORTAL_SMOKE_PATHS.some((p) => p.path === "/admin/billing")).toBe(false);
  });

  it("render-portal-section.tsx no longer imports or renders AdminBillingClient", () => {
    const src = read("src/lib/render-portal-section.tsx");
    expect(src).not.toMatch(/import\s*\{\s*AdminBillingClient\s*\}/);
    expect(src).not.toContain("<AdminBillingClient");
  });

  it("render-portal-section.tsx no longer branches on the dead admin billing section", () => {
    const src = read("src/lib/render-portal-section.tsx");
    expect(src).not.toMatch(/kind === "admin" && section === "billing"/);
  });
});

describe("no admin surface points a link at /admin/billing", () => {
  const NAVIGATION_CALL_TARGETS_BILLING = /(?:navigate|router\.push|router\.replace|redirect|href)\(?\s*["'`]\/admin\/billing["'`]/;

  it.each([
    "src/components/portal/admin-axis-users-client.tsx",
    "src/components/portal/admin-billing-client.tsx",
    "src/lib/portals/admin.ts",
    "src/lib/render-portal-section.tsx",
  ])("%s has no navigation call targeting /admin/billing", (path) => {
    const src = read(path);
    expect(src).not.toMatch(NAVIGATION_CALL_TARGETS_BILLING);
  });
});
