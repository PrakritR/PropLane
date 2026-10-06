// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

const toast = vi.hoisted(() => vi.fn());
const copied = vi.hoisted(() => vi.fn(async (_text: string) => true));
const properties = vi.hoisted(() => ({
  byId: {} as Record<string, unknown>,
}));

vi.mock("@/components/providers/app-ui-provider", () => ({
  useConfirm: () => () => Promise.resolve(true),
  useAppUi: () => ({ showToast: toast }),
}));
vi.mock("@/components/portal/workspace-provider", () => ({
  useWorkspaces: () => {
    const active = { id: "w1", name: "Seattle", owned: true, canManageMembers: true, propertyIds: ["p1", "p2", "p3"], propertyLabels: { p1: "4709A", p2: "Maple", p3: "Cedar" } };
    return { workspaces: [active], active };
  },
}));
vi.mock("@/components/portal/integrations-messages-panel", () => ({ ManagerMessageChannelsPanel: ({ onManage }: { onManage?: () => void }) => <button type="button" data-testid="pane-messaging" onClick={onManage} /> }));
vi.mock("@/components/portal/manager-sheet-link-panel", () => ({ ManagerSheetLinkPanel: () => <div data-testid="pane-google" /> }));
vi.mock("@/components/portal/integrations-bookings-panel", () => ({ ManagerBookingChannelsPanel: () => <div data-testid="pane-bookings" /> }));
vi.mock("@/lib/rental-application/data", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/rental-application/data")>()),
  getPropertyById: (id: string) => properties.byId[id],
}));
vi.mock("@/lib/manager-property-links", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/manager-property-links")>()),
  copyTextToClipboard: copied,
}));
vi.mock("@/lib/property-promotion-builtin", () => ({
  resolveBuiltinTextCopy: (property: { id: string }, format: string) => ({ format, plain: `facebook post for ${property.id}`, tone: "x" }),
}));

import { INTEGRATIONS_TABS, ManagerIntegrationsPanel } from "@/components/portal/manager-integrations-panel";
import { FACEBOOK_MARKETPLACE_CREATE_URL, zillowPostingCounts } from "@/components/portal/integrations-posting-panel";

const listing = (id: string, zillow?: boolean) => ({ id, listingSubmission: zillow === undefined ? {} : { syndication: { zillow: { enabled: zillow } } } });

beforeEach(() => {
  properties.byId = { p1: listing("p1", true), p2: listing("p2", false), p3: listing("p3") };
  window.history.replaceState(null, "", "/portal/profile?tab=spreadsheets");
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ feedUrl: "https://proplane.ai/api/feeds/zillow/abc" }) })));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("Settings → Integrations", () => {
  it("renders Messages, Bookings, Posting and Google as four stacked sections on one page, with no tab list", () => {
    render(<ManagerIntegrationsPanel />);
    expect(INTEGRATIONS_TABS.map((t) => t.label)).toEqual(["Messages", "Bookings", "Posting", "Google"]);
    expect(screen.queryByRole("tablist")).toBeNull();
    expect(screen.queryAllByRole("tab")).toHaveLength(0);
    const headings = screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent);
    expect(headings.slice(0, 4)).toEqual(["Messages", "Bookings", "Posting", "Google"]);
    for (const pane of ["pane-messaging", "pane-bookings", "pane-google"]) expect(screen.getByTestId(pane)).toBeTruthy();
    expect(document.querySelector('[data-attr="settings-zillow-row"]')).not.toBeNull();
    for (const id of ["messages", "bookings", "posting", "google"]) {
      expect(document.querySelector(`[data-attr="settings-integrations-section-${id}"]`)).not.toBeNull();
    }
  });

  it("an old &integration=<tab> URL lands on the page scrolled to that section", () => {
    const scroll = vi.fn();
    Element.prototype.scrollIntoView = scroll;
    window.history.replaceState(null, "", "/portal/profile?tab=spreadsheets&integration=google");
    vi.useFakeTimers();
    render(<ManagerIntegrationsPanel />);
    expect(screen.getByTestId("pane-google")).toBeTruthy();
    vi.advanceTimersByTime(10);
    vi.useRealTimers();
    expect(scroll).toHaveBeenCalled();
    expect(scroll.mock.instances[0]).toBe(document.querySelector('[data-attr="settings-integrations-section-google"]'));
  });

  it("with no integration param it does not scroll", () => {
    const scroll = vi.fn();
    Element.prototype.scrollIntoView = scroll;
    vi.useFakeTimers();
    render(<ManagerIntegrationsPanel />);
    vi.advanceTimersByTime(3000);
    vi.useRealTimers();
    expect(scroll).not.toHaveBeenCalled();
  });

  it("Messages hands Manage over to the full Communication settings", () => {
    const open = vi.fn();
    render(<ManagerIntegrationsPanel onOpenCommunication={open} />);
    fireEvent.click(screen.getByTestId("pane-messaging"));
    expect(open).toHaveBeenCalledTimes(1);
  });
});

