// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => "/admin/unassigned-leads",
  useSearchParams: () => new URLSearchParams(),
}));

import { AdminUnassignedLeadsPanel, leadFacts, type UnassignedLeadRow } from "@/components/portal/admin-unassigned-leads-panel";

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const ROW: UnassignedLeadRow = { id: "lead-1", phoneMasked: "•••• 0142", budgetMax: 1000, moveInDate: "2026-11-01", lastMessageAt: "2026-10-18T19:00:00Z", stage: "offered" };

describe("AdminUnassignedLeadsPanel", () => {
  it("lists leads by masked phone with budget, move-in and last-message facts", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json(200, { items: [ROW], total: 1, houses: [{ id: "p1", label: "Brooklyn House - 4000 15th Ave NE" }] })));
    render(<AdminUnassignedLeadsPanel />);
    expect(await screen.findByText("Lead •••• 0142")).toBeTruthy();
    expect(screen.getByText("Shown rooms")).toBeTruthy();
    expect(screen.getByText("$1,000/mo")).toBeTruthy();
    expect(screen.getByText("Move-in Nov 1")).toBeTruthy();
    expect(document.body.textContent).not.toContain("2065550142");
  });

  it("says so when there are none, and offers a retry on an error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json(200, { items: [], total: 0, houses: [] })));
    render(<AdminUnassignedLeadsPanel />);
    expect(await screen.findByText("No unassigned leads")).toBeTruthy();
    cleanup();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json(403, { error: "Forbidden." })));
    render(<AdminUnassignedLeadsPanel />);
    await waitFor(() => expect(document.body.textContent).toContain("Could not load leads."));
  });

  it("keeps the facts to glyph facts only and drops the ones it does not have", () => {
    expect(leadFacts(ROW)).toHaveLength(3);
    expect(leadFacts({ ...ROW, budgetMax: null, moveInDate: null, lastMessageAt: null })).toEqual([]);
  });
});
