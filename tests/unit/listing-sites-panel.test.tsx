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
  useWorkspaces: () => ({ workspaces: [], active: { id: "w1", propertyIds: ["p1", "p2"], propertyLabels: { p1: "Alder House", p2: "Birch Flats" } } }),
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
    zillowFeedApproved: false,
    channels: [
      { id: "facebook_page", availability: "coming_soon" },
      { id: "instagram", availability: "coming_soon" },
    ],
    meta: { configured: false, connected: false, pageName: null, igUsername: null, revoked: false },
    workContact: { phone: "(206) 555-0100", email: null },
    posts: [],
    property: { id: "p1", live: true, holdReasons: [], postTexts: { facebook_marketplace: "FB POST\nText (206) 555-0100", roomster: "ROOMSTER POST", craigslist: "CL POST ?src=craigslist" } },
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

const rows = () => Array.from(document.querySelectorAll('[data-attr^="listing-site-row-"]')) as HTMLElement[];
const rowByName = (name: string) => rows().find((r) => r.textContent?.includes(name)) as HTMLElement;

describe("property Promotion › Listing sites", () => {
  it("is one flat list of 16 sites bound to the listing, with no sub-tabs and no Listed with PropLane row", async () => {
    render(<PropertyListingSitesPanel propertyId="p1" zillow={ZILLOW} />);
    expect(rows()).toHaveLength(16);
    expect(document.querySelector('[data-attr^="property-listing-sites-tab-"]')).toBeNull();
    expect(screen.queryByText("Show Listed with PropLane")).toBeNull();
    expect(rows()[0]!.textContent).toContain("Zillow Rental Network");
    // Each row's one data-attr is its own name, so a funnel can tell WHICH site was opened.
    const named = rows().map((r) => r.getAttribute("data-attr"));
    expect(named).toContain("listing-site-row-zillow");
    expect(new Set(named).size).toBe(16);
  });

  it("a row opens that site's guide bound to the listing, with no picker; Zillow keeps its per-listing switch", async () => {
    render(<PropertyListingSitesPanel propertyId="p1" zillow={ZILLOW} />);
    fireEvent.click(rowByName("Zillow Rental Network"));
    await waitFor(() => expect(document.querySelector('[data-attr="property-promotion-zillow-toggle"]')).not.toBeNull());
    expect(document.querySelector('[data-attr="listing-site-guide-picker"]')).toBeNull();
    fireEvent.click(document.querySelector('[data-attr="property-promotion-zillow-toggle"]') as HTMLElement);
    expect(ZILLOW.onToggle).toHaveBeenCalledWith(false);
  });

  it("Facebook Page and Instagram say Coming soon · post by hand for now with no control while Meta is not live", async () => {
    render(<PropertyListingSitesPanel propertyId="p1" zillow={ZILLOW} />);
    for (const id of ["facebook_page", "instagram"]) {
      expect(document.querySelector(`[data-attr="property-listing-site-fact-${id}"]`)?.textContent).toBe("Coming soon · post by hand for now");
    }
    expect(document.querySelector("[role=switch]")).toBeNull();
  });

  it("a connected live Facebook Page row shows Posted <date> and its guide carries the on/off switch that posts the toggle", async () => {
    status.value = baseStatus({
      channels: [{ id: "facebook_page", availability: "live" }, { id: "instagram", availability: "live" }],
      meta: { configured: true, connected: true, pageName: "Maple", igUsername: "maple", revoked: false },
      posts: [{ propertyId: "p1", channel: "facebook_page", enabled: true, state: "posted", externalId: "1", lastError: null, postedAt: "2026-10-06T20:00:00Z", updatedAt: null }],
    });
    render(<PropertyListingSitesPanel propertyId="p1" zillow={ZILLOW} />);
    await waitFor(() => expect(document.querySelector('[data-attr="property-listing-site-fact-facebook_page"]')?.textContent).toBe("Posted Oct 6"));
    fireEvent.click(rowByName("Facebook Page"));
    await waitFor(() => expect(document.querySelector('[data-attr="listing-site-toggle-facebook_page"]')).not.toBeNull());
    fireEvent.click(document.querySelector('[data-attr="listing-site-toggle-facebook_page"]') as HTMLElement);
    await waitFor(() => {
      const post = (fetch as unknown as { mock: { calls: [string, RequestInit?][] } }).mock.calls.find(([, init]) => init?.method === "POST");
      expect(post?.[0]).toBe("/api/manager/listing-channels/toggle");
      expect(JSON.parse(String(post?.[1]?.body))).toMatchObject({ propertyId: "p1", channel: "facebook_page", enabled: false });
    });
  });

  it("holds with the reason when the listing has no photo", async () => {
    status.value = baseStatus({
      channels: [{ id: "facebook_page", availability: "live" }, { id: "instagram", availability: "live" }],
      meta: { configured: true, connected: true, pageName: "Maple", igUsername: null, revoked: false },
      property: { id: "p1", live: true, holdReasons: ["no_photo"], postTexts: {} },
    });
    render(<PropertyListingSitesPanel propertyId="p1" zillow={ZILLOW} />);
    await waitFor(() => expect(document.querySelector('[data-attr="property-listing-site-fact-facebook_page"]')?.textContent).toBe("Held: no photo"));
  });

  it("a manual site's row says Not posted yet, then Posted by you · date once marked", async () => {
    render(<PropertyListingSitesPanel propertyId="p1" zillow={ZILLOW} />);
    expect(document.querySelector('[data-attr="property-listing-site-fact-craigslist"]')?.textContent).toBe("Not posted yet");
    cleanup();
    resetSharedGets();
    status.value = baseStatus({
      posts: [{ propertyId: "p1", channel: "craigslist", enabled: true, state: "posted_by_me", externalId: null, lastError: null, postedAt: "2026-10-08T20:00:00Z", updatedAt: null }],
    });
    render(<PropertyListingSitesPanel propertyId="p1" zillow={ZILLOW} />);
    await waitFor(() => expect(document.querySelector('[data-attr="property-listing-site-fact-craigslist"]')?.textContent).toBe("Posted by you · Oct 8"));
  });
});

