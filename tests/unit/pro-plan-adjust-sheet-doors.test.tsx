// @vitest-environment jsdom
/**
 * PLAN-DOOR step 4 — the Adjust plan cards must price THIS account's real
 * door count on each tier, not an abstract number, and must read every
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

describe("Adjust plan cards price this account's real doors", () => {
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
        doorCount={null}
      />,
    );
    expect(screen.getByText("$49/mo · $490/yr")).toBeTruthy();
    expect(screen.getByText("$249/mo · $2,490/yr")).toBeTruthy();
    expect(screen.queryByText("$20/mo · $192/yr")).toBeNull();
    expect(screen.queryByText("$200/mo · $1,920/yr")).toBeNull();
  });

  it("shows no account price while the door count is still loading", () => {
    render(
      <PlanAdjustSheet
        open
        onClose={() => {}}
        currentTier="free"
        currentBilling="monthly"
        renewalLabel={null}
        busy={false}
        onConfirm={() => {}}
        doorCount={null}
      />,
    );
    expect(document.querySelector('[data-attr="plan-adjust-account-price-pro"]')).toBeNull();
    expect(document.querySelector('[data-attr="plan-adjust-account-price-business"]')).toBeNull();
  });

  it("prices each card against the account's real live door count, including overage", () => {
    render(
      <PlanAdjustSheet
        open
        onClose={() => {}}
        currentTier="pro"
        currentBilling="monthly"
        renewalLabel={null}
        busy={false}
        onConfirm={() => {}}
        doorCount={25}
      />,
    );
    // Pro: 20 included, $3/door -> $49 + 5*$3 = $64/mo for 25 doors.
    expect(screen.getByText("$64/mo for your 25 doors")).toBeTruthy();
    // Business: 120 included, no overage at 25 doors -> floor only.
    expect(screen.getByText("$249/mo for your 25 doors")).toBeTruthy();
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
        doorCount={25}
      />,
    );
    // Pro annual: $490/yr floor + 5 extra doors * $3/mo * 12 = $180/yr -> $670/yr.
    expect(screen.getByText("$670/yr for your 25 doors")).toBeTruthy();
  });
});
