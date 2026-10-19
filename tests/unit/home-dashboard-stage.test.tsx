// @vitest-environment jsdom
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactNode } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HomeDashboardStage } from "@/components/marketing/home-dashboard-stage";
import { HomeDashboardDeferred } from "@/components/marketing/home-dashboard-deferred";
import { HOME_DASHBOARD_PORTALS, homeRentPaid } from "@/components/marketing/home-dashboard-data";
import { homeOwnerStatements } from "@/components/marketing/home-dashboard-owner-data";
import { assertOwnerPayloadRedacted } from "@/lib/property-owner/projection";
import { OPS_REPORTS } from "@/components/marketing/site/product-mock/fixtures-popups-ops";
import { dollarsToCents } from "@/lib/reports/money";

const state = vi.hoisted(() => ({ active: true, near: false, animated: false, loaded: vi.fn(), fail: false }));
vi.mock("@/components/marketing/home-dashboard-tour", () => ({
  useHomeDashboardVisibility: () => state,
  HomeDashboardTour: ({ steps }: { steps: { id: string; content: ReactNode }[] }) => <section id="dashboard"><h2>The software</h2>{steps.map((step) => <article key={step.id} data-portal={step.id}>{step.content}</article>)}</section>,
}));
vi.mock("@/components/marketing/home-dashboard-panel", () => {
  state.loaded();
  return { default: ({ portal }: { portal: string }) => {
    if (state.fail) throw new Error("Panel unavailable");
    return <div>{portal} real panel</div>;
  } };
});
beforeEach(() => { state.active = true; state.near = false; state.animated = false; state.fail = false; });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("software portal previews", () => {
  it("ships meaningful records for all four roles before JavaScript", () => {
    const html = renderToStaticMarkup(<HomeDashboardStage />);
    expect(html).toContain("The software");
    for (const { id } of HOME_DASHBOARD_PORTALS) expect(html).toContain(`${id} sample records`);
    expect(html).toContain(homeRentPaid().amount);
    expect(html).toContain("Statements");
    expect(html).not.toContain("Everything the number does");
    expect(html).not.toContain("Your phone");
    expect(html).not.toContain("Loading");
    expect(state.loaded).not.toHaveBeenCalled();
  });
  it("loads only the visible nearby portal on phones and with reduced motion too", async () => {
    const fallback = <p>Resident sample records</p>;
    const { rerender } = render(<HomeDashboardDeferred portal="resident" fallback={fallback} />);
    expect(screen.getByText("Resident sample records")).toBeInTheDocument();
    state.near = true; state.active = false;
    rerender(<HomeDashboardDeferred portal="resident" fallback={fallback} />);
    expect(screen.queryByText("resident real panel")).toBeNull();
    state.active = true;
    rerender(<HomeDashboardDeferred portal="resident" fallback={fallback} />);
    expect(await screen.findByText("resident real panel")).toBeInTheDocument();
    expect(state.animated).toBe(false);
  });
  it("keeps useful sample records if a real panel fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    state.near = true; state.fail = true;
    render(<HomeDashboardDeferred portal="owner" fallback={<p>Owner sample retained</p>} />);
    expect(await screen.findByText("Owner sample retained")).toBeInTheDocument();
  });
  it("derives the owner statement from manager report aggregates and contains no private fields", () => {
    const report = OPS_REPORTS.find((row) => row.id === "owner-statement")!;
    const statements = homeOwnerStatements();
    expect(statements.rows[0].houses).toBe(report.rows.length);
    expect(statements.rows[0].distributionCents).toBe(report.rows.reduce((sum, row) => sum + dollarsToCents(row[3]), 0));
    expect(() => assertOwnerPayloadRedacted(statements)).not.toThrow();
  });
});