describe("overall Promotion › Listing sites", () => {
  it("renders 16 rows in reach order with no toggle, no sub-tabs and no Listed with PropLane row", async () => {
    render(<WorkspaceListingSitesPanel />);
    expect(rows()).toHaveLength(16);
    expect(rows()[0]!.textContent).toContain("Zillow Rental Network");
    expect(rows()[15]!.textContent).toContain("Instagram");
    expect(document.querySelector("[role=switch]")).toBeNull();
    expect(document.querySelector('[data-attr^="promotion-listing-sites-tab-"]')).toBeNull();
    expect(screen.queryByText("Show Listed with PropLane")).toBeNull();
  });

  it("states each mode's plain fact", async () => {
    render(<WorkspaceListingSitesPanel />);
    await waitFor(() =>
      expect(document.querySelector('[data-attr="promotion-listing-site-fact-zillow"]')?.textContent).toBe(
        "Posts for you once Zillow approves · 1 of 2 listings by hand",
      ),
    );
    expect(rowByName("Facebook Page").textContent).toContain("Coming soon · post by hand for now");
    expect(rowByName("Craigslist").textContent).toContain("Not posted yet");
    expect(rowByName("Apartment List").textContent).toContain("Partner feed only");
  });

  // The row and the guide it opens have to agree: before approval neither may claim the feed posts.
  it("the Zillow row waits for the approval its guide waits for", async () => {
    status.value = baseStatus({ zillowFeedApproved: true });
    render(<WorkspaceListingSitesPanel />);
    await waitFor(() =>
      expect(document.querySelector('[data-attr="promotion-listing-site-fact-zillow"]')?.textContent).toBe(
        "Posts for you · 1 of 2 listings",
      ),
    );
  });

  it("counts posted listings for a connected, live Facebook Page", async () => {
    status.value = baseStatus({
      channels: [{ id: "facebook_page", availability: "live" }, { id: "instagram", availability: "live" }],
      meta: { configured: true, connected: true, pageName: "Maple", igUsername: null, revoked: false },
      posts: [{ propertyId: "p2", channel: "facebook_page", enabled: true, state: "posted", externalId: "1", lastError: null, postedAt: null, updatedAt: null }],
    });
    render(<WorkspaceListingSitesPanel />);
    await waitFor(() => expect(document.querySelector('[data-attr="promotion-listing-site-fact-facebook_page"]')?.textContent).toBe("Posts for you · 1 of 2 listings"));
  });

  it("shows Posted by you · date when any listing was posted by hand", async () => {
    status.value = baseStatus({
      posts: [{ propertyId: "p2", channel: "roomster", enabled: true, state: "posted_by_me", externalId: null, lastError: null, postedAt: "2026-10-08T20:00:00Z", updatedAt: null }],
    });
    render(<WorkspaceListingSitesPanel />);
    await waitFor(() => expect(rowByName("Roomster").textContent).toContain("Posted by you · Oct 8"));
  });
});
