// @vitest-environment jsdom
/**
 * The Adjust plan cards must price THIS account's real resident count on
 * each tier (plans are metered on residents since bd30fcf6c), not an
 * abstract number, and must read every
 * dollar figure from `RATE_CARD` rather than the stale hand-typed
 * `TIER_MONTHLY_USD` this replaces ($20/$200 — half the real $49/$249 floor).
 */
import type { ReactNode } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/components/ui/modal", () => ({
  Modal: ({ open, children, title }: { open: boolean; children: ReactNode; title: string }) =>
    open ? (
      <div role="dialog" aria-label={title}>
        {children}
      </div>
    ) : null,
}));

import { PlanAdjustSheet } from "@/components/portal/pro-plan-adjust-sheet";

afterEach(() => {
  cleanup();
});

describe("Adjust plan cards price this account's real residents", () => {
  it("reads the rate card's actual floor, not the stale $20/$200 figures", () => {
    render(
      <PlanAdjustSheet
        open
        onClose={() => {}}
        currentTier="free"
        currentBilling="monthly"
        renewalLabel={null}
        busy={false}
        onConfirm={() => {}}
        residentCount={null}
      />,
    );
    expect(screen.getByText("$49/mo · $490/yr")).toBeTruthy();
    expect(screen.getByText("$249/mo · $2,490/yr")).toBeTruthy();
    expect(screen.queryByText("$20/mo · $192/yr")).toBeNull();
    expect(screen.queryByText("$200/mo · $1,920/yr")).toBeNull();
  });

  it("shows no account price while the resident count is still loading", () => {
    render(
      <PlanAdjustSheet
        open
        onClose={() => {}}
        currentTier="free"
        currentBilling="monthly"
        renewalLabel={null}
        busy={false}
        onConfirm={() => {}}
        residentCount={null}
      />,
    );
    expect(document.querySelector('[data-attr="plan-adjust-account-price-pro"]')).toBeNull();
    expect(document.querySelector('[data-attr="plan-adjust-account-price-business"]')).toBeNull();
  });

  it("prices each card against the account's real live resident count, including overage", () => {
    render(
      <PlanAdjustSheet
        open
        onClose={() => {}}
        currentTier="pro"
        currentBilling="monthly"
        renewalLabel={null}
        busy={false}
        onConfirm={() => {}}
        residentCount={105}
      />,
    );
    // Pro: 100 included, $3/resident -> $49 + 5*$3 = $64/mo for 105 residents.
    expect(screen.getByText("$64/mo for your 105 residents")).toBeTruthy();
    // Business: 500 included, no overage at 105 residents -> floor only.
    expect(screen.getByText("$249/mo for your 105 residents")).toBeTruthy();
  });

  it("switches to the annual price when Annual is selected", () => {
    render(
      <PlanAdjustSheet
        open
        onClose={() => {}}
        currentTier="pro"
        currentBilling="annual"
        renewalLabel={null}
        busy={false}
        onConfirm={() => {}}
        residentCount={105}
      />,
    );
    // Pro annual: $490/yr floor + 5 extra residents * $3/mo * 12 = $180/yr -> $670/yr.
    expect(screen.getByText("$670/yr for your 105 residents")).toBeTruthy();
  });
});
