// @vitest-environment jsdom
//
// Phase 1 shell redesign: the desktop sidebar is a 248px column with the
// workspace header and the nav rows (no Conversations list); the collapse control,
// help footer and account menu live elsewhere. Portal simplification (Oct 18): the
// manager sidebar is six folded rows in one unheaded group; the headed, collapsible
// groups that remain are admin's (Property management, Software).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import React from "react";
import { act, cleanup, fireEvent, render, within } from "@testing-library/react";
import type { WorkspaceContextValue } from "@/components/portal/workspace-provider";
import type { PersistedInboxThread } from "@/lib/portal-inbox-storage";
import { adminPortal } from "@/lib/portals/admin";
import { proPortal } from "@/lib/portals/pro";

const navigateMock = vi.fn();
const pathnameRef = { value: "/portal/properties/all" };
vi.mock("next/navigation", () => ({
  usePathname: () => pathnameRef.value,
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
}));
vi.mock("@/hooks/use-is-native-app", () => ({
  useNativeChrome: () => false,
  useIsSmallPortalViewport: () => false,
}));
vi.mock("@/hooks/use-portal-nav-counts", () => ({
  usePortalNavCounts: () => ({
    communication: { count: 1, tone: "alert" },
    applications: { count: 2, tone: "alert" },
    properties: { count: 2, tone: "muted" },
  }),
}));
vi.mock("@/hooks/use-portal-session", () => ({
  usePortalSession: () => ({ email: "avery@example.com", userId: "user-1", ready: true }),
}));
vi.mock("@/hooks/use-co-manager-nav-sections", () => ({
  useCoManagerNavSections: (definition: { sections: unknown[] }) => ({
    sections: definition.sections,
    restrictedSections: new Set<string>(),
  }),
}));
vi.mock("@/lib/portal-nav-client", () => ({
  usePortalNavigate: () => navigateMock,
  portalNavClick: () => () => {},
  isCrossPortalNavigation: () => false,
  prefetchPortalHref: vi.fn(),
}));
vi.mock("@/lib/portal-nav-prefetch", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/portal-nav-prefetch")>()),
  portalBackgroundPrefetchEnabled: () => false,
  portalMobileLinkPrefetchEnabled: () => false,
}));
vi.mock("@/lib/portal-panel-prefetch", () => ({ prefetchPortalPanelChunks: vi.fn() }));
vi.mock("@/components/providers/app-ui-provider", () => ({ useAppUi: () => ({ showToast: vi.fn() }) }));

const workspaceCtx: { value: WorkspaceContextValue | null } = { value: null };
vi.mock("@/components/portal/workspace-provider", () => ({ useWorkspaces: () => workspaceCtx.value }));

const inboxRows: { value: PersistedInboxThread[] } = { value: [] };
vi.mock("@/lib/portal-inbox-storage", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/portal-inbox-storage")>()),
  loadPersistedInbox: () => inboxRows.value,
}));

Element.prototype.scrollIntoView = Element.prototype.scrollIntoView ?? (() => {});

const { PortalSidebar } = await import("@/components/portal/portal-sidebar");
const { setPortalSidebarCollapsed, resetPortalSidebarCollapsedForTests } = await import(
  "@/lib/portal-sidebar-collapse-store"
);

function thread(n: number, over: Partial<PersistedInboxThread> = {}): PersistedInboxThread {
  return {
    id: `thread-${1700000000000 + n}`,
    folder: "inbox",
    from: `Person ${n}`,
    email: `p${n}@example.com`,
    subject: "Hi",
    preview: "Hi",
    body: "Hi",
    time: "",
    unread: false,
    ...over,
  } as PersistedInboxThread;
}

function setWorkspace(name = "Seattle Homes", livePropertyCount = 2) {
  const active = {
    id: "w1",
    name,
    ownerUserId: "user-1",
    owned: true,
    isDefault: true,
    propertyIds: [],
    livePropertyCount,
    propertyPermissions: {},
  } as unknown as WorkspaceContextValue["workspaces"][number];
  workspaceCtx.value = {
    workspaces: [active],
    active,
    plan: null,
    error: null,
    loading: false,
    refresh: vi.fn(),
    mutate: vi.fn(),
    select: vi.fn().mockResolvedValue(undefined),
  };
}

