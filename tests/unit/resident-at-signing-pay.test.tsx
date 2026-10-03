// @vitest-environment jsdom
//
// MONEY (UI half): the "Pay before you sign" card on the resident's lease / sign-and-pay page.
// The itemized lines ARE the amount - Charges is their sum, the Stripe session is asked for exactly those
// charge ids, and Sign stays off while any at-signing line is unpaid.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { HouseholdCharge } from "@/lib/household-charges";

vi.mock("@/components/providers/app-ui-provider", () => ({ useAppUi: () => ({ showToast: vi.fn() }) }));
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

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockResolvedValue({
    ok: true,
    json: async () => ({ clientSecret: "cs_test_123", subtotalCents: 85_000, processingFeeCents: 0, totalCents: 85_000 }),
  });
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Pay before you sign", () => {
  const charges = [
    line("c1", "lease_fee", "Lease fee", "$300.00"),
    line("c2", "security_deposit", "Security deposit", "$500.00"),
    line("c3", "move_in_fee", "Move-in cost", "$50.00"),
  ];

  it("itemizes every at-signing line and shows the sum as the amount to pay", () => {
    render(<ResidentSignAndPayMoveIn email="signer@example.com" signed={false} mode="at-signing" charges={charges} />);
    expect(screen.getByText("Pay before you sign")).toBeTruthy();
    for (const title of ["Lease fee", "Security deposit", "Move-in cost"]) expect(screen.getByText(title)).toBeTruthy();
    expect(screen.getByText("Charges $850.00")).toBeTruthy();
    expect(screen.getByText("Total $850.00")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Pay $850.00" })).toBeTruthy();
  });

  it("asks Stripe for exactly those charges in ONE checkout", async () => {
    render(<ResidentSignAndPayMoveIn email="signer@example.com" signed={false} mode="at-signing" charges={charges} />);
    fireEvent.click(screen.getByRole("button", { name: "Pay $850.00" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("/api/stripe/household-charge-checkout");
    expect(JSON.parse(init.body as string).chargeIds).toEqual(["c1", "c2", "c3"]);
    await waitFor(() => expect(screen.getByTestId("stripe").textContent).toBe("cs_test_123"));
  });

  it("a waived (absent) lease fee drops out of the total", () => {
    render(<ResidentSignAndPayMoveIn email="signer@example.com" signed={false} mode="at-signing" charges={charges.slice(1)} />);
    expect(screen.queryByText("Lease fee")).toBeNull();
    expect(screen.getByText("Total $550.00")).toBeTruthy();
  });

  it("shows nothing when nothing is due at signing", () => {
    const { container } = render(<ResidentSignAndPayMoveIn email="signer@example.com" signed={false} mode="at-signing" charges={[]} />);
    expect(container.innerHTML).toBe("");
  });

  it("a bank transfer already clearing is not asked for twice", () => {
    render(
      <ResidentSignAndPayMoveIn
        email="signer@example.com"
        signed={false}
        mode="at-signing"
        charges={charges.map((c) => ({ ...c, status: "processing" as const }))}
      />,
    );
    const button = screen.getByRole("button", { name: "Bank transfer clearing" }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
  });
});
