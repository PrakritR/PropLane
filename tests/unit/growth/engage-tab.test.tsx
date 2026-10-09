// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const listEngage = vi.fn();
const patchEngage = vi.fn();
const buildEngageNow = vi.fn();
const addWatch = vi.fn();
const deleteWatch = vi.fn();
const toast = vi.hoisted(() => vi.fn());
const watchlist = vi.hoisted(() => ({ value: [] as Record<string, unknown>[] }));

vi.mock("@/components/providers/app-ui-provider", () => ({
  useConfirm: () => () => Promise.resolve(true),
  useAppUi: () => ({ showToast: toast }),
}));
vi.mock("@/lib/growth/client", () => ({
  growthApi: {
    listEngage: (...a: unknown[]) => listEngage(...a),
    patchEngage: (...a: unknown[]) => patchEngage(...a),
    buildEngageNow: (...a: unknown[]) => buildEngageNow(...a),
    listWatchlist: async () => ({ ok: true, data: watchlist.value }),
    listKeywords: async () => ({ ok: true, data: [] }),
    addWatch: (...a: unknown[]) => addWatch(...a),
    addKeyword: vi.fn(),
    deleteWatch: (...a: unknown[]) => deleteWatch(...a),
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

const view = (items: ReturnType<typeof item>[], date = "2026-10-09") => ({ date, items });

beforeEach(() => {
  listEngage.mockReset();
  patchEngage.mockReset();
  buildEngageNow.mockReset();
  addWatch.mockReset();
  deleteWatch.mockReset();
  toast.mockReset();
  watchlist.value = [];
});
afterEach(() => cleanup());

describe("Engage list tab", () => {
  it("is registered between Calendar and Accounts", () => {
    const i = GROWTH_TABS.indexOf("engage");
    expect(GROWTH_TABS[i + 1]).toBe("accounts");
    expect(i).toBeGreaterThan(-1);
  });

  it("renders rows and PATCHes done", async () => {
    listEngage.mockResolvedValue({ ok: true, data: view([item()]) });
    patchEngage.mockResolvedValue({ ok: true, data: item({ status: "done" }) });
    render(<GrowthEngageTab />);
    await waitFor(() => expect(screen.getAllByText("r/Landlord: Late rent again").length).toBe(1));
    expect(screen.getByText("Asks how to handle late rent")).toBeTruthy();
    fireEvent.click(document.querySelector('[data-attr="growth-engage-done-11111111-1111-4111-8111-111111111111"]')!);
    await waitFor(() => expect(patchEngage).toHaveBeenCalledWith("11111111-1111-4111-8111-111111111111", { status: "done" }));
    await waitFor(() => expect(document.querySelector('[data-attr="growth-engage-row"]')?.getAttribute("data-status")).toBe("done"));
  });

  it("saves an edited draft on blur", async () => {
    listEngage.mockResolvedValue({ ok: true, data: view([item()]) });
    patchEngage.mockResolvedValue({ ok: true, data: item({ draft: "New" }) });
    render(<GrowthEngageTab />);
    const ta = (await screen.findByLabelText(/Drafted comment/)) as HTMLTextAreaElement;
    fireEvent.change(ta, { target: { value: "New" } });
    fireEvent.blur(ta);
    await waitFor(() => expect(patchEngage).toHaveBeenCalledWith(expect.any(String), { draft: "New" }));
  });

  it("heads the list with its open and done tallies, and re-tallies after a row flips", async () => {
    listEngage.mockResolvedValue({ ok: true, data: view([item(), item({ id: "22222222-2222-4222-8222-222222222222", status: "done" })]) });
    patchEngage.mockResolvedValue({ ok: true, data: item({ status: "done" }) });
    render(<GrowthEngageTab />);
    await waitFor(() => expect(screen.getByText(/1 open · 1 done/)).toBeTruthy());
    fireEvent.click(document.querySelector('[data-attr="growth-engage-done-11111111-1111-4111-8111-111111111111"]')!);
    await waitFor(() => expect(screen.getByText(/0 open · 2 done/)).toBeTruthy());
  });

  // Both PATCHes resolve against the same render, so a snapshot-based write would lose the first flip.
  it("keeps both flips when two rows resolve from one render", async () => {
    const second = item({ id: "22222222-2222-4222-8222-222222222222", target: "r/Landlord: Deposit", status: "open" });
    listEngage.mockResolvedValue({ ok: true, data: view([item(), second]) });
    patchEngage.mockImplementation(async (id: string) => ({
      ok: true,
      data: id === second.id ? { ...second, status: "skipped" } : item({ status: "done" }),
    }));
    render(<GrowthEngageTab />);
    await waitFor(() => expect(screen.getByText(/2 open · 0 done/)).toBeTruthy());
    fireEvent.click(document.querySelector('[data-attr="growth-engage-done-11111111-1111-4111-8111-111111111111"]')!);
    fireEvent.click(document.querySelector('[data-attr="growth-engage-skip-22222222-2222-4222-8222-222222222222"]')!);
    await waitFor(() => expect(patchEngage).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getByText(/0 open · 1 done/)).toBeTruthy());
    const states = [...document.querySelectorAll('[data-attr="growth-engage-row"]')].map((r) => r.getAttribute("data-status"));
    expect(states.sort()).toEqual(["done", "skipped"]);
  });

  it("a failed Build now toasts and keeps the loaded list on screen", async () => {
    listEngage.mockResolvedValue({ ok: true, data: view([item()]) });
    buildEngageNow.mockResolvedValue({ ok: false, error: "Reddit said no." });
    render(<GrowthEngageTab />);
    await waitFor(() => expect(document.querySelector('[data-attr="growth-engage-row"]')).not.toBeNull());
    fireEvent.click(document.querySelector('[data-attr="growth-engage-build-now"]')!);
    await waitFor(() => expect(toast).toHaveBeenCalledWith("Reddit said no."));
    expect(document.querySelector('[data-attr="growth-engage-error"]')).toBeNull();
    expect(document.querySelector('[data-attr="growth-engage-row"]')).not.toBeNull();
  });

  it("a finished Build now reports what it added and skipped", async () => {
    listEngage.mockResolvedValue({ ok: true, data: view([item()]) });
    buildEngageNow.mockResolvedValue({ ok: true, data: { inserted: 7, considered: 9, skipped: 2, stoppedEarly: false } });
    render(<GrowthEngageTab />);
    await waitFor(() => expect(document.querySelector('[data-attr="growth-engage-row"]')).not.toBeNull());
    fireEvent.click(document.querySelector('[data-attr="growth-engage-build-now"]')!);
    await waitFor(() => expect(toast).toHaveBeenCalledWith("Added 7 · skipped 2"));
  });

  // A build that ran out of time must not look like a complete one.
  it("a Build now that ran out of time says so", async () => {
    listEngage.mockResolvedValue({ ok: true, data: view([item()]) });
    buildEngageNow.mockResolvedValue({ ok: true, data: { inserted: 5, considered: 12, skipped: 7, stoppedEarly: true } });
    render(<GrowthEngageTab />);
    await waitFor(() => expect(document.querySelector('[data-attr="growth-engage-row"]')).not.toBeNull());
    fireEvent.click(document.querySelector('[data-attr="growth-engage-build-now"]')!);
    await waitFor(() => expect(toast).toHaveBeenCalledWith("Added 5 · skipped 7 · stopped early, run again"));
  });

  it("lists, adds and removes the engage watchlist the build reads", async () => {
    listEngage.mockResolvedValue({ ok: true, data: view([]) });
    watchlist.value = [{ id: "w1", platform: "reddit", handle: "@someone", url: null, topic: null, kind: "engage", notes: null, active: true, createdAt: "" }];
    addWatch.mockResolvedValue({ ok: true, data: watchlist.value[0] });
    deleteWatch.mockResolvedValue({ ok: true, data: true });
    render(<GrowthEngageTab />);
    const group = await waitFor(() => {
      const el = document.querySelector('[data-attr="growth-group-engage"]');
      expect(el).not.toBeNull();
      return el as HTMLElement;
    });
    await waitFor(() => expect(group.textContent).toContain("@someone"));
    expect(group.textContent).toContain("Engage by hand · 1");

    fireEvent.click(document.querySelector('[data-attr="growth-group-engage-add"]')!);
    fireEvent.change(await screen.findByPlaceholderText("@handle"), { target: { value: "@other" } });
    fireEvent.click(document.querySelector('[data-attr="growth-engage-add-save"]')!);
    await waitFor(() => expect(addWatch).toHaveBeenCalledWith(expect.objectContaining({ handle: "@other", kind: "engage" })));

    fireEvent.click(document.querySelector('[data-attr="growth-watchlist-remove-w1"]')!);
    await waitFor(() => expect(deleteWatch).toHaveBeenCalledWith("w1"));
  });

  it("shows the empty state", async () => {
    listEngage.mockResolvedValue({ ok: true, data: view([]) });
    render(<GrowthEngageTab />);
    expect(await screen.findByText("No list for this day")).toBeTruthy();
  });
});
