// @vitest-environment jsdom
/**
 * Owner portal (W21): every owner route resolves to a page, the shell is the shared chrome with at most five rows, and each
 * screen renders its loading / data / empty states on the shared list surface with the active workspace on every read.
 */
import { existsSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

let pathname = "/portal/owner";
const push = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push, replace: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => pathname,
  useSearchParams: () => new URLSearchParams(""),
}));
vi.mock("@/components/portal/portal-account-menu", () => ({
  PortalAccountMenu: () => <button type="button" data-attr="portal-account-menu">Account</button>,
  accountInitials: (name: string | null) => (name ?? "?").slice(0, 2).toUpperCase(),
}));
vi.mock("@/components/portal/portal-help-panel", () => ({ PortalHelpPanel: () => null }));
vi.mock("@/components/portal/portal-sign-out-button", () => ({ PortalSignOutButton: () => <button type="button">Sign out</button> }));
vi.mock("@/hooks/use-portal-session", () => ({ usePortalSession: () => ({ userId: "owner-1", email: "dana@example.test" }) }));
vi.mock("@/components/providers/app-ui-provider", () => ({ useAppUi: () => ({ showToast: vi.fn() }) }));

import { OwnerDocumentsPage } from "@/components/owner/owner-documents";
import { OwnerMessagesPage } from "@/components/owner/owner-messages";
import { OwnerOverview, ownerAttentionRows } from "@/components/owner/owner-overview";
import { OwnerPortalShell } from "@/components/owner/owner-portal-shell";
import { OwnerProfile } from "@/components/owner/owner-profile";
import { OwnerProperty } from "@/components/owner/owner-property";
import { OwnerPropertiesList, filterOwnerProperties, ownerPropertyTabs } from "@/components/owner/owner-properties";
import { OwnerStatementDetail } from "@/components/owner/owner-statement-detail";
import { OwnerStatementsPage, filterOwnerStatementRows, ownerStatementPdfUrl } from "@/components/owner/owner-statements";
import { OwnerWorkspaceProvider } from "@/components/owner/owner-workspace";
import { OWNER_BASE_PATH, ownerMoneyTabs, ownerNavItems, ownerPathAllowed } from "@/lib/property-owner/sections";
import type { OwnerWorkspaceTile } from "@/lib/property-owner/projection";

const TILES: OwnerWorkspaceTile[] = [
  { id: "ws-a", label: "Alder Row Homes", houses: 2, managed: false },
  { id: "ws-b", label: "Lakeview Rentals", houses: 1, managed: false },
];

const month = (m: string, net: number) => ({ month: m, rentCollectedCents: 200_000, rentDueCents: 200_000, otherIncomeCents: 0, feesCents: 5_000, repairsServicesCents: 10_000, netCents: net });
const SUMMARY = {
  period: "2026-10",
  totals: { netMonthCents: 185_000, netYtdCents: 900_000, rentCollectedCents: 200_000, rentDueCents: 215_000, units: 5, occupied: 4 },
  chart: [{ month: "2026-09", incomeCents: 200_000, expensesCents: 20_000 }],
  properties: [
    {
      propertyId: "alder", label: "Alder Row", units: 3, occupied: 2, rentCollectedCents: 120_000, rentDueCents: 130_000, netCents: 110_000, netYtdCents: 500_000,
      months: [month("2026-09", 90_000), month("2026-10", 110_000)],
      unitRows: [{ unit: "Room 1", status: "occupied", rentCents: 105_000, leaseEnd: "2027-04-30" }, { unit: "Room 3", status: "vacant", rentCents: null, leaseEnd: null }],
    },
    { propertyId: "maple", label: "Maple Court", units: 2, occupied: 2, rentCollectedCents: 80_000, rentDueCents: 85_000, netCents: 75_000, netYtdCents: 400_000, months: [month("2026-10", 75_000)] },
  ],
};
const EXTRAS = {
  managed: null,
  attention: [{ kind: "repair", id: "exp-1", title: "Roof patch", amountCents: 40_000, workspaceId: "ws-a" }],
  upcoming: [{ id: "i1", kind: "move-in", date: "2026-10-23", house: "Alder Row", unit: "Room 3" }],
};
const DETAIL = { propertyId: "alder", photos: [], services: [{ id: "wo1", title: "Kitchen sink leak", stage: "completed", date: "2026-10-06", costCents: 24_000 }] };
const STATEMENTS = { rows: [{ month: "2026-10", houses: 2, distributionCents: 185_000 }, { month: "2026-09", houses: 2, distributionCents: -4_500 }], houses: [{ propertyId: "alder", label: "Alder Row" }, { propertyId: "maple", label: "Maple Court" }] };

