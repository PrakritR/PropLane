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

import { PortalPayOutSheet } from "@/components/portal/portal-pay-out-sheet";

const eligibleBank = { last4: "4421", bankName: "Chase", accountType: "checking", instantEligible: true };

function baseProps(overrides: Partial<ComponentProps<typeof PortalPayOutSheet>> = {}) {
  return {
    open: true,
    onClose: vi.fn(),
    apiBase: "/api/stripe",
    currency: "usd",
    availableCents: 428_000,
    instantAvailableCents: 115_000,
    bank: eligibleBank,
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

describe("PortalPayOutSheet", () => {
  it("prefills the available amount, shows the button carrying it, and the Instant cap", () => {
    render(<PortalPayOutSheet {...baseProps()} />);
    expect(screen.getByDisplayValue("4280.00")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Pay out $4,280.00" })).toBeInTheDocument();
    expect(screen.getByText("up to $1,150.00 now")).toBeInTheDocument();
  });

  it("computes the 1% fee and net when Instant is picked", () => {
    render(<PortalPayOutSheet {...baseProps({ availableCents: 100_000, instantAvailableCents: 100_000 })} />);
    fireEvent.change(screen.getByLabelText("Amount"), { target: { value: "100.00" } });
    fireEvent.click(screen.getByRole("radio", { name: /Instant/ }));
    expect(screen.getByText("$1.00 fee (1%)", { exact: false })).toBeInTheDocument();
    expect(screen.getByText("$99.00")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Pay out $100.00" })).toBeInTheDocument();
  });

  it("disables Instant and states the reason when the amount exceeds the Instant cap", () => {
    render(<PortalPayOutSheet {...baseProps({ availableCents: 428_000, instantAvailableCents: 50_000 })} />);
    fireEvent.change(screen.getByLabelText("Amount"), { target: { value: "4280.00" } });
    expect(screen.getByRole("radio", { name: /Instant/ })).toBeDisabled();
    expect(screen.getByText("up to $500.00 now")).toBeInTheDocument();
  });

  it("disables Instant with its own reason when the bank cannot receive it", () => {
    render(<PortalPayOutSheet {...baseProps({ bank: { ...eligibleBank, instantEligible: false } })} />);
    expect(screen.getByRole("radio", { name: /Instant/ })).toBeDisabled();
    expect(screen.getByText("This bank cannot receive Instant payouts")).toBeInTheDocument();
  });

  it("All resets the amount back to everything available", () => {
    render(<PortalPayOutSheet {...baseProps()} />);
    fireEvent.change(screen.getByLabelText("Amount"), { target: { value: "10.00" } });
    fireEvent.click(screen.getByRole("button", { name: "All" }));
    expect(screen.getByDisplayValue("4280.00")).toBeInTheDocument();
  });

  it("submits amountCents and method, and reports the server's numbers on success", async () => {
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
    render(<PortalPayOutSheet {...baseProps({ onSuccess })} />);
    fireEvent.click(screen.getByRole("button", { name: "Pay out $4,280.00" }));
    await vi.waitFor(() => expect(onSuccess).toHaveBeenCalledWith({ payoutId: "po_1", amountCents: 428_000, method: "standard" }));
    const [, init] = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(JSON.parse(init.body as string)).toEqual({ amountCents: 428_000, method: "standard" });
  });

  it("renders a 422 refusal as one line and does not close", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ error: "Balance changed — try again." }), { status: 422 })),
    );
    const onSuccess = vi.fn();
    render(<PortalPayOutSheet {...baseProps({ onSuccess })} />);
    fireEvent.click(screen.getByRole("button", { name: "Pay out $4,280.00" }));
    await screen.findByText("Balance changed — try again.");
    expect(onSuccess).not.toHaveBeenCalled();
  });
});
