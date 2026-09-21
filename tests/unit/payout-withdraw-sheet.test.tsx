// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ComponentProps, ReactNode } from "react";

vi.mock("@/components/ui/modal", () => ({
  Modal: ({ open, children, footer }: { open: boolean; children: ReactNode; footer?: ReactNode }) =>
    open ? (
      <div role="dialog">
        {children}
        {footer}
      </div>
    ) : null,
  ModalFooter: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
vi.mock("@/lib/native/detect-native", () => ({ isNativeRuntimeSync: () => false }));

import { PayoutWithdrawSheet } from "@/components/portal/payout-withdraw-sheet";

const eligibleAccount = { id: "default", label: "Chase", last4: "4421", kind: "bank" as const, instantEligible: true };

function baseProps(overrides: Partial<ComponentProps<typeof PayoutWithdrawSheet>> = {}) {
  return {
    open: true,
    onClose: vi.fn(),
    apiBase: "/api/stripe",
    currency: "usd",
    availableCents: 428_000,
    instantAvailableCents: 115_000,
    accounts: [eligibleAccount],
    onSuccess: vi.fn(),
    ...overrides,
  };
}

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify({}), { status: 200 })),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("PayoutWithdrawSheet — amount step", () => {
  it("prefills the available amount (desktop text input) and shows the Instant cap", () => {
    render(<PayoutWithdrawSheet {...baseProps()} />);
    expect(screen.getByLabelText("Amount")).toHaveValue("4280.00");
    expect(screen.getByText("Up to $1,150.00 now")).toBeInTheDocument();
  });

  it("Max resets the amount back to everything available", () => {
    render(<PayoutWithdrawSheet {...baseProps()} />);
    fireEvent.change(screen.getByLabelText("Amount"), { target: { value: "10.00" } });
    fireEvent.click(screen.getByRole("button", { name: "Max" }));
    expect(screen.getByLabelText("Amount")).toHaveValue("4280.00");
  });

  it("disables Continue below the $1 minimum and above the available balance", () => {
    render(<PayoutWithdrawSheet {...baseProps()} />);
    fireEvent.change(screen.getByLabelText("Amount"), { target: { value: "0.50" } });
    expect(screen.getByRole("button", { name: "Continue" })).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Amount"), { target: { value: "5000.00" } });
    expect(screen.getByRole("button", { name: "Continue" })).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Amount"), { target: { value: "25.00" } });
    expect(screen.getByRole("button", { name: "Continue" })).not.toBeDisabled();
  });

  it("disables Instant and states the reason when the amount exceeds the Instant cap", () => {
    render(<PayoutWithdrawSheet {...baseProps({ availableCents: 428_000, instantAvailableCents: 50_000 })} />);
    fireEvent.change(screen.getByLabelText("Amount"), { target: { value: "4280.00" } });
    expect(screen.getByRole("radio", { name: /Instant/ })).toBeDisabled();
    expect(screen.getByText("Up to $500.00 now")).toBeInTheDocument();
  });

  it("disables Instant with its own reason when there is no debit card on file", () => {
    render(<PayoutWithdrawSheet {...baseProps({ accounts: [{ ...eligibleAccount, instantEligible: false }] })} />);
    expect(screen.getByRole("radio", { name: /Instant/ })).toBeDisabled();
    expect(screen.getByText("Add a debit card for Instant")).toBeInTheDocument();
  });
});

describe("PayoutWithdrawSheet — confirm step and submit", () => {
  it("Continue moves to a review step with Amount/Fee/Arrives/To, then Confirm withdrawal submits amountCents+method", async () => {
    const onSuccess = vi.fn();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({ payoutId: "po_1", amountCents: 428_000, feeCents: 0, netCents: 428_000, method: "standard" }),
          { status: 200 },
        ),
      ),
    );
    render(<PayoutWithdrawSheet {...baseProps({ onSuccess })} />);
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));

    expect(screen.getByText("Amount")).toBeInTheDocument();
    expect(document.querySelector('[data-attr="withdraw-c-amount"]')).toHaveTextContent("$4,280.00");
    expect(screen.getByText("Chase ····4421")).toBeInTheDocument();
    expect(
      (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.some(
        ([, init]) => (init as RequestInit | undefined)?.method === "POST",
      ),
    ).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: "Confirm withdrawal" }));
    await vi.waitFor(() =>
      expect(onSuccess).toHaveBeenCalledWith({ payoutId: "po_1", amountCents: 428_000, method: "standard" }),
    );
    const [, init] = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(JSON.parse(init.body as string)).toEqual({ amountCents: 428_000, method: "standard" });
  });

  it("computes the 1% Instant fee in the review step", () => {
    render(<PayoutWithdrawSheet {...baseProps({ availableCents: 100_000, instantAvailableCents: 100_000 })} />);
    fireEvent.click(screen.getByRole("radio", { name: /Instant/ }));
    fireEvent.change(screen.getByLabelText("Amount"), { target: { value: "100.00" } });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(screen.getByText("$1.00")).toBeInTheDocument();
    expect(screen.getByText("Within 30 minutes")).toBeInTheDocument();
  });

  it("renders a 422 refusal as one line, returns to the amount step, and does not report success", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ error: "Balance changed — try again." }), { status: 422 })),
    );
    const onSuccess = vi.fn();
    render(<PayoutWithdrawSheet {...baseProps({ onSuccess })} />);
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm withdrawal" }));
    await screen.findByText("Balance changed — try again.");
    expect(onSuccess).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Continue" })).toBeInTheDocument();
  });

  it("sends the picked destination's real id as destinationId, never the synthetic fallback id", async () => {
    const realAccount = { id: "ba_real_1", label: "Chase Checking", last4: "1487", kind: "bank" as const, instantEligible: false };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({ payoutId: "po_2", amountCents: 428_000, feeCents: 0, netCents: 428_000, method: "standard" }),
          { status: 200 },
        ),
      ),
    );
    render(<PayoutWithdrawSheet {...baseProps({ accounts: [realAccount] })} />);
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm withdrawal" }));
    await vi.waitFor(() =>
      expect((fetch as unknown as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1),
    );
    const [, init] = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(JSON.parse(init.body as string)).toEqual({
      amountCents: 428_000,
      method: "standard",
      destinationId: "ba_real_1",
    });
  });
});
