// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const toast = vi.hoisted(() => vi.fn());
const copied = vi.hoisted(() => vi.fn(async (_text: string) => true));
const status = vi.hoisted(() => ({ value: {} as Record<string, unknown> }));

vi.mock("@/components/providers/app-ui-provider", () => ({
  useConfirm: () => () => Promise.resolve(true),
  useAppUi: () => ({ showToast: toast }),
}));
vi.mock("@/components/portal/workspace-provider", () => ({
  useWorkspaces: () => ({ workspaces: [], active: { id: "w1", propertyIds: ["p1", "p2"], propertyLabels: {} } }),
}));
vi.mock("@/lib/manager-property-links", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/manager-property-links")>()),
  copyTextToClipboard: copied,
}));
vi.mock("@/lib/rental-application/data", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/rental-application/data")>()),
  getPropertyById: (id: string) => ({ id, listingSubmission: { syndication: { zillow: { enabled: id === "p1" } } } }),
}));

import { PropertyListingSitesPanel, WorkspaceListingSitesPanel } from "@/components/portal/listing-sites-panel";
import { resetSharedGets } from "@/lib/shared-get-cache";

const ZILLOW = { enabled: true, fact: "Sent · Oct 6", saving: false, onToggle: vi.fn() };

function baseStatus(over: Record<string, unknown> = {}) {
  return {
    workspaceId: "w1",
    canManage: true,
    schemaReady: true,
    channels: [
      { id: "facebook_page", availability: "coming_soon" },
      { id: "instagram", availability: "coming_soon" },
    ],
    meta: { configured: false, connected: false, pageName: null, igUsername: null, revoked: false },
    workContact: { phone: "(206) 555-0100", email: null },
    posts: [],
    property: { id: "p1", live: true, holdReasons: [], postTexts: { facebook_marketplace: "FB POST\nText (206) 555-0100", roomster: "ROOMSTER POST" } },
    ...over,
  };
}

beforeEach(() => {
  resetSharedGets();
  status.value = baseStatus();
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === "POST") return { ok: true, status: 200, json: async () => ({ ok: true }) };
    void input;
    return { ok: true, status: 200, json: async () => status.value };
  }));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

const row = (id: string) => document.querySelector(`[data-attr="listing-site-row-${id}"]`) as HTMLElement;

