// @vitest-environment jsdom
/**
 * Evidence harness for "each listing site is a record page, with a clearer
 * listing picker" (2026-10-09). Renders the real `ListingSiteRecord` tabs and,
 * when EVIDENCE_DIR is set, dumps the markup for screenshotting.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { mkdirSync, writeFileSync } from "node:fs";

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

const OUT = process.env.EVIDENCE_DIR ?? "";

function writeShot(name: string, caption: string, body: string) {
  if (!OUT) return;
  mkdirSync(OUT, { recursive: true });
  writeFileSync(
    `${OUT}/${name}.html`,
    `<!doctype html><html lang="en" class="h-full antialiased" data-theme="light"><head><meta charset="utf-8"><link rel="stylesheet" href="./app.css"></head>
<body class="min-h-full overflow-x-clip bg-background text-foreground">
<div style="max-width:1100px;margin:16px auto;padding:0 16px">
<p style="font:600 13px/1.5 system-ui;color:#475569;margin:0 0 10px;white-space:pre-line">${caption}</p>
${body}</div></body></html>`,
  );
}

function baseStatus(over: Record<string, unknown> = {}) {
  return {
    workspaceId: "w1",
    canManage: true,
    schemaReady: true,
    zillowFeedApproved: false,
    channels: [{ id: "facebook_page", availability: "coming_soon" }],
    meta: { configured: false, connected: false, pageName: null, igUsername: null, revoked: false },
    workContact: { phone: "(206) 555-0100", email: "hello@proplane.test" },
    posts: [{ propertyId: "p1", channel: "craigslist", enabled: true, state: "posted_by_me", externalId: null, lastError: null, postedAt: "2026-10-08T20:00:00Z", postedUrl: "https://craigslist.org/ad/1", updatedAt: null }],
    property: { id: "p1", live: true, holdReasons: [], postTexts: { craigslist: "Private room in a 10-bedroom house · 5257 Brooklyn Ave NE\n\n$1,100/mo, utilities included. Furnished, laundry on site, 10 min to UW.\n\nDetails and photos: https://proplane.ai/l/p1?src=craigslist\nText (206) 555-0100" } },
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

describe("evidence · a listing site is a record page", () => {
  it("Overview counts the workspace and says how the site works", async () => {
    const view = render(<ListingSiteRecord channelId="craigslist" tab="overview" />);
    await waitFor(() => expect(q("listing-site-stat-posted")?.textContent).toContain("1 of 3"));
    await waitFor(() => expect(q("listing-site-stat-leads")?.textContent).toContain("2"));
    writeShot(
      "listing-site-overview",
      "Settings → Listing sites → Craigslist → Overview. The site is now its own record page: posted / ready / leads counted across the workspace, with how it works, what it costs and its rules as fact cards.",
      view.container.innerHTML,
    );
  });

  it("Listings lists one row per non-draft listing with its plain fact", async () => {
    const view = render(<ListingSiteRecord channelId="craigslist" tab="listings" />);
    await waitFor(() => expect(q("listing-site-listing-p1")).not.toBeNull());
    expect(q("listing-site-listing-p1")?.textContent).toContain("Posted Oct 8");
    expect(q("listing-site-listing-p3")?.textContent).toContain("Held: no photo");
    writeShot(
      "listing-site-listings",
      "Craigslist → Listings. Every live listing in the workspace with its own fact — posted and when, not posted yet, or held with the reason. A draft is never offered.",
      view.container.innerHTML,
    );
  });

  it("Post opens the picker grouped Ready to post / Held, with the reason beside the name", async () => {
    const view = render(<ListingSiteRecord channelId="craigslist" tab="post" />);
    await waitFor(() => expect(q("listing-site-guide-post")?.textContent).toContain("5257 Brooklyn Ave NE"));
    const closed = view.container.innerHTML;
    fireEvent.click(document.querySelector('[data-attr="listing-site-guide-picker"] button, button[data-attr="listing-site-guide-picker"]') as HTMLElement);
    await waitFor(() => expect(screen.getByText("Ready to post")).toBeTruthy());
    expect(screen.getByText("Held")).toBeTruthy();
    expect(screen.getByText("Proof Term Long · No photo")).toBeTruthy();
    expect(screen.queryByText(/Draft House/)).toBeNull();
    // The open menu is portalled out of the card and positioned off a measured
    // rect jsdom cannot produce, so the shot re-frames just the listbox.
    const listbox = document.querySelector('[role="listbox"]')!;
    writeShot(
      "listing-site-post-picker",
      "Craigslist → Post. The listing picker names each house the same way everywhere — house name (or short street) plus its room count — and groups Ready to post before Held, with the hold reason beside the name instead of only after the pick. Drafts are not offered.",
      `<p style="font:600 12px system-ui;color:#475569;margin:14px 0 6px">Post tab</p>${closed}
<p style="font:600 12px system-ui;color:#475569;margin:22px 0 6px">The Listing picker, open</p>
<div style="max-width:420px;border:1px solid #e2e8f0;border-radius:10px;overflow:hidden;background:#fff">${listbox.outerHTML}</div>`,
    );
  });

  it("Leads lists the tours and applications that came from the site", async () => {
    const view = render(<ListingSiteRecord channelId="craigslist" tab="leads" />);
    await waitFor(() => expect(q("listing-site-lead-tour")).not.toBeNull());
    writeShot(
      "listing-site-leads",
      "Craigslist → Leads. Tours and applications attributed to this site, each opening its own record.",
      view.container.innerHTML,
    );
  });
});