let urls: string[] = [];
let overrides: Record<string, unknown> = {};
function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}
function installFetch() {
  urls = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      urls.push(url);
      for (const [prefix, body] of Object.entries(overrides)) if (url.startsWith(prefix)) return json(200, body);
      if (url.startsWith("/api/owner/workspaces")) return json(200, { workspaces: TILES });
      if (url.startsWith("/api/owner/summary")) return json(200, SUMMARY);
      if (url.startsWith("/api/owner/overview")) return json(200, EXTRAS);
      if (url.startsWith("/api/owner/properties/")) return json(200, DETAIL);
      if (url.startsWith("/api/owner/statements")) return json(200, STATEMENTS);
      if (url.startsWith("/api/owner/documents")) return json(200, { documents: [{ id: "d1", title: "Insurance certificate", mimeType: "application/pdf", sizeBytes: 20_480, createdAt: "2026-10-01T10:00:00Z" }] });
      if (url.startsWith("/api/owner/messages")) return json(200, { conversations: [{ conversationId: "c1", messages: [{ id: "m1", body: "Hello there", at: "2026-10-01T10:00:00Z", fromMe: false }] }] });
      return json(404, { error: "Not found." });
    }),
  );
}
const withWorkspaces = (node: React.ReactNode) => <OwnerWorkspaceProvider initial={TILES}>{node}</OwnerWorkspaceProvider>;

