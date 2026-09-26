// @vitest-environment jsdom
/**
 * Settings → Billing & plan → Residents. Plans are metered on residents now
 * (bd30fcf6c), not listing doors: this pins the block a manager reads their
 * bill from — count, the tier's included residents, what is left before the
 * per-resident rate, and the current bill via `priceForResidents`. The
 * component keeps its old `ManagerDoorsPanel` name.
 */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ManagerDoorsPanel } from "@/components/portal/manager-usage-panel";

afterEach(() => {
  cleanup();
});

function panel(props: Partial<Parameters<typeof ManagerDoorsPanel>[0]> = {}) {
  return (
    <ManagerDoorsPanel
      tier="pro"
      billing="monthly"
      used={15}
      max={null}
      error={null}
      onRefresh={() => {}}
      {...props}
    />
  );
}

describe("ManagerDoorsPanel (residents)", () => {
  it("shows the resident count, the tier's included residents, and what is left", () => {
    render(panel({ used: 15 }));
    expect(screen.getByText("Residents on your account")).toBeTruthy();
    expect(screen.getByText("15")).toBeTruthy();
    expect(screen.getByText("Included with Pro")).toBeTruthy();
    // Pro includes 100; 15 used leaves 85 before the per-resident rate.
    expect(screen.getByText("100")).toBeTruthy();
    expect(screen.getByText("85")).toBeTruthy();
    expect(screen.getByText("$49/mo")).toBeTruthy();
  });

  it("shows a plan cap as 'used of max'", () => {
    render(panel({ tier: "free", used: 12, max: 20 }));
    expect(screen.getByText("12 of 20")).toBeTruthy();
  });

  it("an account over its allowance shows 'Over by N' and the overage priced correctly", () => {
    render(panel({ used: 105 }));
    // Pro: 100 included, $3/resident after -> 105 = $49 + 5 * $3 = $64/mo.
    expect(screen.getByText("Over by 5")).toBeTruthy();
    expect(screen.getByText("$64/mo")).toBeTruthy();
  });

  it("prices annual billing using the annualized per-resident rate", () => {
    render(panel({ tier: "business", billing: "annual", used: 505 }));
    // Business: 500 included, $2/resident after, annualized -> $2,490/yr + 5 * $2 * 12 = $2,610/yr.
    expect(screen.getByText("Over by 5")).toBeTruthy();
    expect(screen.getByText("$2,610/yr")).toBeTruthy();
  });

  it("shows a loading state while the count is in flight, and an error with a retry", () => {
    const { rerender } = render(panel({ used: null }));
    expect(screen.queryByText("Residents on your account")).toBeNull();

    rerender(panel({ used: null, error: "Network error." }));
    expect(screen.getByText("Network error.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
  });
});
