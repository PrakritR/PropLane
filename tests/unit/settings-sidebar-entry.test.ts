/**
 * Settings (the `profile` section) has no row in ANY desktop sidebar — pro/
 * manager, resident, vendor, and admin all reach it only from the top-right
 * account menu (and, on a phone, the profile menu). See
 * `src/lib/portals/nav-groups.ts`'s `SIDEBAR_EXCLUDED_SECTIONS`.
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

const ALL_PORTALS = [
  { kind: "pro" as const, sections: proPortal.sections.map((s) => s.section) },
  { kind: "manager" as const, sections: proPortal.sections.map((s) => s.section) },
  { kind: "vendor" as const, sections: vendorPortal.sections.map((s) => s.section) },
  { kind: "admin" as const, sections: adminPortal.sections.map((s) => s.section) },
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

describe("Settings has no sidebar entry anywhere — account menu only", () => {
  for (const { kind, sections } of ALL_PORTALS) {
    it(`${kind}: no group config assigns profile`, () => {
      const groups = PORTAL_NAV_GROUPS[kind];
      expect(groups.some((g) => g.id === "settings")).toBe(false);
      expect(groups.flatMap((g) => g.sections)).not.toContain("profile");
    });

    it(`${kind}: profile never appears in a rendered sidebar group`, () => {
      const items = sections.map((section) => ({ section }));
      const result = groupNavItems(kind, items);
      expect(result.flatMap((g) => g.items).map((i) => i.section)).not.toContain("profile");
    });
  }

  it("the account menu (top bar) keeps its own Settings link", () => {
    const topBarSrc = readFileSync(
      join(process.cwd(), "src/components/portal/portal-top-bar.tsx"),
      "utf8",
    );
    expect(topBarSrc).toContain("${basePath}/profile");
    expect(topBarSrc).toContain("portal-top-bar-settings");
    expect(topBarSrc).toContain("router.push(`${basePath}/profile`)");
  });

  it("mobile avatar menu pushes Settings in-app (not Link-asChild)", () => {
    const mobileSrc = readFileSync(
      join(process.cwd(), "src/components/portal/portal-mobile-nav-bar.tsx"),
      "utf8",
    );
    expect(mobileSrc).toContain("portal-mobile-profile-settings");
    expect(mobileSrc).toContain("router.push(`${definition.basePath}/profile`)");
    expect(mobileSrc).not.toMatch(/DropdownMenuItem asChild[\s\S]{0,120}portal-mobile-profile-settings/);
  });

  it("More sheet can list Settings (profile is not hidden from mobile nav)", () => {
    const navGroups = readFileSync(join(process.cwd(), "src/lib/portals/nav-groups.ts"), "utf8");
    expect(navGroups).not.toMatch(/if \(section === "profile"\) return true;/);
    const moreSheet = readFileSync(
      join(process.cwd(), "src/components/portal/portal-native-more-sheet.tsx"),
      "utf8",
    );
    expect(moreSheet).not.toContain('&& i.section !== "profile"');
  });
});
