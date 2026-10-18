// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OwnerStatementsPage, OwnerStatementsView } from "@/components/owner/owner-statements";
import { homeOwnerStatements } from "@/components/marketing/home-dashboard-owner-data";

const state = vi.hoisted(() => ({ calls: vi.fn(), reload: vi.fn(), loading: false, error: null as string | null }));
vi.mock("@/components/owner/owner-data", async (original) => {
  const actual = await original<typeof import("@/components/owner/owner-data")>();
  return { ...actual, useOwnerFetch: (url: string | null) => {
    state.calls(url);
    return { data: homeOwnerStatements(), loading: state.loading, error: state.error, reload: state.reload };
  } };
});
beforeEach(() => { state.calls.mockClear(); state.reload.mockClear(); state.error = null; state.loading = false; });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("real owner statements sample adapter", () => {
  it("renders the real statement row without invoking a live reader", () => {
    const data = homeOwnerStatements();
    const download = vi.fn();
    const filter = vi.fn();
    render(<OwnerStatementsView data={data} tabs={data.houses} propertyId="" onPropertyChange={filter} onDownload={download} />);
    expect(screen.getByText("September 2025")).toBeInTheDocument();
    expect(screen.getByText("2 houses")).toBeInTheDocument();
    expect(state.calls).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("tab", { name: data.houses[0].label }));
    expect(filter).toHaveBeenCalledWith(data.houses[0].propertyId);
    fireEvent.click(screen.getByRole("button", { name: "Download" }));
    expect(download).toHaveBeenCalledWith("2025-09");
  });
  it("preserves the live page's all-houses and filtered read paths", () => {
    render(<OwnerStatementsPage />);
    expect(state.calls).toHaveBeenCalledWith("/api/owner/statements");
    expect(state.calls).toHaveBeenCalledWith(null);
    const house = homeOwnerStatements().houses[0];
    fireEvent.click(screen.getByRole("tab", { name: house.label }));
    expect(state.calls).toHaveBeenCalledWith(`/api/owner/statements?propertyId=${encodeURIComponent(house.propertyId)}`);
  });
  it("preserves live retry errors instead of showing stale statement rows", () => {
    state.error = "failed";
    render(<OwnerStatementsPage />);
    expect(screen.getByRole("alert")).toHaveTextContent("Couldn't load your statements.");
    expect(screen.queryByText("September 2025")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(state.reload).toHaveBeenCalledOnce();
  });
});
