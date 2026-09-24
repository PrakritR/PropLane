// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";

const native = vi.hoisted(() => ({ value: false }));
vi.mock("@/hooks/use-is-native-app", () => ({ useIsNativeApp: () => ({ isNative: native.value }) }));
vi.mock("@/components/ui/modal", () => ({
  Modal: ({ open, children, title }: { open: boolean; children: ReactNode; title: string }) =>
    open ? (
      <div role="dialog" aria-label={title}>
        {children}
      </div>
    ) : null,
}));
vi.mock("@/components/stripe/embedded-checkout", () => ({
  EmbeddedCheckoutMount: () => <div>Verified Stripe checkout</div>,
}));
const workspaces = vi.hoisted(() => ({
  value: [
    { id: "ws-default", name: "Ballard", owned: true, isDefault: true },
    { id: "ws-second", name: "Fremont", owned: true, isDefault: false },
    { id: "ws-guest", name: "Someone else's", owned: false, isDefault: false },
  ] as unknown[],
}));
vi.mock("@/components/portal/workspace-provider", () => ({
  useWorkspaces: () => ({ workspaces: workspaces.value }),
}));

import { ManagerExtraUsagePanel, ManagerUsagePanel } from "@/components/portal/manager-usage-panel";
import type { ManagerUsageSummary } from "@/app/api/manager/usage-summary/route";

function summary(overrides: Partial<ManagerUsageSummary> = {}): ManagerUsageSummary {
  return {
    tier: "business",
    tierLabel: "Business",
    tierUnknown: false,
    communication: {
      remainingCents: 10_000,
      includedUsedCents: 0,
      includedAllowanceCents: 10_000,
      purchasedRemainingCents: 0,
      resetsAt: "2026-10-01T00:00:00Z",
      paused: false,
      workspaceId: "ws-default",
      isDefaultWorkspace: true,
    },
    listings: { used: 12, max: 20 },
    workspaces: { used: 2, max: 2 },
    residents: { used: 40, max: 500 },
    workNumbers: { used: 2, max: 2, perWorkspace: true },
    coManagers: { used: 3, max: 20 },
    monthlyBudgetCents: null,
    ratesCents: { sms_outbound_segment: 3 },
    ...overrides,
  };
}

beforeEach(() => {
  native.value = false;
  workspaces.value = [
    { id: "ws-default", name: "Ballard", owned: true, isDefault: true },
    { id: "ws-second", name: "Fremont", owned: true, isDefault: false },
    { id: "ws-guest", name: "Someone else's", owned: false, isDefault: false },
  ];
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ clientSecret: "cs_test", purchaseId: "p1" })));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("ManagerUsagePanel", () => {
  it("Remaining reads $100.00 left · $0.00 of $100.00 on a fresh Business month", () => {
    render(<ManagerUsagePanel summary={summary()} error={null} onRefresh={() => {}} />);
    expect(screen.getByText("$100.00 left")).toBeTruthy();
    expect(screen.getByText("$0.00 of $100.00")).toBeTruthy();
  });

  it("Remaining is included minus used, never the raw allowance", () => {
    render(
      <ManagerUsagePanel
        summary={summary({
          communication: {
            remainingCents: 6_000,
            includedUsedCents: 4_000,
            includedAllowanceCents: 10_000,
            purchasedRemainingCents: 0,
            resetsAt: "2026-10-01T00:00:00Z",
            paused: false,
          },
        })}
        error={null}
        onRefresh={() => {}}
      />,
    );
    expect(screen.getByText("$60.00 left")).toBeTruthy();
    expect(screen.getByText("$40.00 of $100.00")).toBeTruthy();
  });

  it("a purchase raises what's left without changing what's included", () => {
    render(
      <ManagerUsagePanel
        summary={summary({
          communication: {
            remainingCents: 12_000,
            includedUsedCents: 0,
            includedAllowanceCents: 10_000,
            purchasedRemainingCents: 2_000,
            resetsAt: "2026-10-01T00:00:00Z",
            paused: false,
          },
        })}
        error={null}
        onRefresh={() => {}}
      />,
    );
    expect(screen.getByText("$120.00 left")).toBeTruthy();
    expect(screen.getByText("$0.00 of $100.00")).toBeTruthy();
  });

  it("Communication reads Paused instead of a dollar figure while purchases are paused", () => {
    render(
      <ManagerUsagePanel
        summary={summary({ communication: { ...summary().communication, paused: true } })}
        error={null}
        onRefresh={() => {}}
      />,
    );
    expect(screen.getByText("Paused")).toBeTruthy();
  });
});

