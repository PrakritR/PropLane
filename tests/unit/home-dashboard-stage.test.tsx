// @vitest-environment jsdom
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactNode } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HomeDashboardStage } from "@/components/marketing/home-dashboard-stage";
import { HomeDashboardDeferred } from "@/components/marketing/home-dashboard-deferred";
import { HOME_DASHBOARD_TABS, homeDashboardRows, homeRentPaid } from "@/components/marketing/home-dashboard-data";
import { DEMO_TABS } from "@/components/marketing/site/product-mock/demo-nav";
import { residentStory, worldFor } from "@/components/marketing/site/product-mock/world";
import { MobileAppPreview } from "@/components/marketing/mobile-app-preview";

const state = vi.hoisted(() => ({ active: true, near: false, enhanced: false, loaded: vi.fn(), fail: false }));
vi.mock("@/components/marketing/home-scroll-stage", () => ({
  useHomeStageVisibility: () => state,
  HomeScrollStage: ({ id, title, steps }: { id: string; title: ReactNode; steps: { id: string; caption: string; content: ReactNode }[] }) =>
    <section id={id}><h2>{title}</h2>{steps.map((step) => <article key={step.id} data-step={step.id}><p>{step.caption}</p>{step.content}</article>)}</section>,
}));
vi.mock("@/components/marketing/home-dashboard-panel", () => {
  state.loaded();
  return { default: ({ tab, animate, approved, onApprove }: { tab: string; animate: boolean; approved: boolean; onApprove(): void }) => {
    if (state.fail) throw new Error("Panel unavailable");
    return <button onClick={onApprove} data-animate={String(animate)}>{tab}: {approved ? "Approved" : "Draft"}</button>;
  } };
});

beforeEach(() => { state.active = true; state.near = false; state.enhanced = false; state.fail = false; });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("homepage manager dashboard tour", () => {
  it("ships complete fixture content and both phone beats before JavaScript", () => {
    const html = renderToStaticMarkup(<HomeDashboardStage />);
    expect(html).toContain('id="dashboard"');
    for (const tab of HOME_DASHBOARD_TABS) {
      expect(DEMO_TABS.manager.some((item) => item.id === tab.id)).toBe(true);
      expect(html).toContain(`${tab.label} sample records`);
      expect(homeDashboardRows(tab.id).length).toBeGreaterThan(0);
    }
    expect(html).toContain("Reply drafted.");
    expect(html).toContain('data-step="phone-paid"');
    expect(html).toContain(homeRentPaid().amount);
    expect(html).not.toContain("Loading");
    expect(html).not.toContain("Welcome, Alex");
    expect(state.loaded).not.toHaveBeenCalled();
  });

  it("draws the paid amount from the same paid fixture row as the portal", () => {
    const paid = homeRentPaid();
    expect(worldFor(residentStory("pay")).payments).toContainEqual(paid);
    expect(paid.bucket).toBe("paid");
    expect(homeDashboardRows("payments").some((row) => row.id === paid.id && row.figure === paid.amount)).toBe(true);
  });

  it("keeps the original mobile preview by default and replaces only its content when supplied", () => {
    const { rerender, container } = render(<MobileAppPreview />);
    expect(screen.getByText("Welcome, Alex")).toBeInTheDocument();
    expect(container.querySelector('[data-attr="mobile-app-preview"]')).toHaveAttribute("aria-hidden", "true");
    rerender(<MobileAppPreview><p>Fixture payment</p></MobileAppPreview>);
    expect(screen.queryByText("Welcome, Alex")).not.toBeInTheDocument();
    expect(screen.getByText("Fixture payment")).toBeInTheDocument();
    expect(container.querySelector('[data-attr="mobile-app-preview"]')).not.toHaveAttribute("aria-hidden");
  });

  it("loads on phones too, only near the stage and active; approval survives revisiting", async () => {
    const fallback = <p>Fixture content</p>;
    const { rerender } = render(<HomeDashboardDeferred tab="communication" fallback={fallback} />);
    expect(screen.getByText("Fixture content")).toBeInTheDocument();
    state.near = true; state.active = false;
    rerender(<HomeDashboardDeferred tab="communication" fallback={fallback} />);
    expect(screen.queryByRole("button")).toBeNull();
    state.active = true; state.enhanced = true;
    rerender(<HomeDashboardDeferred tab="communication" fallback={fallback} />);
    const approve = await screen.findByRole("button", { name: "communication: Draft" });
    expect(approve).toHaveAttribute("data-animate", "true");
    fireEvent.click(approve);
    expect(screen.getByRole("button", { name: "communication: Approved" })).toBeInTheDocument();
    state.active = false;
    rerender(<HomeDashboardDeferred tab="communication" fallback={fallback} />);
    state.active = true;
    rerender(<HomeDashboardDeferred tab="communication" fallback={fallback} />);
    expect(await screen.findByRole("button", { name: "communication: Approved" })).toHaveAttribute("data-animate", "true");
    state.enhanced = false;
    rerender(<HomeDashboardDeferred tab="communication" fallback={fallback} />);
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.getByText("Fixture content")).toBeInTheDocument();
  });

  it("keeps useful fixture content if a panel fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    state.near = true; state.enhanced = true; state.fail = true;
    render(<HomeDashboardDeferred tab="payments" fallback={<p>Paid fixture retained</p>} />);
    expect(await screen.findByText("Paid fixture retained")).toBeInTheDocument();
  });
});
