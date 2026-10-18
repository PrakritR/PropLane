// @vitest-environment jsdom
/**
 * Admin's sidebar is seven rows, and the grouped rows (Dashboard with Feedback · Meetings · Health, Properties,
 * Accounts, Money) show their sections as a tab strip (`PortalSectionTabs`, the strip every portal's folded rows use).
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

import { PortalSectionTabs } from "@/components/portal/portal-section-tabs";

afterEach(() => {
  cleanup();
  state.counts = {};
});

const operator = adminPortalForTestWorkspaceOperator(true);
const nonOperator = adminPortalForTestWorkspaceOperator(false);

function rowsFor(definition: typeof adminPortal) {
  return collapseAdminNavItems(buildPortalNavItems(definition, definition.sections, false, undefined));
}

describe("admin sidebar rows", () => {
  it("lists seven rows for the operator, Settings first, in order, with no section reachable twice", () => {
    const rows = rowsFor(operator);
    expect(rows.map((r) => r.label)).toEqual([
      "Settings",
      "Dashboard",
      "Communication",
      "Properties",
      "Accounts",
      "Money",
      "Growth",
    ]);
    const reach = rows.flatMap((r) => r.groupSections ?? [r.section]);
    expect(new Set(reach).size).toBe(reach.length);
    expect([...reach].sort()).toEqual(
      operator.sections.map((s) => s.section).sort(),
    );
  });

  it("links a grouped row to its first visible tab", () => {
    const rows = rowsFor(operator);
    const hrefOf = (label: string) => rows.find((r) => r.label === label)?.href;
    expect(hrefOf("Accounts")).toBe("/admin/axis-users");
    expect(hrefOf("Money")).toBe("/admin/payments");
    expect(hrefOf("Dashboard")).toBe("/admin/dashboard");
  });

  it("is idempotent: folding an already folded list changes nothing", () => {
    const once = rowsFor(operator);
    expect(collapseAdminNavItems(once)).toEqual(once);
  });

  it.each([
    ["axis-users", "axis-users"],
    ["subscribers", "axis-users"],
    ["unassigned-leads", "properties"],
    ["service", "properties"],
    ["proplane-line", "properties"],
    ["test-accounts", "axis-users"],
    ["payments", "payments"],
    ["promo-codes", "payments"],
    ["finances", "payments"],
    ["bugs-feedback", "dashboard"],
    ["events", "dashboard"],
    ["health", "dashboard"],
    ["dashboard", "dashboard"],
    ["communication", "communication"],
    ["properties", "properties"],
    ["growth", "growth"],
  ])("%s is active on the %s row", (section, row) => {
    expect(adminNavRowSection(section)).toBe(row);
  });

  it("maps /admin/promo-codes to the Money row", () => {
    const rows = rowsFor(operator);
    const active = rows.find((r) => r.groupSections?.includes("promo-codes") || r.section === "promo-codes");
    expect(active?.label).toBe("Money");
  });

  it("drops the operator-only Test accounts tab from the Accounts row for everyone else", () => {
    const accounts = rowsFor(nonOperator).find((r) => r.label === "Accounts");
    expect(accounts?.groupSections).toEqual(["axis-users", "subscribers"]);
    expect(rowsFor(operator).find((r) => r.label === "Accounts")?.groupSections).toEqual([
      "axis-users",
      "subscribers",
      "test-accounts",
    ]);
  });

  it("keeps the row keyed on the group's first section even when that tab is filtered out", () => {
    const withoutAccounts = {
      ...adminPortal,
      sections: adminPortal.sections.filter((s) => s.section !== "axis-users"),
    };
    const row = rowsFor(withoutAccounts).find((r) => r.label === "Accounts");
    // The key every other surface derives (active section, merged counts, the
    // native bottom bar) stays the group's first section; only the link moves.
    expect(row?.section).toBe(adminNavRowSection("subscribers"));
    expect(row?.href).toBe("/admin/subscribers");
    expect(row?.groupSections).toEqual(["subscribers", "test-accounts"]);
  });

  it("puts the Meetings and Feedback counts on the Dashboard row", () => {
    const merged = mergeAdminGroupCounts({
      events: { count: 3, tone: "muted" },
      "bugs-feedback": { count: 2, tone: "muted" },
      communication: { count: 5, tone: "alert" },
    });
    expect(merged.dashboard).toEqual({ count: 5, tone: "muted" });
    expect(merged.communication).toEqual({ count: 5, tone: "alert" });
    expect(merged["axis-users"]).toEqual({ count: 0, tone: "muted" });
  });
});

describe("adminSectionTabsFor", () => {
  const all = adminPortal.sections.map((s) => s.section);

  it("returns the group's tabs in order for a grouped section", () => {
    expect(adminSectionTabsFor("promo-codes", all)?.sections).toEqual(["payments", "promo-codes", "finances"]);
    expect(adminSectionTabsFor("health", all)).toMatchObject({ groupId: "dashboard", label: "Dashboard" });
    expect(adminSectionTabsFor("dashboard", all)?.sections).toEqual(["dashboard", "bugs-feedback", "events", "health"]);
  });

  it("returns nothing for Communication, Growth and Settings", () => {
    for (const section of ["communication", "growth", "profile"]) {
      expect(adminSectionTabsFor(section, all)).toBeNull();
      expect(adminTabGroupIdFor(section)).toBeNull();
    }
  });

  it("omits an unavailable (operator-only) tab", () => {
    const withoutOperator = all.filter((s) => s !== "test-accounts");
    expect(adminSectionTabsFor("axis-users", withoutOperator)?.sections).toEqual(["axis-users", "subscribers"]);
  });

  it("covers every group member in the registry", () => {
    for (const group of Object.values(ADMIN_SECTION_TABS)) {
      for (const id of group.sections) expect(all).toContain(id);
    }
  });
});

describe("PortalSectionTabs strip (admin)", () => {
  const labels = () => screen.queryAllByRole("link").map((a) => a.textContent);

  it("renders Accounts · Subscribers · Test accounts for the operator, as links, with the page's tab active", () => {
    state.pathname = "/admin/subscribers";
    render(<PortalSectionTabs definition={operator} />);
    expect(labels()).toEqual(["Accounts", "Subscribers", "Test accounts"]);
    expect(screen.getByRole("link", { name: "Subscribers" }).getAttribute("aria-current")).toBe("page");
    expect(screen.getByRole("link", { name: "Accounts" }).getAttribute("href")).toBe("/admin/axis-users");
    expect(screen.getByRole("link", { name: "Test accounts" }).getAttribute("href")).toBe("/admin/test-accounts");
  });

  it("renders Properties · Service · PropLane line · Unassigned leads as one strip with the page's tab active", () => {
    state.pathname = "/admin/proplane-line";
    render(<PortalSectionTabs definition={operator} />);
    expect(labels()).toEqual(["Properties", "Service", "PropLane line", "Unassigned leads"]);
    expect(screen.getByRole("link", { name: "PropLane line" }).getAttribute("aria-current")).toBeTruthy();
  });

  it("omits Test accounts for a non-operator", () => {
    state.pathname = "/admin/axis-users";
    render(<PortalSectionTabs definition={nonOperator} />);
    expect(labels()).toEqual(["Accounts", "Subscribers"]);
  });

  it("renders Payments · Promo codes · Finances on a Money page", () => {
    state.pathname = "/admin/promo-codes";
    render(<PortalSectionTabs definition={operator} />);
    expect(labels()).toEqual(["Payments", "Promo codes", "Finances"]);
    expect(screen.getByRole("link", { name: "Promo codes" }).getAttribute("aria-current")).toBe("page");
  });

  it("renders Dashboard · Feedback · Meetings · Health on the Dashboard row, with the Meetings count on its tab", () => {
    state.pathname = "/admin/health";
    state.counts = { events: { count: 4, tone: "muted" } };
    render(<PortalSectionTabs definition={operator} />);
    expect(screen.getByRole("link", { name: "Health" }).getAttribute("aria-current")).toBe("page");
    expect(screen.getByRole("link", { name: /Meetings/ }).textContent).toContain("4");
    expect(screen.getByRole("link", { name: "Feedback" }).textContent).toBe("Feedback");
  });

  it.each(["communication", "growth", "profile"])(
    "renders nothing on /admin/%s",
    (section) => {
      state.pathname = `/admin/${section}`;
      const { container } = render(<PortalSectionTabs definition={operator} />);
      expect(container.innerHTML).toBe("");
    },
  );

  it("renders nothing on a record page under a grouped section", () => {
    state.pathname = "/admin/axis-users/manager-123";
    const { container } = render(<PortalSectionTabs definition={operator} />);
    expect(container.innerHTML).toBe("");
  });

  it("links a tabbed section the way every other surface does, and still shows on its tab page", () => {
    const tabbed = {
      ...operator,
      sections: operator.sections.map((s) =>
        s.section === "subscribers" ? { ...s, tabs: [{ id: "active", label: "Active" }] } : s,
      ),
    };
    state.pathname = "/admin/subscribers/active";
    render(<PortalSectionTabs definition={tabbed} />);
    expect(screen.getByRole("link", { name: "Subscribers" }).getAttribute("href")).toBe(
      hrefForSection(tabbed, "subscribers"),
    );
    expect(screen.getByRole("link", { name: "Subscribers" }).getAttribute("aria-current")).toBe("page");
    cleanup();
    state.pathname = "/admin/subscribers/sub-123";
    const { container } = render(<PortalSectionTabs definition={tabbed} />);
    expect(container.innerHTML).toBe("");
  });
});