describe("ManagerExtraUsagePanel", () => {
  it("rejects a below-minimum amount", () => {
    render(<ManagerExtraUsagePanel summary={summary()} load={async () => null} />);
    const input = screen.getByLabelText("Credit amount in dollars") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "4" } });
    fireEvent.click(screen.getByText("Update usage"));
    expect(screen.getByText("Enter a whole-dollar amount from $5 to $500.")).toBeTruthy();
  });

  it("rejects an above-maximum amount", () => {
    render(<ManagerExtraUsagePanel summary={summary()} load={async () => null} />);
    const input = screen.getByLabelText("Credit amount in dollars") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "501" } });
    fireEvent.click(screen.getByText("Update usage"));
    expect(screen.getByText("Enter a whole-dollar amount from $5 to $500.")).toBeTruthy();
  });

  it("rejects a non-whole-dollar amount", () => {
    render(<ManagerExtraUsagePanel summary={summary()} load={async () => null} />);
    const input = screen.getByLabelText("Credit amount in dollars") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "20.50" } });
    fireEvent.click(screen.getByText("Update usage"));
    expect(screen.getByText("Enter a whole-dollar amount from $5 to $500.")).toBeTruthy();
  });

  it("opens Stripe checkout for a valid whole-dollar amount (confirm even with a saved card)", async () => {
    render(<ManagerExtraUsagePanel summary={summary()} load={async () => null} />);
    const input = screen.getByLabelText("Credit amount in dollars") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "50" } });
    fireEvent.click(screen.getByText("Update usage"));
    expect(await screen.findByRole("dialog", { name: "Confirm payment" })).toBeTruthy();
  });

  it("buys for the chosen workspace and offers only workspaces this manager owns", async () => {
    render(<ManagerExtraUsagePanel summary={summary()} load={async () => null} />);
    fireEvent.click(screen.getByRole("button", { name: "Credit applies to" }));
    expect(screen.getAllByRole("option").map((option) => option.textContent)).toEqual([
      "✓Ballard",
      "Fremont",
    ]);
    const fremont = screen.getByRole("option", { name: "Fremont" });
    fireEvent.pointerDown(fremont, { pointerId: 1, clientX: 10, clientY: 10 });
    fireEvent.pointerUp(fremont, { pointerId: 1, clientX: 10, clientY: 10 });
    fireEvent.change(screen.getByLabelText("Credit amount in dollars"), { target: { value: "50" } });
    fireEvent.click(screen.getByText("Update usage"));
    expect(await screen.findByRole("dialog", { name: "Confirm payment" })).toBeTruthy();
    const checkoutCall = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.find(
      (call) => String(call[0]).includes("/api/manager/comms-billing/checkout"),
    );
    expect(JSON.parse(String((checkoutCall?.[1] as RequestInit).body))).toMatchObject({
      creditCents: 5_000,
      workspaceId: "ws-second",
    });
  });

  it("hides the Update usage row on native", () => {
    native.value = true;
    render(<ManagerExtraUsagePanel summary={summary()} load={async () => null} />);
    expect(screen.queryByLabelText("Credit amount in dollars")).toBeNull();
    expect(screen.getByText("Managed on the web")).toBeTruthy();
  });

  it("reads Paused instead of the Update usage control while purchases are paused", () => {
    render(
      <ManagerExtraUsagePanel
        summary={summary({ communication: { ...summary().communication, paused: true } })}
        load={async () => null}
      />,
    );
    expect(screen.getByText("Paused")).toBeTruthy();
    expect(screen.queryByLabelText("Credit amount in dollars")).toBeNull();
  });
});