beforeEach(() => {
  pathname = "/portal/owner";
  overrides = {};
  push.mockClear();
  installFetch();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("every owner route loads", () => {
  it("has a page for the owner base, every row, every Money tab and the month detail", () => {
    const pages = ["", "properties", "properties/[propertyId]", "statements", "statements/[month]", "finances", "documents", "messages", "profile"];
    for (const rel of pages) expect(existsSync(path.join(process.cwd(), "src/app/portal/owner", rel, "page.tsx")), rel).toBe(true);
    for (const item of ownerNavItems(true)) expect(ownerPathAllowed(item.href, true, true), item.href).toBe(true);
    for (const tab of ownerMoneyTabs(true)) expect(ownerPathAllowed(tab.href, true, true), tab.href).toBe(true);
  });
});

describe("the shell", () => {
  it("is the shared chrome: top strip, workspace rail, sidebar with at most five rows, bottom bar and More", () => {
    const { container } = render(
      <OwnerPortalShell messagesOn financesOn name="Dana Whitfield" email="dana@example.test">
        <p>page</p>
      </OwnerPortalShell>,
    );
    expect(container.querySelector('[data-slot="portal-top-strip"]')).not.toBeNull();
    expect(container.querySelector('[data-slot="portal-workspace-rail"]')).not.toBeNull();
    expect(container.querySelector('[data-slot="portal-sidebar"]')).not.toBeNull();
    const rows = container.querySelectorAll('[data-slot="portal-sidebar"] a[data-attr^="owner-nav-"]');
    expect([...rows].map((a) => a.textContent)).toEqual(["Overview", "Properties", "Money", "Messages", "Settings"]);
    expect(rows.length).toBeLessThanOrEqual(5);
    // Every row has a real glyph, never an empty circle.
    for (const row of rows) expect(row.querySelector("svg")).not.toBeNull();
    expect(container.querySelector('[data-attr="owner-bottom-nav"]')).not.toBeNull();
    expect(container.querySelector('[data-attr="owner-bottom-more"]')).not.toBeNull();
  });

  it("shows a tile per workspace and switches the workspace every read follows", async () => {
    pathname = "/portal/owner/statements";
    render(
      <OwnerPortalShell messagesOn={false}>
        <OwnerStatementsPage />
      </OwnerPortalShell>,
    );
    await screen.findAllByRole("button", { name: /Switch workspace:/ });
    const tiles = [...document.querySelectorAll<HTMLElement>('[data-attr="owner-rail-workspace"]')];
    expect(tiles.map((t) => t.getAttribute("title"))).toEqual(["Alder Row Homes", "Lakeview Rentals"]);
    await waitFor(() => expect(urls.some((u) => u.startsWith("/api/owner/statements") && u.includes("workspace=ws-a"))).toBe(true));
    // Nothing was ever read unscoped once the list had answered.
    expect(urls.filter((u) => u.startsWith("/api/owner/statements") && !u.includes("workspace="))).toEqual([]);
    fireEvent.click(tiles[1]!);
    await waitFor(() => expect(urls.some((u) => u.startsWith("/api/owner/statements") && u.includes("workspace=ws-b"))).toBe(true));
  });

  it("puts the Money tab strip on a Money list page, not on Overview or on a statement month", () => {
    pathname = "/portal/owner/documents";
    const money = render(
      <OwnerPortalShell messagesOn={false} financesOn>
        <p>docs</p>
      </OwnerPortalShell>,
    );
    const tabs = money.container.querySelector('[data-attr="owner-section-tabs"]');
    expect(tabs?.textContent).toContain("Statements");
    expect(tabs?.textContent).toContain("Finances");
    expect(tabs?.textContent).toContain("Documents");
    cleanup();
    for (const p of ["/portal/owner", "/portal/owner/statements/2026-10", "/portal/owner/properties"]) {
      pathname = p;
      const other = render(
        <OwnerPortalShell messagesOn={false}>
          <p>x</p>
        </OwnerPortalShell>,
      );
      expect(other.container.querySelector('[data-attr="owner-section-tabs"]'), p).toBeNull();
      cleanup();
    }
  });

  it("hides Finances from the strip unless PropLane holds the funds", () => {
    pathname = "/portal/owner/statements";
    const { container } = render(
      <OwnerPortalShell messagesOn={false}>
        <p>x</p>
      </OwnerPortalShell>,
    );
    expect(container.querySelector('[data-attr="owner-section-tabs"]')?.textContent).not.toContain("Finances");
  });
});

describe("Overview", () => {
  it("draws five KPI cards, Needs attention and Upcoming, and no page title", async () => {
    const { container } = render(withWorkspaces(<OwnerOverview />));
    await screen.findByText("Occupancy");
    expect(container.querySelectorAll('[data-attr="owner-kpis"] > a').length).toBe(5);
    expect(container.querySelector("h1")).toBeNull();
    expect(await screen.findByText(/Roof patch/)).toBeTruthy();
    expect(screen.getByText(/Move-in · Alder Row · Room 3/)).toBeTruthy();
    expect(screen.getByText("Oct 23")).toBeTruthy();
  });

  it("shows fee, net to you and available to withdraw for a managed workspace", async () => {
    overrides["/api/owner/overview"] = { managed: { workspaceId: "ws-a", rentCents: 215_000, feeCents: -21_500, netCents: 193_500, availableCents: 150_000 }, attention: [], upcoming: [] };
    render(withWorkspaces(<OwnerOverview />));
    await screen.findByText("PropLane fee");
    expect(screen.getByText("Net to you")).toBeTruthy();
    expect(screen.getByText("Available to withdraw")).toBeTruthy();
    expect(screen.getByText("$1,500")).toBeTruthy();
    // The fee reads as a positive amount, and managed rent comes from the ledger rather than the manager's own books.
    expect(screen.getByText("$215")).toBeTruthy();
    expect(screen.getByText("$2,150")).toBeTruthy();
    expect(screen.getByText("Nothing is waiting on you. Nice.")).toBeTruthy();
  });

  it("links an attention row to the page that clears it", () => {
    const rows = ownerAttentionRows([
      { kind: "repair", id: "exp-1", title: "Roof patch", amountCents: 40_000, workspaceId: "ws-a" },
      { kind: "statement", id: "s1", month: "2026-09", workspaceId: "ws-a" },
      { kind: "agreement", id: "p1", workspaceId: "ws-a" },
    ]);
    expect(rows.map((r) => r.href)).toEqual([
      `${OWNER_BASE_PATH}/finances?workspace=ws-a&approve=exp-1`,
      `${OWNER_BASE_PATH}/statements/2026-09`,
      `${OWNER_BASE_PATH}/finances?workspace=ws-a&review=p1`,
    ]);
    expect(rows.map((r) => r.action)).toEqual(["Approve", "View", "Sign"]);
  });

  it("shows the empty state only when no house is shared", async () => {
    overrides["/api/owner/summary"] = { ...SUMMARY, properties: [] };
    render(withWorkspaces(<OwnerOverview />));
    expect(await screen.findByText("No activity yet")).toBeTruthy();
  });
});

describe("Properties", () => {
  it("is the manager's list surface, read-only: tabs with counts, search, rows, no add", async () => {
    const { container } = render(withWorkspaces(<OwnerPropertiesList />));
    await screen.findByText("Alder Row");
    expect(screen.getByText("Maple Court")).toBeTruthy();
    expect(container.querySelector('[data-attr="owner-properties-search"], input[placeholder="Search properties"]')).not.toBeNull();
    expect(container.querySelector('[data-attr="portal-list-primary-action"], [aria-label^="Add"]')).toBeNull();
    fireEvent.click(screen.getByText("Alder Row"));
    expect(push).toHaveBeenCalledWith(`${OWNER_BASE_PATH}/properties/alder`);
  });

  it("filters by tab and search on the rows' own facts", () => {
    const props = SUMMARY.properties;
    expect(ownerPropertyTabs(props)).toEqual([{ id: "all", label: "All", count: 2 }, { id: "vacancies", label: "Vacancies", count: 1 }]);
    expect(filterOwnerProperties(props, "vacancies", "").map((p) => p.propertyId)).toEqual(["alder"]);
    expect(filterOwnerProperties(props, "all", "maple").map((p) => p.propertyId)).toEqual(["maple"]);
  });

  it("opens a house with photos or an honest placeholder, its rooms, services and months", async () => {
    const { container } = render(withWorkspaces(<OwnerProperty propertyId="alder" />));
    await screen.findByText("Room 1");
    expect(container.querySelector('[data-attr="owner-photos-empty"]')).not.toBeNull();
    expect(container.querySelector("img")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Services/ }));
    expect(await screen.findByText("Kitchen sink leak")).toBeTruthy();
    expect(screen.getByText("Completed")).toBeTruthy();
    expect(screen.getAllByText("$240").length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole("button", { name: /Months/ }));
    expect(container.querySelector('[data-attr="owner-month-table"]')).not.toBeNull();
  });

  it("draws real photos when the listing has them", async () => {
    overrides["/api/owner/properties/alder"] = { ...DETAIL, photos: ["https://cdn.example.test/a.jpg"] };
    const { container } = render(withWorkspaces(<OwnerProperty propertyId="alder" />));
    await waitFor(() => expect(container.querySelector('[data-attr="owner-photos"] img')).not.toBeNull());
    expect(container.querySelector('[data-attr="owner-photos-empty"]')).toBeNull();
  });
});

