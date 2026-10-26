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
  RESIDENT_UNIFIED_PORTAL_SECTIONS,
} from "@/lib/portals/resident-sections";

const CASES = [
  // Settings (profile) has no sidebar row anywhere — every portal reaches it
  // only from the account menu. Admin reaches Feedback through the Support
  // row's tab strip; manager/resident/vendor feedback stays embedded
  // inside Settings.
  {
    kind: "pro" as const,
    sections: proPortal.sections.map((s) => s.section),
    sidebarShowsProfile: false,
    sidebarShowsFeedback: false,
  },
  {
    kind: "admin" as const,
    sections: adminPortal.sections.map((s) => s.section),
    sidebarShowsProfile: true,
    sidebarShowsFeedback: true,
  },
  {
    kind: "resident" as const,
    sections: [
      ...new Set([
        ...RESIDENT_APPLICATION_PHASE_PORTAL_SECTIONS.map((s) => s.section),
        ...RESIDENT_LIMITED_PORTAL_SECTIONS.map((s) => s.section),
        ...RESIDENT_APPROVED_PORTAL_SECTIONS.map((s) => s.section),
        // Stays exists only in the unified catalog (drawn for an account that owns a stay row).
        ...RESIDENT_UNIFIED_PORTAL_SECTIONS.map((s) => s.section),
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
  it("registers incoming and outgoing as separate sidebar destinations", () => {
    const payments = proPortal.sections.find((section) => section.section === "payments");
    expect(payments).toMatchObject({ label: "Incoming payments", tabs: [] });
    expect(proPortal.sections.find((section) => section.section === "outgoing")).toMatchObject({ label: "Outgoing payments", tabs: [] });
  });

  for (const { kind, sections, sidebarShowsProfile, sidebarShowsFeedback } of CASES) {
    const groups = PORTAL_NAV_GROUPS[kind];
    // Admin's config lists every section, including the ones its sidebar folds
    // into a tab group's row (Money = Payments · Promo codes · Finances), so an
    // unfolded caller (the command palette) buckets them too.
    const grouped = groups.flatMap((g) => g.sections);

    it(`${kind}: every registry section (except excluded) maps to exactly one group`, () => {
      const expected = sections
        .filter((s) => {
          if (s === "profile") return sidebarShowsProfile;
          if (s === "bugs-feedback") return sidebarShowsFeedback;
          // Manager Teams moved into Settings (Workspaces / Team / Vendors).
          if ((kind === "pro" || kind === "manager") && s === "teams") return false;
          // Manager Move-in is registered but has no row: Forms replaced it in the sidebar.
          if ((kind === "pro" || kind === "manager") && s === "move-in") return false;
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

    it(`${kind}: profile ${sidebarShowsProfile ? "is the first row of" : "is excluded from"} the sidebar`, () => {
      if (sidebarShowsProfile) {
        expect(grouped).toContain("profile");
        expect(grouped[0]).toBe("profile");
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

    // The unheaded home group opens the sidebar, then Portfolio / Leasing /
    // People / Operations / Money (captain #28). "app" (the download page) is excluded from every nav:
    // it stays routable, it is just not a row. Asserted in full because this
    // case is specifically about bucketing in config order.
    expect(result.map((g) => g.id)).toEqual(["home", "portfolio", "leasing", "people", "operations", "money"]);
    expect(result[0]).toEqual({
      id: "home",
      label: null,
      items: [{ section: "dashboard" }, { section: "tasks" }, { section: "calendar" }, { section: "communication" }],
    });
    expect(result.flatMap((g) => g.items).map((i) => i.section)).not.toContain("app");
    const sectionsOf = (id: string) => result.find((g) => g.id === id)?.items.map((i) => i.section);
    expect(result.find((g) => g.id === "portfolio")?.label).toBe("Portfolio");
    expect(sectionsOf("portfolio")).toEqual(["properties", "bookings", "promotion"]);
    expect(result.find((g) => g.id === "leasing")?.label).toBe("Leasing");
    expect(sectionsOf("leasing")).toEqual(["tours", "applications", "leases", "forms"]);
    expect(result.find((g) => g.id === "people")?.label).toBe("People");
    expect(sectionsOf("people")).toEqual(["residents", "vendors"]);
    expect(result.find((g) => g.id === "operations")?.label).toBe("Operations");
    expect(sectionsOf("operations")).toEqual(["services", "documents"]);
    expect(result.find((g) => g.id === "money")?.label).toBe("Money");
    expect(sectionsOf("money")).toEqual(["payments", "outgoing", "financials"]);
    // profile was filtered out of `items` above (pro's sidebar otherwise surfaces it)
    expect(result.flatMap((g) => g.items).map((i) => i.section)).not.toContain("profile");
  });

  it("sends unknown sections to a trailing unlabeled group instead of dropping them", () => {
    const result = groupNavItems("pro", [{ section: "dashboard" }, { section: "mystery" }]);
    const last = result.at(-1);
    expect(last?.items.some((i) => i.section === "mystery")).toBe(true);
  });

  it("shows all resident sections in sidebar groups, with Settings excluded (locks are stage-based)", () => {
    const items = [
      { section: "tour", label: "Tour", href: "/resident/tour" },
      { section: "applications", label: "Application", href: "/resident/applications" },
      { section: "dashboard", label: "Dashboard", href: "/resident/dashboard" },
      { section: "lease", label: "Lease", href: "/resident/lease" },
      { section: "communication", label: "Communication", href: "/resident/communication/inbox/unopened" },
      { section: "profile", label: "Settings", href: "/resident/profile" },
    ];
    const result = groupNavItems("resident", items);
    expect(result.map((g) => g.id)).toEqual(["home", "applying", "lease"]);
    expect(result[0]?.items.map((i) => i.section)).toEqual(["dashboard", "communication"]);
    expect(result[1]?.items.map((i) => i.section)).toEqual(["tour", "applications"]);
    expect(result[2]?.items.map((i) => i.section)).toEqual(["lease"]);
    expect(result.flatMap((g) => g.items).map((i) => i.section)).not.toContain("profile");
  });
});

describe("phase 1 regroup: headings and exact order per portal", () => {
  const headings = (kind: "manager" | "resident" | "vendor") =>
    PORTAL_NAV_GROUPS[kind].map((g) => [g.label, g.sections] as const);

  // Captain #28 ("Services doesn't belong in People, Documents doesn't belong in Money"): display grouping only.
  it("property: home, Portfolio, Leasing, People, Operations, Money", () => {
    expect(headings("manager")).toEqual([
      [null, ["dashboard", "tasks", "calendar", "communication"]],
      ["Portfolio", ["properties", "bookings", "promotion"]],
      ["Leasing", ["tours", "applications", "leases", "forms"]],
      ["People", ["residents", "vendors"]],
      ["Operations", ["services", "documents"]],
      ["Money", ["payments", "outgoing", "financials"]],
    ]);
  });

  it("resident: home, Applying, Home, Paperwork, Money", () => {
    expect(headings("resident")).toEqual([
      [null, ["dashboard", "stays", "communication"]],
      ["Applying", ["tour", "applications"]],
      ["Home", ["move-in", "services"]],
      ["Paperwork", ["lease", "forms", "documents"]],
      ["Money", ["payments"]],
    ]);
  });

  it("vendor: home, Work, Money, Business", () => {
    expect(headings("vendor")).toEqual([
      [null, ["dashboard", "communication", "calendar"]],
      ["Work", ["work-orders", "tasks"]],
      ["Money", ["payments", "outgoing", "financials"]],
      ["Business", ["reviews", "documents"]],
    ]);
  });

  it("every manager sidebar row (all but excluded) lands in exactly one group via groupNavItems", () => {
    const items = proPortal.sections.map((s) => ({ section: s.section }));
    const placed = groupNavItems("manager", items).flatMap((g) => g.items.map((i) => i.section));
    const expected = proPortal.sections
      .map((s) => s.section)
      .filter((s) => !SIDEBAR_EXCLUDED_SECTIONS.has(s) && s !== "move-in" && s !== "teams");
    expect([...placed].sort()).toEqual([...new Set(expected)].sort());
    expect(placed.length).toBe(new Set(placed).size);
  });
});
