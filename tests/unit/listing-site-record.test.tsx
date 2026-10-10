// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const toast = vi.hoisted(() => vi.fn());
const copied = vi.hoisted(() => vi.fn(async (_text: string) => true));
const navigate = vi.hoisted(() => vi.fn());
const data = vi.hoisted(() => ({ status: {} as Record<string, unknown>, leads: [] as unknown[] }));

vi.mock("@/components/providers/app-ui-provider", () => ({
  useConfirm: () => () => Promise.resolve(true),
  useAppUi: () => ({ showToast: toast }),
}));
vi.mock("@/components/portal/workspace-provider", () => ({
  useWorkspaces: () => ({ workspaces: [], active: { id: "w1", propertyIds: ["p1", "p2", "p3"], propertyLabels: {} } }),
}));
vi.mock("@/lib/portal-nav-client", () => ({ usePortalNavigate: () => navigate }));
vi.mock("@/lib/manager-property-links", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/manager-property-links")>()),
  copyTextToClipboard: copied,
}));
vi.mock("@/lib/rental-application/data", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/rental-application/data")>()),
  getPropertyById: () => null,
}));

import { ListingSiteRecord } from "@/components/portal/listing-site-record";
import { resetSharedGets } from "@/lib/shared-get-cache";

function baseStatus(over: Record<string, unknown> = {}) {
  return {
    workspaceId: "w1",
    canManage: true,
    schemaReady: true,
    zillowFeedApproved: false,
    channels: [{ id: "facebook_page", availability: "coming_soon" }],
    meta: { configured: false, connected: false, pageName: null, igUsername: null, revoked: false },
    workContact: { phone: "(206) 555-0100", email: null },
    posts: [{ propertyId: "p1", channel: "craigslist", enabled: true, state: "posted_by_me", externalId: null, lastError: null, postedAt: "2026-10-08T20:00:00Z", postedUrl: "https://craigslist.org/ad/1", updatedAt: null }],
    property: { id: "p1", live: true, holdReasons: [], postTexts: { craigslist: "CL POST\n\nDetails and photos: https://proplane.ai/l/p1?src=craigslist\nText (206) 555-0100" } },
    listings: [
      { id: "p1", status: "live", name: "5257 Brooklyn Ave", roomCount: 10, holdReasons: [] },
      { id: "p2", status: "live", name: "Birch Flats", roomCount: 9, holdReasons: [] },
      { id: "p3", status: "live", name: "Proof Term Long", roomCount: 0, holdReasons: ["no_photo"] },
      { id: "p4", status: "draft", name: "Draft House", roomCount: 3, holdReasons: [] },
    ],
    ...over,
  };
}

beforeEach(() => {
  resetSharedGets();
  window.localStorage.clear();
  data.status = baseStatus();
  data.leads = [
    { kind: "tour", id: "t1", propertyId: "p1", name: "Maya Chen", at: "2026-10-10T22:00:00Z", bucket: "pending" },
    { kind: "application", id: "AXIS-1", propertyId: "p2", name: "Diego Morales", at: "2026-10-09T10:00:00Z", bucket: "approved" },
  ];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (init?.method === "POST") return { ok: true, status: 200, json: async () => ({ ok: true }) };
    if (url.includes("/leads?")) return { ok: true, status: 200, json: async () => ({ leads: data.leads }) };
    return { ok: true, status: 200, json: async () => data.status };
  }));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

const q = (attr: string) => document.querySelector(`[data-attr="${attr}"]`) as HTMLElement | null;

