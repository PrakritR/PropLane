// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }), usePathname: () => "/admin/dashboard", useSearchParams: () => new URLSearchParams() }));
vi.mock("@/components/portal/portal-metrics", () => ({
  ManagerPortalPageShell: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  PORTAL_DASHBOARD_STACK: "",
}));
vi.mock("@/components/portal/pro-dashboard-kpis", () => ({
  AttentionPanel: () => null,
  KpiCard: ({ label }: { label: string }) => <div>{label}</div>,
  PanelShell: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

import { AdminDashboard } from "@/components/portal/admin-dashboard";
import { FetchTimeoutError } from "@/lib/auth/fetch-with-timeout";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const overview = { money: {}, activeManagers: 4, activeResidents: 9, activeVendors: 2, openFeedback: null, smsFailures24h: null, openDisputes: null, managersWithoutPayouts: 0, recentSignups: null };

describe("the admin Dashboard never sits on Loading forever", () => {
  it("shows Loading, then the software overview", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => overview }));
    render(<AdminDashboard />);
    expect(screen.getByText("Loading…")).toBeTruthy();
    await waitFor(() => expect(screen.getByText("Managers")).toBeTruthy());
  });

  it("a failed load shows an error with Try again, which loads it again", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, json: async () => ({ error: "Could not load the admin dashboard." }) })
      .mockResolvedValueOnce({ ok: true, json: async () => overview });
    vi.stubGlobal("fetch", fetchMock);
    render(<AdminDashboard />);
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("Could not load the admin dashboard."));
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(screen.getByText("Managers")).toBeTruthy());
  });

  it("a request that times out says so instead of spinning", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new FetchTimeoutError()));
    render(<AdminDashboard />);
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("That took too long to load."));
  });
});
