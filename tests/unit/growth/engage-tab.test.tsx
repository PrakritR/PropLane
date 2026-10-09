// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const listEngage = vi.fn();
const patchEngage = vi.fn();
vi.mock("@/lib/growth/client", () => ({
  growthApi: {
    listEngage: (...a: unknown[]) => listEngage(...a),
    patchEngage: (...a: unknown[]) => patchEngage(...a),
    buildEngageNow: vi.fn(),
    listWatchlist: async () => ({ ok: true, data: [] }),
    listKeywords: async () => ({ ok: true, data: [] }),
    addWatch: vi.fn(),
    addKeyword: vi.fn(),
    deleteWatch: vi.fn(),
    deleteKeyword: vi.fn(),
  },
}));

import { GrowthEngageTab } from "@/components/portal/growth-engage-tab";
import { GROWTH_TABS } from "@/components/portal/growth-admin-client";

const item = (o: Record<string, unknown> = {}) => ({
  id: "11111111-1111-4111-8111-111111111111",
  forDate: "2026-10-09",
  source: "reddit",
  platform: "reddit",
  target: "r/Landlord: Late rent again",
  url: "https://www.reddit.com/r/Landlord/comments/a/t/",
  why: "Asks how to handle late rent",
  draft: "Put the late fee in the lease.",
  status: "open",
  evidence: {},
  createdAt: "",
  ...o,
});

beforeEach(() => {
  listEngage.mockReset();
  patchEngage.mockReset();
});
afterEach(() => cleanup());

describe("Engage list tab", () => {
  it("is registered between Calendar and Accounts", () => {
    const i = GROWTH_TABS.indexOf("engage");
    expect(GROWTH_TABS[i + 1]).toBe("accounts");
    expect(i).toBeGreaterThan(-1);
  });

  it("renders rows and PATCHes done", async () => {
    listEngage.mockResolvedValue({ ok: true, data: { date: "2026-10-09", items: [item()] } });
    patchEngage.mockResolvedValue({ ok: true, data: item({ status: "done" }) });
    render(<GrowthEngageTab />);
    await waitFor(() => expect(screen.getAllByText("r/Landlord: Late rent again").length).toBe(1));
    expect(screen.getByText("Asks how to handle late rent")).toBeTruthy();
    fireEvent.click(document.querySelector('[data-attr="growth-engage-done-11111111-1111-4111-8111-111111111111"]')!);
    await waitFor(() => expect(patchEngage).toHaveBeenCalledWith("11111111-1111-4111-8111-111111111111", { status: "done" }));
    await waitFor(() => expect(document.querySelector('[data-attr="growth-engage-row"]')?.getAttribute("data-status")).toBe("done"));
  });

  it("saves an edited draft on blur", async () => {
    listEngage.mockResolvedValue({ ok: true, data: { date: "2026-10-09", items: [item()] } });
    patchEngage.mockResolvedValue({ ok: true, data: item({ draft: "New" }) });
    render(<GrowthEngageTab />);
    const ta = (await screen.findByLabelText(/Drafted comment/)) as HTMLTextAreaElement;
    fireEvent.change(ta, { target: { value: "New" } });
    fireEvent.blur(ta);
    await waitFor(() => expect(patchEngage).toHaveBeenCalledWith(expect.any(String), { draft: "New" }));
  });

  it("shows the empty state", async () => {
    listEngage.mockResolvedValue({ ok: true, data: { date: "2026-10-09", items: [] } });
    render(<GrowthEngageTab />);
    expect(await screen.findByText("No list for this day")).toBeTruthy();
  });
});