describe("ListingSiteRecord", () => {
  it("Overview: the mode is the subtitle, how/cost/rules are fact cards, stat tiles count the workspace", async () => {
    render(<ListingSiteRecord channelId="craigslist" tab="overview" />);
    await waitFor(() => expect(q("listing-site-stat-posted")?.textContent).toContain("1 of 3"));
    expect(q("listing-site-stat-ready")?.textContent).toContain("2");
    await waitFor(() => expect(q("listing-site-stat-leads")?.textContent).toContain("2"));
    expect(q("listing-site-card-how")?.textContent).toContain("Craigslist forbids posting software");
    expect(q("listing-site-card-how")?.textContent).toContain("Copy and post");
    expect(q("listing-site-guide-rules")?.textContent).toContain("Never post the same unit twice");
    // The sentence under the title is gone: the old data-attr is not rendered anywhere.
    expect(q("listing-site-guide-how")).toBeNull();
  });

  it("Listings: one row per non-draft listing with its plain fact", async () => {
    render(<ListingSiteRecord channelId="craigslist" tab="listings" />);
    await waitFor(() => expect(q("listing-site-listing-p1")).not.toBeNull());
    expect(q("listing-site-listing-p4")).toBeNull();
    expect(q("listing-site-listing-p1")?.textContent).toContain("5257 Brooklyn Ave · 10 rooms");
    expect(q("listing-site-listing-p1")?.textContent).toContain("Posted Oct 8");
    expect(q("listing-site-listing-p2")?.textContent).toContain("Not posted yet");
    expect(q("listing-site-listing-p3")?.textContent).toContain("Held: no photo");
  });

  it("Post: the picker groups Ready to post then Held with the reason, and the post text is copyable", async () => {
    render(<ListingSiteRecord channelId="craigslist" tab="post" />);
    await waitFor(() => expect(q("listing-site-guide-post")?.textContent).toContain("CL POST"));
    expect(q("listing-site-tagged-link")?.textContent).toBe("https://proplane.ai/l/p1?src=craigslist");
    fireEvent.click(document.querySelector('[data-attr="listing-site-guide-picker"] button, button[data-attr="listing-site-guide-picker"]') as HTMLElement);
    await waitFor(() => expect(screen.getByText("Ready to post")).toBeTruthy());
    expect(screen.getByText("Held")).toBeTruthy();
    expect(screen.getAllByText("5257 Brooklyn Ave · 10 rooms").length).toBeGreaterThan(0);
    expect(screen.getByText("Proof Term Long · No photo")).toBeTruthy();
    expect(screen.queryByText(/Draft House/)).toBeNull();
    fireEvent.click(document.querySelector('[data-attr="listing-site-copy-craigslist"]') as HTMLElement);
    await waitFor(() => expect(copied).toHaveBeenCalled());
    expect(String(copied.mock.calls[0]![0])).toContain("CL POST");
  });

  it("Leads: lists tours and applications that link to their record pages; empty state otherwise", async () => {
    render(<ListingSiteRecord channelId="craigslist" tab="leads" />);
    await waitFor(() => expect(q("listing-site-lead-tour")).not.toBeNull());
    fireEvent.click(q("listing-site-lead-tour")!);
    expect(navigate).toHaveBeenCalledWith("/portal/tours/pending/t1");
    fireEvent.click(q("listing-site-lead-application")!);
    expect(navigate).toHaveBeenLastCalledWith("/portal/applications/approved/AXIS-1");
    cleanup();
    resetSharedGets();
    data.leads = [];
    render(<ListingSiteRecord channelId="craigslist" tab="leads" />);
    await waitFor(() => expect(q("listing-site-leads-empty")?.textContent).toContain("No leads from Craigslist yet."));
  });

  it("a partner-only site is Overview only", async () => {
    render(<ListingSiteRecord channelId="apartment_list" tab="overview" />);
    expect(q("listing-site-overview")).not.toBeNull();
    expect(q("listing-site-stat-leads")).toBeNull();
    expect(q("listing-site-card-how")?.textContent).toContain("Partner feed only");
  });

  it("a non-owner gets no write action in a row's menu", async () => {
    data.status = baseStatus({ canManage: false });
    render(<ListingSiteRecord channelId="craigslist" tab="listings" />);
    await waitFor(() => expect(q("listing-site-listing-p2")).not.toBeNull());
    expect(q("listing-site-mark-craigslist")).toBeNull();
  });
});
