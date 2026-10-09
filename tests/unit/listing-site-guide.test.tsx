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

import { ListingSiteGuide } from "@/components/portal/listing-site-guide";
import { buildListingPostText } from "@/lib/listing-channels/post-text";
import { LISTING_CHANNEL_DEFS, listingChannelsOrdered } from "@/lib/listing-channels/registry";
import { resetSharedGets } from "@/lib/shared-get-cache";
import type { MockProperty } from "@/data/types";

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
    leadCounts: { craigslist: 2 },
    posts: [],
    property: { id: "p2", live: true, holdReasons: [], postTexts: Object.fromEntries(LISTING_CHANNEL_DEFS.map((d) => [d.id, `POST for ${d.id}`])) },
    ...over,
  };
}

beforeEach(() => {
  resetSharedGets();
  status.value = baseStatus();
  vi.stubGlobal("fetch", vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === "POST") return { ok: true, status: 200, json: async () => ({ ok: true }) };
    return { ok: true, status: 200, json: async () => status.value };
  }));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

const guide = (id: string, extra: Record<string, unknown> = {}) =>
  render(<ListingSiteGuide channelId={id as never} open onClose={() => {}} listings={[{ id: "p1", label: "Alder House" }, { id: "p2", label: "Birch Flats" }]} {...extra} />);