describe("Statements", () => {
  it("is a list: houses as tabs, search, one row per month with the net and a menu", async () => {
    const { container } = render(withWorkspaces(<OwnerStatementsPage />));
    await screen.findByText("October 2026");
    expect(screen.getByText("September 2026")).toBeTruthy();
    expect(screen.getAllByText("-$45").length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: /All houses/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Alder Row/ })).toBeTruthy();
    expect(container.querySelector("h1")).toBeNull();
    expect(container.querySelector('[data-attr="owner-statements-download"]')).not.toBeNull();
    // A row opens the month, and its menu offers View and Download PDF.
    fireEvent.click(screen.getByText("October 2026"));
    expect(push).toHaveBeenCalledWith(`${OWNER_BASE_PATH}/statements/2026-10`);
    expect(container.querySelectorAll('[data-attr="record-actions-trigger"]').length).toBe(2);
  });

  it("narrows to a house and searches months", () => {
    expect(filterOwnerStatementRows(STATEMENTS.rows, "sept").map((r) => r.month)).toEqual(["2026-09"]);
    expect(filterOwnerStatementRows(STATEMENTS.rows, "").length).toBe(2);
    expect(ownerStatementPdfUrl("2026-10", "alder", "ws-a")).toBe("/api/owner/statements/pdf?month=2026-10&propertyId=alder&workspace=ws-a");
    expect(ownerStatementPdfUrl("2026-10", "", null)).toBe("/api/owner/statements/pdf?month=2026-10");
  });

  it("opens a month with rent, fees and net, and sends a bad month to an empty state", async () => {
    pathname = "/portal/owner/statements/2026-10";
    render(withWorkspaces(<OwnerStatementDetail month="2026-10" />));
    await screen.findByText("October 2026 statement");
    expect((await screen.findAllByText("Rent collected")).length).toBeGreaterThan(0);
    expect(screen.getByText("Net to you")).toBeTruthy();
    cleanup();
    render(withWorkspaces(<OwnerStatementDetail month="soon" />));
    expect(await screen.findByText("No statement for that month")).toBeTruthy();
  });
});

describe("Documents, Messages and Settings", () => {
  it("lists shared documents on the list surface with a menu to download", async () => {
    const { container } = render(withWorkspaces(<OwnerDocumentsPage />));
    await screen.findByText("Insurance certificate");
    expect(container.querySelector("h1")).toBeNull();
    expect(container.querySelector('input[placeholder="Search documents"]')).not.toBeNull();
  });

  it("shows the owner's thread with their manager", async () => {
    const { container } = render(withWorkspaces(<OwnerMessagesPage />));
    await screen.findByText("Hello there");
    expect(container.querySelector("h1")).toBeNull();
    expect(container.querySelector('[data-attr="owner-message-input"]')).not.toBeNull();
  });

  it("reads a workspace with Messages off as an empty thread, not an error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => (String(input).startsWith("/api/owner/messages") ? json(404, { error: "Not found." }) : json(200, {}))),
    );
    render(withWorkspaces(<OwnerMessagesPage />));
    expect(await screen.findByText("No messages yet")).toBeTruthy();
    expect(screen.queryByText("Couldn't load your messages.")).toBeNull();
  });

  it("shows who is signed in under Settings", () => {
    render(<OwnerProfile name="Dana Whitfield" email="dana@example.test" />);
    expect(screen.getByText("Settings")).toBeTruthy();
    expect(screen.getByText("Dana Whitfield")).toBeTruthy();
  });
});