describe("Integrations → Posting", () => {
  it("counts the listings posting from each listing's Zillow opt-in", () => {
    expect(zillowPostingCounts(["p1", "p2", "p3", "missing"])).toEqual({ posting: 1, total: 3 });
  });

  it("Zillow shows 'N of M listings posting' and copies the feed link", async () => {
    render(<ManagerIntegrationsPanel initialTab="posting" />);
    expect(document.querySelector('[data-attr="settings-zillow-posting-count"]')?.textContent).toBe("1 of 3 listings posting");
    const copy = await waitFor(() => {
      const el = document.querySelector('[data-attr="settings-zillow-feed-copy"]');
      if (!el) throw new Error("feed link not loaded yet");
      return el as HTMLElement;
    });
    fireEvent.click(copy);
    await waitFor(() => expect(copied).toHaveBeenCalledWith("https://proplane.ai/api/feeds/zillow/abc"));
  });

  it("Facebook Marketplace: Copy post copies the chosen listing's post and opens Facebook's rental composer", async () => {
    const open = vi.spyOn(window, "open").mockImplementation(() => null);
    render(<ManagerIntegrationsPanel initialTab="posting" />);
    fireEvent.click(document.querySelector('[data-attr="settings-facebook-copy-post"]') as HTMLElement);
    await waitFor(() => expect(copied).toHaveBeenCalledWith("facebook post for p1"));
    expect(open).toHaveBeenCalledWith(FACEBOOK_MARKETPLACE_CREATE_URL, "_blank", "noopener,noreferrer");
    expect(FACEBOOK_MARKETPLACE_CREATE_URL).toBe("https://www.facebook.com/marketplace/create/rental");
    open.mockRestore();
  });

  it("Facebook Marketplace: the listing dropdown picks which listing the post is built from", async () => {
    const open = vi.spyOn(window, "open").mockImplementation(() => null);
    render(<ManagerIntegrationsPanel initialTab="posting" />);
    fireEvent.click(document.querySelector('[data-attr="settings-facebook-listing"]') as HTMLElement);
    const option = within(screen.getByRole("listbox")).getByRole("option", { name: /Maple/ });
    fireEvent.pointerDown(option, { pointerId: 1, clientX: 10, clientY: 10 });
    fireEvent.pointerUp(option, { pointerId: 1, clientX: 10, clientY: 10 });
    fireEvent.click(document.querySelector('[data-attr="settings-facebook-copy-post"]') as HTMLElement);
    await waitFor(() => expect(copied).toHaveBeenCalledWith("facebook post for p2"));
    open.mockRestore();
  });

  it("does not open Facebook when the copy fails", async () => {
    copied.mockResolvedValueOnce(false);
    const open = vi.spyOn(window, "open").mockImplementation(() => null);
    render(<ManagerIntegrationsPanel initialTab="posting" />);
    fireEvent.click(document.querySelector('[data-attr="settings-facebook-copy-post"]') as HTMLElement);
    await waitFor(() => expect(toast).toHaveBeenCalledWith("Could not copy the post."));
    expect(open).not.toHaveBeenCalled();
    open.mockRestore();
  });

  it("Apartments.com is a Coming soon row with no action", () => {
    render(<ManagerIntegrationsPanel initialTab="posting" />);
    const row = document.querySelector('[data-attr="settings-apartments-row"]') as HTMLElement;
    expect(row.textContent).toContain("Apartments.com");
    expect(row.textContent).toContain("Coming soon");
    expect(row.querySelector("button")).toBeNull();
  });
});
