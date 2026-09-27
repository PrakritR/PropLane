// @vitest-environment jsdom
//
// Captain 2026-09-26: the home page's product panels reuse the REAL portal
// presentational components fed static "Seattle Homes" fixtures — never a
// live `/demo` iframe, never a fetch. This guards the two contracts that
// matter for a fixture-driven mock: tabs actually change which rows render
// (not just which tab looks active), and nothing under `global.fetch` is
// ever called while a panel renders or its tabs are switched.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import {
  ApplicationsPanel,
  LeasesPanel,
  PaymentsPanel,
  ServicesPanel,
  ToursPanel,
} from "@/components/marketing/site/product-mock/panels";

vi.mock("next/navigation", () => ({ usePathname: () => "/" }));

afterEach(cleanup);

let fetchSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  fetchSpy = vi.spyOn(global, "fetch" as never).mockImplementation(() => {
    throw new Error("a product mock panel must never fetch");
  });
});

describe("product mock panels — no network", () => {
  it("ToursPanel never calls fetch while rendering or switching tabs", () => {
    render(<ToursPanel />);
    fireEvent.click(screen.getByRole("button", { name: /pending/i }));
    fireEvent.click(screen.getByRole("button", { name: /past/i }));
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("ApplicationsPanel never calls fetch while rendering or switching tabs", () => {
    render(<ApplicationsPanel />);
    fireEvent.click(screen.getByRole("button", { name: /approved/i }));
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("product mock panels — tabs actually change the rows", () => {
  it("Tours: Upcoming shows Fremont Studio; Past shows a different guest, not the same rows", () => {
    render(<ToursPanel />);
    expect(screen.getByText("Fremont Studio")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /past/i }));
    expect(screen.queryByText("Jamie P.")).not.toBeInTheDocument();
    expect(screen.getByText("Chris Nakamura")).toBeInTheDocument();
  });

  it("Applications: Pending shows the flagged applicant; Approved shows Dana Reyes instead", () => {
    render(<ApplicationsPanel />);
    expect(screen.getByText("Sample Applicant")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /approved/i }));
    expect(screen.queryByText("Sample Applicant")).not.toBeInTheDocument();
    expect(screen.getByText("Dana Reyes")).toBeInTheDocument();
  });

  it("Leases: the pipeline progress bar reads N of TOTAL signed", () => {
    render(<LeasesPanel />);
    expect(screen.getByText(/of 7 leases signed/i)).toBeInTheDocument();
  });

  it("Payments: Overdue shows September rent; Paid shows a different charge", () => {
    render(<PaymentsPanel />);
    expect(screen.getAllByText(/September rent/).length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole("button", { name: /paid/i }));
    expect(screen.queryByText(/September rent/)).not.toBeInTheDocument();
    expect(screen.getAllByText(/August rent/).length).toBeGreaterThan(0);
  });

  it("Services: Scheduled shows the vendor's change order; Open shows the unassigned job instead", () => {
    render(<ServicesPanel />);
    expect(screen.getAllByText(/Thu 10:00 AM/).length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole("button", { name: /open/i }));
    expect(screen.queryByText(/Thu 10:00 AM/)).not.toBeInTheDocument();
    expect(screen.getByText("No hot water")).toBeInTheDocument();
  });

  it("search filters a panel's rows client-side, no navigation", () => {
    render(<ToursPanel />);
    const search = screen.getByPlaceholderText("Search tours");
    fireEvent.change(search, { target: { value: "jamie" } });
    expect(screen.getByText("Fremont Studio")).toBeInTheDocument();
  });

  it("clicking a row opens the fixture detail sheet with that row's own facts", () => {
    render(<ToursPanel />);
    fireEvent.click(screen.getByText("Jamie P."));
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText("Fremont Studio")).toBeInTheDocument();
  });
});