function aside() {
  const el = document.querySelector("aside");
  if (!el) throw new Error("desktop sidebar did not render");
  return el as HTMLElement;
}

function renderManager() {
  return render(<PortalSidebar definition={proPortal} subscriptionTier="paid" subtitle="Pro" />);
}

function renderAdmin(path = "/admin/axis-users") {
  pathnameRef.value = path;
  return render(<PortalSidebar definition={adminPortal} subtitle="Admin" />);
}

function installMemoryStorage() {
  // Node's experimental global localStorage shadows jsdom's and is unusable without a file flag.
  const store = new Map<string, string>();
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: {
      getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
      setItem: (k: string, v: string) => void store.set(k, String(v)),
      removeItem: (k: string) => void store.delete(k),
      clear: () => store.clear(),
    },
  });
}

beforeEach(() => {
  pathnameRef.value = "/portal/properties/all";
  setWorkspace();
  inboxRows.value = [];
  installMemoryStorage();
  navigateMock.mockClear();
  resetPortalSidebarCollapsedForTests();
});
afterEach(cleanup);

describe("sidebar header", () => {
  it("names the workspace and says Property with its live house count", () => {
    renderManager();
    const side = within(aside());
    expect(side.getByRole("button", { name: "Switch workspace: Seattle Homes" })).toBeTruthy();
    expect(side.getByText("Property · 2 houses")).toBeTruthy();
  });

  it("singular house", () => {
    setWorkspace("Solo", 1);
    renderManager();
    expect(within(aside()).getByText("Property · 1 house")).toBeTruthy();
  });

  it("New message opens the existing Communication compose through its ?compose=1 entry", () => {
    renderManager();
    fireEvent.click(within(aside()).getByRole("button", { name: "New message" }));
    expect(navigateMock).toHaveBeenCalledWith("/portal/communication/active?compose=1");
  });

  it("no longer carries the old Need help? footer or a collapse control", () => {
    renderManager();
    const side = within(aside());
    expect(side.queryByText("Need help?")).toBeNull();
    expect(side.queryByRole("button", { name: /collapse sidebar/i })).toBeNull();
    expect(side.queryByRole("button", { name: /expand sidebar/i })).toBeNull();
  });
});

describe("regrouped nav", () => {
  it("shows six folded rows in one unheaded group: Home, Communication, Properties, Leasing, People, Money", () => {
    renderManager();
    const side = aside();
    const groups = Array.from(side.querySelectorAll("[data-nav-group]")).map((g) => g.getAttribute("data-nav-group"));
    expect(groups).toEqual(["main"]);
    // A row IS the group: no heading button for any manager group.
    expect(side.querySelectorAll("[data-nav-group] button[aria-expanded]")).toHaveLength(0);
    const rows = Array.from(side.querySelectorAll(`[data-nav-group="main"] a, [data-nav-group="main"] [role="link"]`)).map(
      (a) => (a.getAttribute("aria-label") ?? a.textContent ?? "").trim(),
    );
    expect(rows).toEqual(["Home", "Communication", "Properties", "Leasing", "People", "Money"]);
    // The tabs of a row are not rows: they live in the strip along the top of the row's pages.
    const side$ = within(side);
    for (const tab of ["Dashboard", "Tasks", "Calendar", "Bookings", "Promotion", "Tours", "Documents", "Finances"]) {
      expect(side$.queryByRole("link", { name: tab })).toBeNull();
    }
  });

  it("a folded row carries the summed count of its tabs and is alert when any tab is", () => {
    renderManager();
    // Applications (2, alert) is a tab of Leasing.
    const leasing = within(aside()).getByRole("link", { name: "Leasing" });
    const badge = leasing.querySelector("[data-attr='nav-count']")!;
    expect(badge.getAttribute("data-tone")).toBe("alert");
    expect(badge.textContent).toBe("2");
  });

  it("an alert count is a solid red pill and bolds the row; a quiet count is a muted number", () => {
    renderManager();
    const side = within(aside());
    const comm = side.getByRole("link", { name: "Communication" });
    const commBadge = comm.querySelector("[data-attr='nav-count']")!;
    expect(commBadge.getAttribute("data-tone")).toBe("alert");
    expect(commBadge.className).toContain("bg-[#d92d20]");
    expect(comm.className).toContain("font-[650]");

    const props = side.getByRole("link", { name: "Properties" });
    const propBadge = props.querySelector("[data-attr='nav-count']")!;
    expect(propBadge.getAttribute("data-tone")).toBe("muted");
    expect(propBadge.className).not.toContain("bg-[#d92d20]");
  });

  it("the active row uses the soft-blue active style", () => {
    renderManager();
    const props = within(aside()).getByRole("link", { name: "Properties" });
    expect(props.getAttribute("aria-current")).toBe("page");
    expect(props.className).toContain("--portal-sidebar-active-bg");
  });
});