describe("ListingSiteGuide", () => {
  for (const def of listingChannelsOrdered()) {
    it(`${def.id}: renders its own guide, never a Coming soon-only dead end`, async () => {
      guide(def.id);
      expect(await screen.findByText(def.guide.how)).toBeTruthy();
      const dialog = document.querySelector('[data-attr="listing-site-guide"]') as HTMLElement;
      expect(dialog.textContent).not.toBe("Coming soon");
      if (def.posting === "partner_only") {
        expect(screen.getByText("Nothing to post")).toBeTruthy();
        expect(document.querySelector('[data-attr="listing-site-guide-step-2"]')).toBeNull();
        expect(document.querySelector('[data-attr="listing-site-guide-picker"]')).toBeNull();
        return;
      }
      for (const n of [1, 2, 3, 4]) expect(document.querySelector(`[data-attr="listing-site-guide-step-${n}"]`), `${def.id} step ${n}`).not.toBeNull();
      const signup = document.querySelector(`[data-attr="listing-site-signup-${def.id}"]`) as HTMLAnchorElement;
      expect(signup.getAttribute("href")).toBe(def.guide.signupUrl);
      expect(signup.getAttribute("target")).toBe("_blank");
      expect(signup.getAttribute("rel")).toBe("noopener noreferrer");
      expect((document.querySelector(`[data-attr="listing-site-create-${def.id}"]`) as HTMLAnchorElement).getAttribute("href")).toBe(def.guide.createUrl);
      expect(screen.getByText(def.guide.createNote)).toBeTruthy();
      for (const rule of def.guide.rules) expect(screen.getByText(rule)).toBeTruthy();
      expect(screen.getByText("Keep the account safe")).toBeTruthy();
    });
  }

  it("workspace mode defaults the picker to the newest listing and shows its post, photos link and lead count", async () => {
    guide("craigslist");
    await waitFor(() => expect(document.querySelector('[data-attr="listing-site-guide-post"]')?.textContent).toBe("POST for craigslist"));
    expect(document.querySelector('[data-attr="listing-site-guide-picker"]')?.textContent).toContain("Birch Flats");
    expect(screen.getByText("2 leads from this site")).toBeTruthy();
    const photos = document.querySelector('[data-attr="listing-site-photos-craigslist"]') as HTMLAnchorElement;
    expect(photos.getAttribute("href")).toBe("/api/manager/listing-channels/photos?propertyId=p2");
    expect(photos.hasAttribute("download")).toBe(true);
  });

  it("shows 0 leads when the site has none, Copy post copies the text, and Mark as posted sends the ad link then offers Undo", async () => {
    guide("roomster");
    await waitFor(() => expect((document.querySelector('[data-attr="listing-site-copy-roomster"]') as HTMLButtonElement).disabled).toBe(false));
    expect(screen.getByText("0 leads from this site")).toBeTruthy();
    fireEvent.click(document.querySelector('[data-attr="listing-site-copy-roomster"]') as HTMLElement);
    await waitFor(() => expect(copied).toHaveBeenCalledWith("POST for roomster"));
    fireEvent.change(document.querySelector('[data-attr="listing-site-posted-url-roomster"]') as HTMLElement, { target: { value: "https://roomster.com/ad/1" } });
    fireEvent.click(document.querySelector('[data-attr="listing-site-mark-roomster"]') as HTMLElement);
    await waitFor(() => {
      const post = (fetch as unknown as { mock: { calls: [string, RequestInit?][] } }).mock.calls.find(([url]) => url === "/api/manager/listing-channels/mark-posted");
      expect(JSON.parse(String(post?.[1]?.body))).toMatchObject({ channel: "roomster", posted: true, propertyId: "p2", postedUrl: "https://roomster.com/ad/1" });
    });
  });

  it("a posted site shows Posted by you · date with an Undo action", async () => {
    status.value = baseStatus({
      posts: [{ propertyId: "p2", channel: "craigslist", enabled: true, state: "posted_by_me", externalId: null, lastError: null, postedAt: "2026-10-08T20:00:00Z", updatedAt: null }],
    });
    guide("craigslist");
    await waitFor(() => expect(screen.getByText("Posted by you · Oct 8")).toBeTruthy());
    expect(screen.getByRole("button", { name: "Undo" })).toBeTruthy();
  });

  it("a copy-and-post site shows the hold reason and keeps Copy disabled", async () => {
    status.value = baseStatus({ property: { id: "p2", live: true, holdReasons: ["no_photo", "no_work_number"], postTexts: {} } });
    guide("craigslist");
    await waitFor(() => expect(document.querySelector('[data-attr="listing-site-guide-held"]')).not.toBeNull());
    const held = document.querySelector('[data-attr="listing-site-guide-held"]') as HTMLElement;
    expect(held.textContent).toContain("Held: no photo");
    expect(held.textContent).toContain("Set up work number");
    expect((document.querySelector('[data-attr="listing-site-copy-craigslist"]') as HTMLButtonElement).disabled).toBe(true);
  });

  it("Zillow's guide lists every listing's status and the held reason", async () => {
    status.value = baseStatus({ property: { id: "p2", live: true, holdReasons: ["no_photo"], postTexts: {} } });
    guide("zillow");
    await waitFor(() => expect(screen.getAllByText("Held: no photo").length).toBeGreaterThan(0));
    const table = document.querySelector('[data-attr="listing-site-guide-status-table"]') as HTMLElement;
    expect(table.textContent).toContain("Alder House");
    expect(table.textContent).toContain("Posting");
  });

  it("Zillow with the feed approved hides the by-hand steps and keeps the status table", async () => {
    status.value = baseStatus({ zillowFeedApproved: true });
    guide("zillow");
    await waitFor(() => expect(document.querySelector('[data-attr="listing-site-guide-status-table"]')).not.toBeNull());
    expect(document.querySelector('[data-attr="listing-site-guide-steps"]')).toBeNull();
    expect(document.querySelector('[data-attr="listing-site-guide-step-1"]')).toBeNull();
    const zillowDef = LISTING_CHANNEL_DEFS.find((d) => d.id === "zillow")!;
    expect(screen.getByText(zillowDef.guide.howApproved!)).toBeTruthy();
  });

  it("Zillow with the feed not approved still shows the by-hand steps", async () => {
    status.value = baseStatus({ zillowFeedApproved: false });
    guide("zillow");
    await waitFor(() => expect(document.querySelector('[data-attr="listing-site-guide-step-1"]')).not.toBeNull());
    expect(document.querySelector('[data-attr="listing-site-guide-status-table"]')).not.toBeNull();
  });
});

describe("the ?src tag", () => {
  it("every channel's post carries its own tagged link", () => {
    const property = { id: "prop-1", title: "House", address: "1 Main St", beds: 1, baths: 1, listingSubmission: { v: 1, rooms: [], quickFacts: [], entireHomeMonthlyRent: 1000, listingPlaceCategoryId: "entire_home" } } as unknown as MockProperty;
    for (const def of LISTING_CHANNEL_DEFS) {
      const built = buildListingPostText({ property, origin: "https://proplane.ai", contact: { phone: "(206) 555-0100", email: null }, channel: def.id, attribution: false });
      expect(built.ok).toBe(true);
      if (built.ok) expect(built.text).toContain(`/rent/listings/prop-1?src=${def.id}`);
    }
  });
});
