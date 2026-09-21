/**
 * Settings (the `profile` section) is pinned as its own trailing group in the
 * pro/manager, resident, and vendor desktop sidebars — above the fixed
 * "Need help?" link — while admin still reaches it only from the account
 * menu. See `src/lib/portals/nav-groups.ts`'s "settings" group and
 * `portal-sidebar.tsx`'s `firstTrailingGroupIdx`.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { adminPortal } from "@/lib/portals/admin";
import { proPortal } from "@/lib/portals/pro";
import { vendorPortal } from "@/lib/portals/vendor";
import { PORTAL_NAV_GROUPS, groupNavItems } from "@/lib/portals/nav-groups";
import {
  RESIDENT_APPLICATION_PHASE_PORTAL_SECTIONS,
  RESIDENT_APPROVED_PORTAL_SECTIONS,
  RESIDENT_LIMITED_PORTAL_SECTIONS,
} from "@/lib/portals/resident-sections";

const PORTALS_WITH_PINNED_SETTINGS = [
  { kind: "pro" as const, sections: proPortal.sections.map((s) => s.section) },
  { kind: "manager" as const, sections: proPortal.sections.map((s) => s.section) },
  { kind: "vendor" as const, sections: vendorPortal.sections.map((s) => s.section) },
  {
    kind: "resident" as const,
    sections: [
      ...new Set([
        ...RESIDENT_APPLICATION_PHASE_PORTAL_SECTIONS.map((s) => s.section),
        ...RESIDENT_LIMITED_PORTAL_SECTIONS.map((s) => s.section),
        ...RESIDENT_APPROVED_PORTAL_SECTIONS.map((s) => s.section),
      ]),
    ],
  },
];

describe("Settings sits above the sidebar's Need help link", () => {
  for (const { kind, sections } of PORTALS_WITH_PINNED_SETTINGS) {
    it(`${kind}: config lists a trailing "settings" group holding only profile`, () => {
      const groups = PORTAL_NAV_GROUPS[kind];
      const last = groups.at(-1);
      expect(last).toEqual({ id: "settings", label: null, sections: ["profile"] });
    });

    it(`${kind}: profile lands in the last rendered group, once`, () => {
      const items = sections.map((section) => ({ section }));
      const result = groupNavItems(kind, items);
      const last = result.at(-1);
      expect(last?.id).toBe("settings");
      expect(last?.items.map((i) => i.section)).toEqual(["profile"]);
      expect(result.flatMap((g) => g.items).filter((i) => i.section === "profile")).toHaveLength(1);
    });
  }

  it("admin has no pinned Settings row — it stays account-menu only", () => {
    const groups = PORTAL_NAV_GROUPS.admin;
    expect(groups.some((g) => g.id === "settings")).toBe(false);
    const items = adminPortal.sections.map((s) => ({ section: s.section }));
    const result = groupNavItems("admin", items);
    expect(result.flatMap((g) => g.items).map((i) => i.section)).not.toContain("profile");
  });

  it("portal-sidebar.tsx pins the settings group (like account/more) to sit above Need help", () => {
    const sidebarSrc = readFileSync(
      join(process.cwd(), "src/components/portal/portal-sidebar.tsx"),
      "utf8",
    );
    // The trailing-group check that gets the bottom-pinned `mt-auto` treatment
    // must include "settings", or the group renders inline instead of pinned.
    expect(sidebarSrc).toContain('g.id === "account" || g.id === "more" || g.id === "settings"');
    // "Need help?" must still be the last thing in the desktop sidebar,
    // rendered after that expanded nav's groups (including the pinned
    // settings group) close. The file has other, unrelated `<nav>` elements
    // further down (mobile strip, bottom bar), so anchor on the SECOND
    // `aria-label="Portal sections"` nav — collapsed rail is first, the
    // expanded desktop nav (the one Need help sits directly below) is second.
    const firstPortalNavIdx = sidebarSrc.indexOf('aria-label="Portal sections"');
    const secondPortalNavIdx = sidebarSrc.indexOf('aria-label="Portal sections"', firstPortalNavIdx + 1);
    expect(secondPortalNavIdx).toBeGreaterThan(firstPortalNavIdx);
    const desktopNavCloseIdx = sidebarSrc.indexOf("</nav>", secondPortalNavIdx);
    const helpIdx = sidebarSrc.indexOf('href="/support"');
    expect(desktopNavCloseIdx).toBeGreaterThan(-1);
    expect(helpIdx).toBeGreaterThan(desktopNavCloseIdx);
  });

  it("the account menu (top bar) keeps its own Settings link", () => {
    const topBarSrc = readFileSync(
      join(process.cwd(), "src/components/portal/portal-top-bar.tsx"),
      "utf8",
    );
    expect(topBarSrc).toContain("${basePath}/profile");
  });
});