describe("collapsible groups (admin keeps two headed halves)", () => {
  const closedKey = `portal-nav-closed-groups:${adminPortal.kind}`;

  it("clicking a heading hides the group's rows, keeps the active row, and persists", () => {
    renderAdmin("/admin/axis-users");
    const side = within(aside());
    expect(side.getByRole("link", { name: "Money" })).toBeTruthy();
    expect(side.getByRole("link", { name: "Growth" })).toBeTruthy();
    fireEvent.click(side.getByRole("button", { name: "Software" }));
    // Money / Growth collapse away; Accounts is the active row (Accounts is a row of Software), so it stays.
    expect(side.queryByRole("link", { name: "Money" })).toBeNull();
    expect(side.queryByRole("link", { name: "Growth" })).toBeNull();
    expect(side.getByRole("link", { name: "Accounts" })).toBeTruthy();
    expect(JSON.parse(window.localStorage.getItem(closedKey)!)).toEqual(["software"]);

    fireEvent.click(side.getByRole("button", { name: "Software" }));
    expect(side.getByRole("link", { name: "Money" })).toBeTruthy();
  });

  it("restores a persisted closed group", async () => {
    window.localStorage.setItem(closedKey, JSON.stringify(["software"]));
    renderAdmin("/admin/dashboard");
    await act(async () => {});
    expect(within(aside()).queryByRole("link", { name: "Money" })).toBeNull();
    expect(within(aside()).getByRole("link", { name: "Dashboard" })).toBeTruthy();
  });

  it("survives unavailable storage", () => {
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      value: {
        getItem: () => {
          throw new Error("blocked");
        },
        setItem: () => {
          throw new Error("blocked");
        },
      },
    });
    renderAdmin("/admin/dashboard");
    const side = within(aside());
    expect(side.getByRole("link", { name: "Money" })).toBeTruthy();
    // toggling still works in memory even though nothing can be persisted
    fireEvent.click(side.getByRole("button", { name: "Software" }));
    expect(side.queryByRole("link", { name: "Money" })).toBeNull();
  });
});

describe("collapsed sidebar", () => {
  it("is hidden entirely (rail + content only) when the shared collapse store says so", () => {
    renderManager();
    expect(aside().className).toContain("lg:flex");
    act(() => setPortalSidebarCollapsed(true));
    expect(aside().className).toContain("lg:hidden");
    expect(document.documentElement.hasAttribute("data-portal-sidebar-collapsed")).toBe(true);
    act(() => setPortalSidebarCollapsed(false));
    expect(aside().className).toContain("lg:flex");
  });
});

describe("no Conversations group", () => {
  // Captain: "remove Conversations section from sidebar". Communication is the
  // single entry to messages; the sidebar lists no people even when threads exist.
  it("renders no conversations group or thread links, with threads in the inbox", () => {
    inboxRows.value = [1, 2, 3, 4, 5, 6, 7].map((n) => thread(n, { unread: n === 7 }));
    renderManager();
    expect(aside().querySelector('[data-nav-group="conversations"]')).toBeNull();
    expect(aside().querySelectorAll('[data-attr="portal-sidebar-conversation"]')).toHaveLength(0);
    expect(within(aside()).queryByText("Conversations")).toBeNull();
    expect(within(aside()).queryByText("Person 7")).toBeNull();
    expect(aside().querySelector('a[href^="/portal/communication"]')).not.toBeNull();
  });
});
