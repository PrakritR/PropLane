// @vitest-environment jsdom
/**
 * Portal sweep 1012, round 1 (reshaped Oct 25): admin's sidebar is eight rows, and the grouped rows
 * (Money, Service, Support) show their sections as a Properties-style tab strip. Accounts is a row of its own whose
 * Managers / Residents / Vendors / Test tabs live inside its page.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { adminPortal, adminPortalForTestWorkspaceOperator } from "@/lib/portals/admin";
import {
  ADMIN_SECTION_TABS,
  adminNavRowSection,
  adminSectionTabsFor,
  adminTabGroupIdFor,
  collapseAdminNavItems,
  mergeAdminGroupCounts,
} from "@/lib/portals/nav-groups";
import { buildPortalNavItems, hrefForSection } from "@/components/portal/portal-nav-model";

const state = vi.hoisted(() => ({
  pathname: "/admin/axis-users",
  counts: {} as Record<string, { count: number; tone: "muted" | "alert" }>,
}));

vi.mock("next/navigation", () => ({
  usePathname: () => state.pathname,
  useRouter: () => ({ push: vi.fn(), prefetch: vi.fn() }),
}));
vi.mock("@/hooks/use-portal-nav-counts", () => ({ usePortalNavCounts: () => state.counts }));

import { AdminSectionTabs } from "@/components/portal/admin-section-tabs";

afterEach(() => {
  cleanup();
  state.counts = {};
});

const operator = adminPortalForTestWorkspaceOperator(true);
const nonOperator = adminPortalForTestWorkspaceOperator(false);

function rowsFor(definition: typeof adminPortal) {
  return collapseAdminNavItems(buildPortalNavItems(definition, definition.sections, false, undefined));
}

/** The sidebar drops Test accounts (`SIDEBAR_EXCLUDED_SECTIONS`): it is the operator's inner tab of Accounts. */
function sidebarRowsFor(definition: typeof adminPortal) {
  return rowsFor(definition).filter((r) => r.section !== "test-accounts");
}

describe("admin sidebar rows", () => {
  it("lists eight rows for the operator, Settings first, in order, with no section reachable twice", () => {
    const rows = sidebarRowsFor(operator);
    expect(rows.map((r) => r.label)).toEqual([
      "Settings",
      "Dashboard",
      "Communication",
      "Accounts",
      "Money",
      "Service",
      "Support",
      "Growth",
    ]);
    const reach = [...rows.flatMap((r) => r.groupSections ?? [r.section]), "test-accounts"];
    expect(new Set(reach).size).toBe(reach.length);
    expect([...reach].sort()).toEqual(
      operator.sections.map((s) => s.section).sort(),
    );
  });

  it("links a grouped row to its first visible tab", () => {
    const rows = rowsFor(operator);
    const hrefOf = (label: string) => rows.find((r) => r.label === label)?.href;
    expect(hrefOf("Accounts")).toBe("/admin/axis-users");
    expect(hrefOf("Service")).toBe("/admin/service");
    expect(hrefOf("Money")).toBe("/admin/payments");
    expect(hrefOf("Support")).toBe("/admin/bugs-feedback");
  });

  it("is idempotent: folding an already folded list changes nothing", () => {
    const once = rowsFor(operator);
    expect(collapseAdminNavItems(once)).toEqual(once);
  });

  it.each([
    ["axis-users", "axis-users"],
    ["unassigned-leads", "service"],
    ["service", "service"],
    ["proplane-line", "service"],
    ["test-accounts", "test-accounts"],
    ["payments", "payments"],
    ["promo-codes", "payments"],
    ["finances", "payments"],
    ["managed-finance", "payments"],
    ["bugs-feedback", "bugs-feedback"],
    ["events", "bugs-feedback"],
    ["health", "bugs-feedback"],
    ["dashboard", "dashboard"],
    ["communication", "communication"],
    ["growth", "growth"],
  ])("%s is active on the %s row", (section, row) => {
    expect(adminNavRowSection(section)).toBe(row);
  });

  it("maps /admin/promo-codes to the Money row", () => {
    const rows = rowsFor(operator);
    const active = rows.find((r) => r.groupSections?.includes("promo-codes") || r.section === "promo-codes");
    expect(active?.label).toBe("Money");
  });

  it("Accounts is a single row with no outer strip; Test accounts is operator-only and never a row", () => {
    expect(sidebarRowsFor(operator).find((r) => r.label === "Accounts")?.groupSections).toBeUndefined();
    expect(sidebarRowsFor(operator).map((r) => r.label)).not.toContain("Test accounts");
    expect(rowsFor(nonOperator).some((r) => r.section === "test-accounts")).toBe(false);
    expect(adminSectionTabsFor("axis-users", operator.sections.map((s) => s.section))).toBeNull();
  });

  it("has no Properties or Subscribers row", () => {
    const labels = rowsFor(operator).map((r) => r.label);
    expect(labels).not.toContain("Properties");
    expect(labels).not.toContain("Subscribers");
  });

  it("keeps the row keyed on the group's first section even when that tab is filtered out", () => {
    const withoutWorkspaces = {
      ...adminPortal,
      sections: adminPortal.sections.filter((s) => s.section !== "service"),
    };
    const row = rowsFor(withoutWorkspaces).find((r) => r.label === "Service");
    // The key every other surface derives (active section, merged counts, the
    // native bottom bar) stays the group's first section; only the link moves.
    expect(row?.section).toBe(adminNavRowSection("proplane-line"));
    expect(row?.href).toBe("/admin/proplane-line");
    expect(row?.groupSections).toEqual(["proplane-line", "unassigned-leads"]);
  });

  it("puts the Meetings count on the Support row", () => {
    const merged = mergeAdminGroupCounts({
      events: { count: 3, tone: "muted" },
      "bugs-feedback": { count: 2, tone: "muted" },
      communication: { count: 5, tone: "alert" },
    });
    expect(merged["bugs-feedback"]).toEqual({ count: 5, tone: "muted" });
    expect(merged.communication).toEqual({ count: 5, tone: "alert" });
  });
});