describe("property Promotion › Listing sites", () => {
  it("has the three groups with counts, Automatic first", async () => {
    render(<PropertyListingSitesPanel propertyId="p1" zillow={ZILLOW} />);
    for (const [g, n] of [["automatic", "3"], ["one_click", "6"], ["request_access", "7"]] as const) {
      const tab = document.querySelector(`[data-attr="property-listing-sites-tab-${g}"]`) as HTMLElement;
      expect(tab.textContent).toContain(n);
    }
    expect(row("zillow")).not.toBeNull();
    expect(row("facebook_page")).not.toBeNull();
    expect(row("instagram")).not.toBeNull();
  });

  it("Zillow keeps its per-listing switch; Facebook Page and Instagram say Coming soon with no control", async () => {
    render(<PropertyListingSitesPanel propertyId="p1" zillow={ZILLOW} />);
    fireEvent.click(document.querySelector('[data-attr="property-promotion-zillow-toggle"]') as HTMLElement);
    expect(ZILLOW.onToggle).toHaveBeenCalledWith(false);
    for (const id of ["facebook_page", "instagram"]) {
      expect(row(id).textContent).toContain("Coming soon");
      expect(row(id).querySelector("button, [role=switch]")).toBeNull();
    }
  });

  it("a connected live Facebook Page row shows Posted <date> and a per-listing switch that posts the toggle", async () => {
    status.value = baseStatus({
      channels: [{ id: "facebook_page", availability: "live" }, { id: "instagram", availability: "live" }],
      meta: { configured: true, connected: true, pageName: "Maple", igUsername: "maple", revoked: false },
      posts: [{ propertyId: "p1", channel: "facebook_page", enabled: true, state: "posted", externalId: "1", lastError: null, postedAt: "2026-10-06T20:00:00Z", updatedAt: null }],
    });
    render(<PropertyListingSitesPanel propertyId="p1" zillow={ZILLOW} />);
    await waitFor(() => expect(document.querySelector('[data-attr="property-listing-site-fact-facebook_page"]')?.textContent).toBe("Posted Oct 6"));
    fireEvent.click(document.querySelector('[data-attr="listing-site-toggle-facebook_page"]') as HTMLElement);
    await waitFor(() => {
      const post = (fetch as unknown as { mock: { calls: [string, RequestInit?][] } }).mock.calls.find(([, init]) => init?.method === "POST");
      expect(post?.[0]).toBe("/api/manager/listing-channels/toggle");
      expect(JSON.parse(String(post?.[1]?.body))).toMatchObject({ propertyId: "p1", channel: "facebook_page", enabled: false });
    });
  });

  it("holds with the reason when the listing has no photo, and without a work number says Set up work number", async () => {
    status.value = baseStatus({
      channels: [{ id: "facebook_page", availability: "live" }, { id: "instagram", availability: "live" }],
      meta: { configured: true, connected: true, pageName: "Maple", igUsername: null, revoked: false },
      property: { id: "p1", live: true, holdReasons: ["no_photo"], postTexts: {} },
    });
    render(<PropertyListingSitesPanel propertyId="p1" zillow={ZILLOW} />);
    await waitFor(() => expect(document.querySelector('[data-attr="property-listing-site-fact-facebook_page"]')?.textContent).toBe("Held: no photo"));
    cleanup();
    resetSharedGets();
    status.value = baseStatus({
      channels: [{ id: "facebook_page", availability: "live" }, { id: "instagram", availability: "live" }],
      meta: { configured: true, connected: true, pageName: "Maple", igUsername: null, revoked: false },
      property: { id: "p1", live: true, holdReasons: ["no_work_number"], postTexts: {} },
    });
    render(<PropertyListingSitesPanel propertyId="p1" zillow={ZILLOW} />);
    await waitFor(() => expect(document.querySelector('[data-attr="property-listing-site-fact-facebook_page"]')?.textContent).toBe("Set up work number"));
    expect((document.querySelector('[data-attr="listing-site-toggle-facebook_page"]') as HTMLButtonElement).disabled).toBe(true);
  });

  it("One-click: Copy & open copies the built post (with the work number), opens the site's create page, then offers Posted by me", async () => {
    const open = vi.spyOn(window, "open").mockImplementation(() => null);
    render(<PropertyListingSitesPanel propertyId="p1" zillow={ZILLOW} />);
    fireEvent.click(document.querySelector('[data-attr="property-listing-sites-tab-one_click"]') as HTMLElement);
    await waitFor(() => expect((document.querySelector('[data-attr="listing-site-copy-open-facebook_marketplace"]') as HTMLButtonElement | null)?.disabled).toBe(false));
    expect(row("craigslist")).not.toBeNull();
    fireEvent.click(document.querySelector('[data-attr="listing-site-copy-open-facebook_marketplace"]') as HTMLElement);
    await waitFor(() => expect(copied).toHaveBeenCalledWith("FB POST\nText (206) 555-0100"));
    expect(open).toHaveBeenCalledWith("https://www.facebook.com/marketplace/create/rental", "_blank", "noopener,noreferrer");
    await waitFor(() => expect(document.querySelector('[data-attr="listing-site-mark-facebook_marketplace"]')).not.toBeNull());
    fireEvent.click(document.querySelector('[data-attr="listing-site-mark-facebook_marketplace"]') as HTMLElement);
    await waitFor(() => {
      const post = (fetch as unknown as { mock: { calls: [string, RequestInit?][] } }).mock.calls.find(([url]) => url === "/api/manager/listing-channels/mark-posted");
      expect(JSON.parse(String(post?.[1]?.body))).toMatchObject({ channel: "facebook_marketplace", posted: true });
    });
    open.mockRestore();
  });

  it("One-click is disabled while the listing is held", async () => {
    status.value = baseStatus({ property: { id: "p1", live: true, holdReasons: ["no_photo"], postTexts: {} } });
    render(<PropertyListingSitesPanel propertyId="p1" zillow={ZILLOW} />);
    fireEvent.click(document.querySelector('[data-attr="property-listing-sites-tab-one_click"]') as HTMLElement);
    await waitFor(() => expect(document.querySelector('[data-attr="property-listing-site-fact-roomster"]')?.textContent).toBe("Held: no photo"));
    expect((document.querySelector('[data-attr="listing-site-copy-open-roomster"]') as HTMLButtonElement).disabled).toBe(true);
  });

  it("Request access rows say Coming soon and open a mail draft", async () => {
    const hrefSet = vi.fn();
    Object.defineProperty(window, "location", { configurable: true, value: { set href(v: string) { hrefSet(v); }, get href() { return "http://localhost/"; }, search: "" } });
    render(<PropertyListingSitesPanel propertyId="p1" zillow={ZILLOW} />);
    fireEvent.click(document.querySelector('[data-attr="property-listing-sites-tab-request_access"]') as HTMLElement);
    expect(row("zumper_padmapper").textContent).toContain("Coming soon");
    fireEvent.click(document.querySelector('[data-attr="listing-site-request-zumper_padmapper"]') as HTMLElement);
    expect(hrefSet.mock.calls[0]![0]).toMatch(/^mailto:/);
  });
});

describe("overall Promotion › Listing sites", () => {
  it("shows N of M listings posting per automatic site and the connect state", async () => {
    render(<WorkspaceListingSitesPanel />);
    await waitFor(() => expect(screen.getByText("1 of 2 listings posting")).toBeTruthy());
    expect(row("facebook_page").textContent).toContain("Coming soon");
    fireEvent.click(document.querySelector('[data-attr="promotion-listing-sites-tab-one_click"]') as HTMLElement);
    expect(row("roomster").textContent).toContain("0 of 2 listings posted by me");
  });

  it("counts posted listings for a connected Facebook Page", async () => {
    status.value = baseStatus({
      channels: [{ id: "facebook_page", availability: "live" }, { id: "instagram", availability: "live" }],
      meta: { configured: true, connected: true, pageName: "Maple", igUsername: null, revoked: false },
      posts: [{ propertyId: "p2", channel: "facebook_page", enabled: true, state: "posted", externalId: "1", lastError: null, postedAt: null, updatedAt: null }],
    });
    render(<WorkspaceListingSitesPanel />);
    await waitFor(() => expect(document.querySelector('[data-attr="promotion-listing-site-fact-facebook_page"]')?.textContent).toBe("1 of 2 listings posting"));
  });
});
