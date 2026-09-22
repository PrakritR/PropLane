// @vitest-environment jsdom
/**
 * PLAN-DOOR step 4 — Settings → Billing & plan → Doors. Doors are the
 * headline now that they set the bill: this pins the door block (count,
 * allowance, remaining, current bill via `priceForDoors`) and the
 * per-listing breakdown a manager can add up to reach that total.
 */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ManagerDoorsPanel } from "@/components/portal/manager-usage-panel";
import type { ManagerDoorCountPayload } from "@/app/api/manager/door-count/route";

afterEach(() => {
  cleanup();
});

function payload(overrides: Partial<ManagerDoorCountPayload> = {}): ManagerDoorCountPayload {
  return {
    totalDoors: 15,
    breakdown: [
      { propertyId: "p1", label: "123 Main St", doors: 4, basis: "rooms" },
      { propertyId: "p2", label: "Sunset Cottage", doors: 1, basis: "whole-home" },
      { propertyId: "p3", label: "Elm Duplex", doors: 10, basis: "rooms" },
    ],
    ...overrides,
  };
}

describe("ManagerDoorsPanel", () => {
  it("shows the account's door count, the tier's included allowance, and doors remaining", () => {
    render(
      <ManagerDoorsPanel
        tier="pro"
        billing="monthly"
        data={payload({ totalDoors: 15 })}
        error={null}
        onRefresh={() => {}}
      />,
    );
    expect(screen.getByText("Doors on your account")).toBeTruthy();
    expect(screen.getByText("15")).toBeTruthy();
    expect(screen.getByText("Included with Pro")).toBeTruthy();
    expect(screen.getByText("20")).toBeTruthy();
    // Pro includes 20; 15 used leaves 5 before overage applies.
    expect(screen.getByText("5")).toBeTruthy();
  });

  it("the breakdown rows sum to the account's total", () => {
    const rows = payload().breakdown;
    const sum = rows.reduce((total, row) => total + row.doors, 0);
    render(
      <ManagerDoorsPanel tier="pro" billing="monthly" data={payload({ totalDoors: sum })} error={null} onRefresh={() => {}} />,
    );
    expect(sum).toBe(15);
    expect(screen.getByText("123 Main St")).toBeTruthy();
    expect(screen.getByText("4 rooms · 4")).toBeTruthy();
    expect(screen.getByText("Sunset Cottage")).toBeTruthy();
    expect(screen.getByText("whole home · 1")).toBeTruthy();
    expect(screen.getByText("Elm Duplex")).toBeTruthy();
    expect(screen.getByText("10 rooms · 10")).toBeTruthy();
  });

  it("a listing with no rooms recorded renders as 'no rooms recorded · 1', never 0", () => {
    render(
      <ManagerDoorsPanel
        tier="pro"
        billing="monthly"
        data={payload({
          totalDoors: 1,
          breakdown: [{ propertyId: "p4", label: "New Listing", doors: 1, basis: "unrecorded" }],
        })}
        error={null}
        onRefresh={() => {}}
      />,
    );
    expect(screen.getByText("no rooms recorded · 1")).toBeTruthy();
    expect(screen.queryByText("no rooms recorded · 0")).toBeNull();
    expect(screen.queryByText(/· 0$/)).toBeNull();
  });

  it("an account over its allowance shows 'Over by N' and the overage priced correctly", () => {
    render(
      <ManagerDoorsPanel tier="pro" billing="monthly" data={payload({ totalDoors: 25 })} error={null} onRefresh={() => {}} />,
    );
    // Pro: 20 included, $3/door after -> 25 doors = $49 + 5*$3 = $64/mo.
    expect(screen.getByText("Over by 5")).toBeTruthy();
    expect(screen.getByText("$64/mo")).toBeTruthy();
  });

  it("prices annual billing using the annualized overage rate", () => {
    render(
      <ManagerDoorsPanel tier="business" billing="annual" data={payload({ totalDoors: 125 })} error={null} onRefresh={() => {}} />,
    );
    // Business: 120 included, $2/door after, annualized (x12) -> floor $2,490/yr + 5*$2*12 = $2,610/yr.
    expect(screen.getByText("Over by 5")).toBeTruthy();
    expect(screen.getByText("$2,610/yr")).toBeTruthy();
  });

  it("shows a loading state while the count is in flight, and an error with a retry", () => {
    const { rerender } = render(<ManagerDoorsPanel tier="pro" billing="monthly" data={null} error={null} onRefresh={() => {}} />);
    expect(screen.queryByText("Doors on your account")).toBeNull();

    rerender(<ManagerDoorsPanel tier="pro" billing="monthly" data={null} error="Network error." onRefresh={() => {}} />);
    expect(screen.getByText("Network error.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
  });

  it("says so plainly when there are no billable listings yet", () => {
    render(
      <ManagerDoorsPanel tier="free" billing="monthly" data={payload({ totalDoors: 0, breakdown: [] })} error={null} onRefresh={() => {}} />,
    );
    expect(screen.getByText("No billable listings yet.")).toBeTruthy();
  });
});
