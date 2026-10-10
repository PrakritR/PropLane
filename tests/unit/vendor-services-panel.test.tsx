// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

const toast = vi.hoisted(() => vi.fn());
const copied = vi.hoisted(() => vi.fn(async (_text: string) => true));
const accounts = vi.hoisted(() => ({ value: [] as Record<string, unknown>[] }));

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
  getPropertyById: (id: string) => ({ id, zip: id === "p1" ? "98105" : "98103", neighborhood: "Seattle", listingSubmission: { city: id === "p1" ? "Seattle" : "Shoreline", zip: id === "p1" ? "98105" : "98155" } }),
}));

import { VendorServicesPanel } from "@/components/portal/vendor-services-panel";
import { resetSharedGets } from "@/lib/shared-get-cache";
import { marketplacesForService } from "@/lib/vendor-marketplaces/registry";

const read = (rel: string) => readFileSync(join(process.cwd(), rel), "utf8");
const rowIds = () => [...document.querySelectorAll('[data-attr^="vendor-marketplace-row-"]')].map((n) => n.getAttribute("data-attr")!.replace("vendor-marketplace-row-", ""));

function pick(label: string, option: string) {
  fireEvent.click(screen.getByRole("button", { name: label, expanded: false }));
  const listbox = screen.getByRole("listbox");
  const target = within(listbox).getByText(option);
  fireEvent.pointerDown(target, { pointerId: 1, clientX: 10, clientY: 10 });
  fireEvent.pointerUp(target, { pointerId: 1, clientX: 10, clientY: 10 });
}

beforeEach(() => {
  resetSharedGets();
  accounts.value = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "POST" || init?.method === "DELETE") return { ok: true, status: 200, json: async () => ({ ok: true }) };
      return { ok: true, status: 200, json: async () => ({ workspaceId: "w1", canManage: true, accounts: accounts.value }) };
    }),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("VendorServicesPanel", () => {
  it("defaults to Handyman and draws one row per marketplace that offers it", async () => {
    render(<VendorServicesPanel />);
    expect(rowIds()).toEqual(marketplacesForService("handyman").map((d) => d.id));
    expect(document.querySelector('[data-attr="vendor-services-service-picker"]')?.textContent).toContain("Handyman");
    expect(await screen.findAllByText("No account yet")).not.toHaveLength(0);
  });

  it("hides marketplaces that do not offer the chosen service", () => {
    render(<VendorServicesPanel />);
    expect(rowIds()).toContain("taskrabbit");
    pick("Service", "Locksmith");
    expect(rowIds()).toEqual(marketplacesForService("locksmith").map((d) => d.id));
    expect(rowIds()).not.toContain("taskrabbit");
    expect(rowIds()).not.toContain("handy");
  });

  it("Search opens the marketplace in a new tab with the chosen house's ZIP", () => {
    render(<VendorServicesPanel />);
    const link = document.querySelector('[data-attr="vendor-marketplace-search-yelp"]') as HTMLAnchorElement;
    expect(link.getAttribute("href")).toBe("https://www.yelp.com/search?find_desc=Handyman&find_loc=98105");
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toContain("noopener");
    pick("House", "Birch Flats");
    expect((document.querySelector('[data-attr="vendor-marketplace-search-yelp"]') as HTMLAnchorElement).getAttribute("href")).toBe(
      "https://www.yelp.com/search?find_desc=Handyman&find_loc=98155",
    );
  });

  it("shows an added account on its row", async () => {
    accounts.value = [{ marketplace: "yelp", accountLabel: "pm@example.com", profileUrl: null, connectedAt: "2026-10-08T19:00:00Z" }];
    render(<VendorServicesPanel />);
    await waitFor(() => expect(document.querySelector('[data-attr="vendor-marketplace-fact-yelp"]')?.textContent).toBe("Account added · Oct 8Added"));
    expect(document.querySelector('[data-attr="vendor-marketplace-fact-thumbtack"]')?.textContent).toBe("No account yet");
  });

  it("a row opens the guide: account, copy post, post page, search, and a disabled Direct connection fact", async () => {
    render(<VendorServicesPanel />);
    fireEvent.click(document.querySelector('[data-attr="vendor-marketplace-row-thumbtack"]')!);
    const guide = await waitFor(() => {
      const el = document.querySelector('[data-attr="vendor-marketplace-guide"]');
      expect(el).not.toBeNull();
      return el as HTMLElement;
    });
    expect(guide.querySelector('[data-attr="vendor-marketplace-guide-direct"]')?.textContent).toBe("Direct connectionComing soon");
    expect(guide.querySelector('[data-attr="vendor-marketplace-guide-post"]')?.textContent).toContain("Handyman needed in Seattle 98105");
    expect(guide.querySelector('[data-attr="vendor-marketplace-post-thumbtack"]')?.getAttribute("href")).toBe("https://www.thumbtack.com/k/handyman/near-me/");
    expect(guide.querySelector('[data-attr="vendor-marketplace-guide-search-thumbtack"]')?.getAttribute("target")).toBe("_blank");
    fireEvent.click(guide.querySelector('[data-attr="vendor-marketplace-copy-thumbtack"]')!);
    await waitFor(() => expect(copied).toHaveBeenCalledWith(expect.stringContaining("Handyman needed")));
  });

  it("Add account saves the label and link through the route", async () => {
    render(<VendorServicesPanel />);
    fireEvent.click(document.querySelector('[data-attr="vendor-marketplace-row-bark"]')!);
    fireEvent.click(await waitFor(() => {
      const b = document.querySelector('[data-attr="vendor-marketplace-add-account-bark"]');
      expect(b).not.toBeNull();
      return b!;
    }));
    const label = await waitFor(() => {
      const el = document.querySelector('[data-attr="vendor-marketplace-account-label-bark"]');
      expect(el).not.toBeNull();
      return el as HTMLInputElement;
    });
    fireEvent.change(label, { target: { value: "pm@example.com" } });
    fireEvent.change(document.querySelector('[data-attr="vendor-marketplace-account-url-bark"]')!, { target: { value: "https://www.bark.com/pm" } });
    fireEvent.click(document.querySelector('[data-attr="vendor-marketplace-account-save-bark"]')!);
    await waitFor(() => {
      const post = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.find(([, init]) => (init as RequestInit | undefined)?.method === "POST");
      expect(post).toBeTruthy();
      expect(JSON.parse((post![1] as RequestInit).body as string)).toMatchObject({ marketplace: "bark", accountLabel: "pm@example.com", profileUrl: "https://www.bark.com/pm", workspaceId: "w1" });
    });
  });

  it("has no Badge or pill on the rows or the guide", () => {
    for (const file of ["vendor-services-panel.tsx", "vendor-marketplace-guide.tsx"]) {
      const source = read(`src/components/portal/${file}`);
      expect(source).not.toMatch(/<Badge\b/);
      expect(source).not.toMatch(/rounded-full[^"]*\b(bg-(primary|accent|emerald|sky|amber)[^"]*)\b[^"]*px-/);
    }
  });
});
