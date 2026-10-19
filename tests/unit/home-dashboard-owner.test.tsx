// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OwnerStatementsPage, OwnerStatementsView } from "@/components/owner/owner-statements";
import { homeOwnerReport, homeOwnerStatementCsv, homeOwnerStatements, homeOwnerSummary } from "@/components/marketing/home-dashboard-owner-data";
import HomeDashboardOwner from "@/components/marketing/home-dashboard-owner";
import { OwnerProfile } from "@/components/owner/owner-profile";
import { ownerNavItems } from "@/lib/property-owner/sections";
import { assertOwnerPayloadRedacted } from "@/lib/property-owner/projection";

vi.mock("@/components/portal/portal-sign-out-button", () => ({ PortalSignOutButton: () => <button type="button">Live sign out</button> }));

const state = vi.hoisted(() => ({ calls: vi.fn(), reload: vi.fn(), loading: false, error: null as string | null }));
vi.mock("@/components/owner/owner-data", async (original) => {
  const actual = await original<typeof import("@/components/owner/owner-data")>();
  return { ...actual, useOwnerFetch: (url: string | null) => {
    state.calls(url);
    return { data: homeOwnerStatements(), loading: state.loading, error: state.error, reload: state.reload };
  } };
});
beforeEach(() => { state.calls.mockClear(); state.reload.mockClear(); state.error = null; state.loading = false; });
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });

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
  it("navigates every owner section locally and filters actual aggregate statements", () => {
    const fetch = vi.fn(() => { throw new Error("Sample must not fetch"); });
    vi.stubGlobal("fetch", fetch);
    render(<HomeDashboardOwner />);
    const nav = within(screen.getByRole("complementary", { name: "Owner sections" }));
    expect(nav.getAllByRole("button").map((button) => button.textContent)).toEqual(ownerNavItems(false).map((item) => item.label));
    const [house] = homeOwnerReport();
    fireEvent.click(screen.getByRole("tab", { name: house.label }));
    expect(screen.getByText("1 house")).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: house.label })).toHaveAttribute("aria-selected", "true");
    expect(homeOwnerStatements(house.propertyId).rows[0].distributionCents).toBe(house.distributionCents);
    fireEvent.click(screen.getByRole("tab", { name: "All houses" }));
    expect(screen.getByText("2 houses")).toBeInTheDocument();
    for (const section of ["Overview", "Properties", "Documents", "Profile"]) {
      fireEvent.click(nav.getByRole("button", { name: section }));
      expect(screen.getByRole("heading", { name: section })).toBeInTheDocument();
      expect(nav.getByRole("button", { name: section })).toHaveAttribute("aria-current", "page");
    }
    fireEvent.click(nav.getByRole("button", { name: "Documents" }));
    expect(screen.getByText("No documents yet")).toBeInTheDocument();
    expect(state.calls).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    expect(() => assertOwnerPayloadRedacted(homeOwnerReport())).not.toThrow();
    expect(() => assertOwnerPayloadRedacted(homeOwnerSummary())).not.toThrow();
  });
  it("opens a property's statement and downloads only its local aggregate CSV", () => {
    vi.useFakeTimers();
    const createObjectURL = vi.fn(() => "blob:sample-statement");
    const revokeObjectURL = vi.fn();
    vi.stubGlobal("URL", class extends URL { static createObjectURL = createObjectURL; static revokeObjectURL = revokeObjectURL; });
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const { container } = render(<HomeDashboardOwner />);
    fireEvent.click(screen.getByRole("button", { name: "Properties", exact: true }));
    const house = homeOwnerReport()[0];
    const row = container.querySelector(`[data-attr="owner-property-row-${house.propertyId}"]`)!;
    fireEvent.click(row);
    expect(screen.getByRole("heading", { name: "Statements" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: house.label })).toHaveAttribute("aria-selected", "true");
    fireEvent.click(screen.getByRole("button", { name: "Download", exact: true }));
    expect(createObjectURL).toHaveBeenCalledWith(expect.any(Blob));
    expect(click).toHaveBeenCalledOnce();
    expect(screen.getByRole("status")).toHaveTextContent("Sample statement downloaded as CSV.");
    const csv = homeOwnerStatementCsv(house.propertyId);
    expect(csv).toContain(house.label);
    expect(csv).not.toContain(homeOwnerReport()[1].label);
    expect(csv).not.toMatch(/resident|vendor|@/i);
    vi.runAllTimers();
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:sample-statement");
    expect(fetch).not.toHaveBeenCalled();
  });
  it("keeps sample sign-out local and resumes the sample", () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    render(<HomeDashboardOwner />);
    fireEvent.click(screen.getByRole("button", { name: "Profile" }));
    fireEvent.click(screen.getByRole("button", { name: "Sign out", exact: true }));
    expect(screen.getByText("Sample session ended")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Resume sample" }));
    expect(screen.getByRole("heading", { name: "Statements" })).toBeInTheDocument();
    expect(fetch).not.toHaveBeenCalled();
  });
  it("preserves the live profile identity and live sign-out component", () => {
    render(<OwnerProfile name=" Owner " email=" owner@example.test " />);
    expect(screen.getByText("Owner")).toBeInTheDocument();
    expect(screen.getByText("owner@example.test")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Live sign out" })).toBeInTheDocument();
  });
});