describe("adminSectionTabsFor", () => {
  const all = adminPortal.sections.map((s) => s.section);

  it("returns the group's tabs in order for a grouped section", () => {
    expect(adminSectionTabsFor("promo-codes", all)?.sections).toEqual(["payments", "promo-codes", "finances", "managed-finance"]);
    expect(adminSectionTabsFor("health", all)).toMatchObject({ groupId: "support", label: "Support" });
  });

  it("returns nothing for Dashboard, Communication and Growth", () => {
    for (const section of ["dashboard", "communication", "growth", "profile", "axis-users", "test-accounts"]) {
      expect(adminSectionTabsFor(section, all)).toBeNull();
      expect(adminTabGroupIdFor(section)).toBeNull();
    }
  });

  it("returns the Service row's three tabs, and omits an unavailable one", () => {
    expect(adminSectionTabsFor("proplane-line", all)?.sections).toEqual(["service", "proplane-line", "unassigned-leads"]);
    const withoutLeads = all.filter((s) => s !== "unassigned-leads");
    expect(adminSectionTabsFor("service", withoutLeads)?.sections).toEqual(["service", "proplane-line"]);
  });

  it("covers every group member in the registry", () => {
    for (const group of Object.values(ADMIN_SECTION_TABS)) {
      for (const id of group.sections) expect(all).toContain(id);
    }
  });
});

describe("AdminSectionTabs strip", () => {
  const labels = () => screen.queryAllByRole("link").map((a) => a.textContent);

  it("renders no outer strip on Accounts or Test accounts (their tabs live inside the page)", () => {
    for (const pathname of ["/admin/axis-users", "/admin/test-accounts"]) {
      state.pathname = pathname;
      const { container } = render(<AdminSectionTabs definition={operator} />);
      expect(container.innerHTML).toBe("");
      cleanup();
    }
  });

  it("renders Workspaces · PropLane line · Unassigned leads as one Service strip with the page's tab active", () => {
    state.pathname = "/admin/proplane-line";
    render(<AdminSectionTabs definition={operator} />);
    expect(labels()).toEqual(["Workspaces", "PropLane line", "Unassigned leads"]);
    expect(screen.getByRole("link", { name: "PropLane line" }).getAttribute("aria-current")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Workspaces" }).getAttribute("href")).toBe("/admin/service");
  });

  it("renders Payments · Promo codes · Finances · Managed funds on a Money page", () => {
    state.pathname = "/admin/promo-codes";
    render(<AdminSectionTabs definition={operator} />);
    expect(labels()).toEqual(["Payments", "Promo codes", "Finances", "Managed funds"]);
    expect(screen.getByRole("link", { name: "Promo codes" }).getAttribute("aria-current")).toBe("page");
  });

  it("renders Feedback · Meetings · Health on Support, with the Meetings count on its tab", () => {
    state.pathname = "/admin/health";
    state.counts = { events: { count: 4, tone: "muted" } };
    render(<AdminSectionTabs definition={operator} />);
    expect(screen.getByRole("link", { name: "Health" }).getAttribute("aria-current")).toBe("page");
    expect(screen.getByRole("link", { name: /Meetings/ }).textContent).toContain("4");
    expect(screen.getByRole("link", { name: "Feedback" }).textContent).toBe("Feedback");
  });

  it.each(["dashboard", "communication", "growth", "profile"])(
    "renders nothing on /admin/%s",
    (section) => {
      state.pathname = `/admin/${section}`;
      const { container } = render(<AdminSectionTabs definition={operator} />);
      expect(container.innerHTML).toBe("");
    },
  );

  it("renders nothing on a record page under a grouped section", () => {
    state.pathname = "/admin/axis-users/manager-123";
    const { container } = render(<AdminSectionTabs definition={operator} />);
    expect(container.innerHTML).toBe("");
  });

  it("links a tabbed section the way every other surface does, and still shows on its tab page", () => {
    const tabbed = {
      ...operator,
      sections: operator.sections.map((s) =>
        s.section === "unassigned-leads" ? { ...s, tabs: [{ id: "active", label: "Active" }] } : s,
      ),
    };
    state.pathname = "/admin/unassigned-leads/active";
    render(<AdminSectionTabs definition={tabbed} />);
    expect(screen.getByRole("link", { name: "Unassigned leads" }).getAttribute("href")).toBe(
      hrefForSection(tabbed, "unassigned-leads"),
    );
    expect(screen.getByRole("link", { name: "Unassigned leads" }).getAttribute("aria-current")).toBe("page");
    cleanup();
    state.pathname = "/admin/unassigned-leads/lead-123";
    const { container } = render(<AdminSectionTabs definition={tabbed} />);
    expect(container.innerHTML).toBe("");
  });
});
