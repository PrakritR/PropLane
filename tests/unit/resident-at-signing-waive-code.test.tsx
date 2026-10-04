// @vitest-environment jsdom
//
// MONEY (UI half): "Have a waive code?" on the pay-before-signing step. The resident types a code, the server
// decides, and on success the lease fee drops out of the total.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { HouseholdCharge } from "@/lib/household-charges";

const toast = vi.hoisted(() => vi.fn());
vi.mock("@/components/providers/app-ui-provider", () => ({ useAppUi: () => ({ showToast: toast }) }));
vi.mock("@/components/stripe-embedded-checkout", () => ({
  StripeEmbeddedCheckout: ({ clientSecret }: { clientSecret: string }) => <div data-testid="stripe">{clientSecret}</div>,
}));

import { ResidentSignAndPayMoveIn } from "@/components/portal/resident-sign-and-pay-move-in";

function line(id: string, kind: HouseholdCharge["kind"], title: string, amount: string, over: Partial<HouseholdCharge> = {}): HouseholdCharge {
  return {
    id,
    createdAt: "2026-10-03T00:00:00.000Z",
    applicationId: "AXIS-APP-1",
    residentEmail: "signer@example.com",
    residentName: "Signer",
    residentUserId: "u1",
    propertyId: "prop-1",
    propertyLabel: "Cascade Lofts",
    managerUserId: "m1",
    kind,
    title,
    amountLabel: amount,
    balanceLabel: amount,
    status: "pending",
    blocksLeaseUntilPaid: false,
    dueAtSigning: true,
    axisPaymentsEnabledSnapshot: true,
    managerStripeConnectReadySnapshot: true,
    ...over,
  };
}

const fee = line("c1", "lease_fee", "Lease fee", "$300.00");
const deposit = line("c2", "security_deposit", "Security deposit", "$500.00");

const fetchMock = vi.fn();
beforeEach(() => {
  fetchMock.mockReset();
  toast.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function mount(over: { leaseId?: string | null; charges?: HouseholdCharge[]; onFeeWaived?: () => void } = {}) {
  return render(
    <ResidentSignAndPayMoveIn
      email="signer@example.com"
      signed={false}
      mode="at-signing"
      charges={over.charges ?? [fee, deposit]}
      leaseId={"leaseId" in over ? over.leaseId : "lease-1"}
      onFeeWaived={over.onFeeWaived}
    />,
  );
}

describe("Have a waive code?", () => {
  it("is offered while a lease fee is owed", () => {
    mount();
    expect(screen.getByRole("button", { name: "Have a waive code?" })).toBeTruthy();
  });

  it("is not offered without a lease to send it for, or when no lease fee is owed", () => {
    mount({ leaseId: null });
    expect(screen.queryByRole("button", { name: "Have a waive code?" })).toBeNull();
    cleanup();
    mount({ charges: [deposit] });
    expect(screen.queryByRole("button", { name: "Have a waive code?" })).toBeNull();
    cleanup();
    // A fee a manager already waived is cancelled and never reaches this list; a stale one is not offered either.
    mount({ charges: [{ ...fee, waivedAt: "2026-10-03T00:00:00.000Z" }, deposit] });
    expect(screen.queryByRole("button", { name: "Have a waive code?" })).toBeNull();
  });

  it("sends only the lease id and the typed code, then asks the page to re-read the charges", async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ ok: true, waived: true }) });
    const onFeeWaived = vi.fn();
    mount({ onFeeWaived });
    fireEvent.click(screen.getByRole("button", { name: "Have a waive code?" }));
    fireEvent.change(screen.getByLabelText("Waive code"), { target: { value: "spring25" } });
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    await waitFor(() => expect(onFeeWaived).toHaveBeenCalledTimes(1));
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("/api/resident/lease-fee-waiver-code");
    expect(JSON.parse(init.body as string)).toEqual({ leaseId: "lease-1", code: "SPRING25" });
    expect(toast).toHaveBeenCalledWith("Lease fee waived.");
  });

  it("shows the server's reason and changes nothing when the code is refused", async () => {
    fetchMock.mockResolvedValue({ ok: false, json: async () => ({ error: "That code has expired.", code: "EXPIRED" }) });
    const onFeeWaived = vi.fn();
    mount({ onFeeWaived });
    fireEvent.click(screen.getByRole("button", { name: "Have a waive code?" }));
    fireEvent.change(screen.getByLabelText("Waive code"), { target: { value: "OLDCODE" } });
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toBe("That code has expired."));
    expect(onFeeWaived).not.toHaveBeenCalled();
    // The total is still the full amount.
    expect(screen.getByText("Total $800.00")).toBeTruthy();
  });

  it("Apply stays off until a code is typed", () => {
    mount();
    fireEvent.click(screen.getByRole("button", { name: "Have a waive code?" }));
    expect((screen.getByRole("button", { name: "Apply" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("once the page re-reads the charges the fee is gone from the total and the code box is gone", () => {
    const { rerender } = mount();
    expect(screen.getByText("Total $800.00")).toBeTruthy();
    rerender(
      <ResidentSignAndPayMoveIn email="signer@example.com" signed={false} mode="at-signing" charges={[deposit]} leaseId="lease-1" />,
    );
    expect(screen.queryByText("Lease fee")).toBeNull();
    expect(screen.getByText("Total $500.00")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Have a waive code?" })).toBeNull();
  });

  it("drops an open checkout that was priced with the fee in it", async () => {
    fetchMock.mockImplementation(async (url: string) =>
      url === "/api/stripe/household-charge-checkout"
        ? { ok: true, json: async () => ({ clientSecret: "cs_old", subtotalCents: 80_000, processingFeeCents: 0, totalCents: 80_000 }) }
        : { ok: true, json: async () => ({ ok: true }) },
    );
    mount();
    fireEvent.click(screen.getByRole("button", { name: "Pay $800.00" }));
    await waitFor(() => expect(screen.getByTestId("stripe").textContent).toBe("cs_old"));
    // The code box is hidden while a Stripe session is open, so an old session can never outlive a waiver.
    expect(screen.queryByRole("button", { name: "Have a waive code?" })).toBeNull();
  });
});
