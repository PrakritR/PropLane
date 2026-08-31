import { describe, expect, it } from "vitest";
import { adminPortal } from "@/lib/portals/admin";
import { proPortal } from "@/lib/portals/pro";
import { vendorPortal } from "@/lib/portals/vendor";
import {
  PORTAL_NAV_GROUPS,
  SIDEBAR_EXCLUDED_SECTIONS,
  groupNavItems,
} from "@/lib/portals/nav-groups";
import {
  RESIDENT_APPLICATION_PHASE_PORTAL_SECTIONS,
  RESIDENT_APPROVED_PORTAL_SECTIONS,
  RESIDENT_LIMITED_PORTAL_SECTIONS,
} from "@/lib/portals/resident-sections";

const CASES = [
  // Settings (profile) lives in the account menu, not the desktop sidebar.
  // Admin exposes Feedback as its own sidebar item under Operations.
  {
    kind: "pro" as const,
    sections: proPortal.sections.map((s) => s.section),
    sidebarShowsProfile: false,
    sidebarShowsFeedback: false,
  },
  {
    kind: "admin" as const,
    sections: adminPortal.sections.map((s) => s.section),
    sidebarShowsProfile: false,
    sidebarShowsFeedback: true,
  },
  {
    kind: "resident" as const,
    sections: [
      ...new Set([
        ...RESIDENT_APPLICATION_PHASE_PORTAL_SECTIONS.map((s) => s.section),
        ...RESIDENT_LIMITED_PORTAL_SECTIONS.map((s) => s.section),
        ...RESIDENT_APPROVED_PORTAL_SECTIONS.map((s) => s.section),
      ]),
    ],
    sidebarShowsProfile: false,
    sidebarShowsFeedback: false,
  },
  {
    kind: "vendor" as const,
    sections: vendorPortal.sections.map((s) => s.section),
    sidebarShowsProfile: false,
    sidebarShowsFeedback: false,
  },
];

describe("portal nav groups cover the registry exactly", () => {
  for (const { kind, sections, sidebarShowsProfile, sidebarShowsFeedback } of CASES) {
    const groups = PORTAL_NAV_GROUPS[kind];
    const grouped = groups.flatMap((g) => g.sections);

    it(`${kind}: every registry section (except excluded) maps to exactly one group`, () => {
      const expected = sections
        .filter((s) => {
          if (s === "profile") return sidebarShowsProfile;
          if (s === "bugs-feedback") return sidebarShowsFeedback;
          return !SIDEBAR_EXCLUDED_SECTIONS.has(s);
        })
        .sort();
      expect([...grouped].sort()).toEqual(expected);
    });

    it(`${kind}: no section appears in two groups`, () => {
      expect(grouped.length).toBe(new Set(grouped).size);
    });

    it(`${kind}: group config references no unknown section ids`, () => {
      const known = new Set(sections);
      for (const id of grouped) expect(known.has(id)).toBe(true);
    });

    it(`${kind}: profile ${sidebarShowsProfile ? "surfaces at the bottom of" : "is excluded from"} the sidebar`, () => {
      if (sidebarShowsProfile) {
        expect(grouped).toContain("profile");
        expect(grouped.at(-1)).toBe("profile");
      } else {
        expect(grouped).not.toContain("profile");
      }
    });

    it(`${kind}: bugs-feedback ${sidebarShowsFeedback ? "surfaces in" : "is excluded from"} the sidebar`, () => {
      if (sidebarShowsFeedback) {
        expect(grouped).toContain("bugs-feedback");
      } else {
        expect(grouped).not.toContain("bugs-feedback");
      }
    });
  }
});

describe("groupNavItems", () => {
  it("buckets items in config order and drops empty groups", () => {
    const items = proPortal.sections
      .filter((s) => s.section !== "profile")
      .map((s) => ({ section: s.section }));
    const result = groupNavItems("pro", items);

    // "home" is the ungrouped head of the sidebar; it carries the dashboard and
    // the "app" section that was added alongside it. Asserted in full because
    // this case is specifically about bucketing in config order.
    expect(result[0]).toEqual({ id: "home", label: null, items: [{ section: "dashboard" }, { section: "app" }] });
    const leasing = result.find((g) => g.id === "leasing");
    expect(leasing?.label).toBe("Leasing");
    expect(leasing?.items.map((i) => i.section)).toEqual(["properties", "tours", "applications", "leases"]);
    const operations = result.find((g) => g.id === "operations");
    expect(operations?.items.map((i) => i.section)).toEqual(["tasks", "calendar", "bookings", "communication"]);
    const tenancy = result.find((g) => g.id === "tenancy");
    expect(tenancy?.items.map((i) => i.section)).toEqual(["residents", "payments", "services"]);
    const finances = result.find((g) => g.id === "finances");
    expect(finances?.items.map((i) => i.section)).toEqual(["financials", "documents"]);
    // profile was filtered out of `items` above (pro's sidebar otherwise surfaces it)
    expect(result.flatMap((g) => g.items).map((i) => i.section)).not.toContain("profile");
  });

  it("sends unknown sections to a trailing unlabeled group instead of dropping them", () => {
    const result = groupNavItems("pro", [{ section: "dashboard" }, { section: "mystery" }]);
    const last = result.at(-1);
    expect(last?.items.some((i) => i.section === "mystery")).toBe(true);
  });

  it("shows all resident sections in sidebar groups (locks are stage-based)", () => {
    const items = [
      { section: "tour", label: "Tour", href: "/resident/tour" },
      { section: "applications", label: "Application", href: "/resident/applications" },
      { section: "dashboard", label: "Dashboard", href: "/resident/dashboard" },
      { section: "lease", label: "Lease", href: "/resident/lease" },
      { section: "communication", label: "Communication", href: "/resident/communication/inbox/unopened" },
      { section: "profile", label: "Settings", href: "/resident/profile" },
    ];
    const result = groupNavItems("resident", items);
    expect(result.map((g) => g.id)).toEqual(["home", "my-home", "messages"]);
    expect(result[0]?.items.map((i) => i.section)).toEqual(["dashboard", "tour", "applications"]);
    expect(result.flatMap((g) => g.items).map((i) => i.section)).not.toContain("profile");
  });
});
