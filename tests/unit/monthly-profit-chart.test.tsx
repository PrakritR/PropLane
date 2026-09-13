// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MonthlyProfitChart } from "@/components/portal/monthly-profit-chart";
import type { MonthlyCashflowPoint } from "@/lib/portal-monthly-profit";

afterEach(() => cleanup());

const points: MonthlyCashflowPoint[] = [
  { key: "2026-04", label: "Apr", revenue: 600, expense: 100, profit: 500 },
  { key: "2026-05", label: "May", revenue: 800, expense: 120, profit: 680 },
  { key: "2026-06", label: "Jun", revenue: 1150, expense: 90, profit: 1060 },
];

describe("MonthlyProfitChart", () => {
  it("draws a scrubbable line with underline ranges and no month chips", () => {
    const { container } = render(<MonthlyProfitChart points={points} />);
    expect(screen.getByText("$1,150")).toBeTruthy();
    expect(screen.getByText(/Jun/)).toBeTruthy();
    expect(screen.getByRole("img", { name: "Monthly revenue trend" })).toBeTruthy();
    expect(container.querySelectorAll("circle")).toHaveLength(1);
    expect(screen.getByRole("tab", { name: "3M" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "6M" })).toBeTruthy();
    expect(container.querySelector("[data-attr^='monthly-profit-month-']")).toBeNull();
  });

  it("hides the $0 hero when the visible window is all zeros", () => {
    render(
      <MonthlyProfitChart
        points={[{ key: "2026-09", label: "Sep", revenue: 0, expense: 0, profit: 0 }]}
      />,
    );
    expect(screen.getByText(/No cash flow data yet/)).toBeTruthy();
    expect(screen.queryByText("$0.00")).toBeNull();
    expect(screen.queryByRole("img", { name: /trend/ })).toBeNull();
  });

  it("keeps window color while the hero follows a scrub", () => {
    const { container } = render(<MonthlyProfitChart points={points} />);
    const svg = screen.getByRole("img", { name: "Monthly revenue trend" });
    Object.defineProperty(svg, "getBoundingClientRect", {
      value: () => ({ left: 0, width: 300, top: 0, height: 140, right: 300, bottom: 140, x: 0, y: 0, toJSON: () => {} }),
    });
    fireEvent.pointerMove(svg, { clientX: 0, pointerType: "mouse" });
    expect(screen.getByText("$600.00")).toBeTruthy();
    expect(container.querySelector("[data-attr='cashflow-hero'] p")?.className).toContain("status-confirmed-fg");
  });
});
