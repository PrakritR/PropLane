// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";

const setFee = vi.fn();
const removeFee = vi.fn();
const deliver = vi.fn();

vi.mock("@/components/providers/app-ui-provider", () => ({
  useAppUi: () => ({ showToast: vi.fn() }),
}));

vi.mock("@/lib/demo/demo-session", () => ({
  isDemoModeActive: () => false,
}));

vi.mock("@/lib/household-charges", () => ({
  listingHoldingDepositAvailable: (propertyId: string) => propertyId === "prop-with-hold",
  listingHoldingDepositAmount: () => ({ amount: 500, displayLabel: "$500.00" }),
  findHoldingDepositCharge: () => undefined,
  setApplicantHoldingFee: (...args: unknown[]) => setFee(...args),
  removeApplicantHoldingFee: (...args: unknown[]) => removeFee(...args),
}));

vi.mock("@/lib/portal-message-delivery", () => ({
  buildHoldingFeeNoticeBody: () => "Please pay your holding fee.",
  deliverPortalInboxMessage: (...args: unknown[]) => deliver(...args),
}));

import { ApplicationHoldingFeeToggle } from "@/components/portal/application-holding-fee-box";

const ROW = {
  id: "APP-1",
  email: "applicant@test.proplane.local",
  name: "Test Applicant",
  residentUserId: null,
  managerUserId: "mgr-1",
  propertyId: "prop-with-hold",
  application: { propertyId: "prop-with-hold" },
};

beforeEach(() => {
  setFee.mockReset();
  removeFee.mockReset();
  deliver.mockResolvedValue({ ok: true });
  setFee.mockReturnValue({
    ok: true,
    alreadyPaid: false,
    charge: { amountLabel: "$500.00", propertyLabel: "Test House" },
  });
});

afterEach(() => cleanup());

describe("ApplicationHoldingFeeToggle", () => {
  it("renders nothing when the listing has no holding deposit", () => {
    render(
      <ApplicationHoldingFeeToggle
        row={{ ...ROW, propertyId: "prop-no-hold", application: { propertyId: "prop-no-hold" } }}
      />,
    );
    expect(document.querySelector('[data-attr="application-holding-fee-toggle"]')).toBeNull();
  });

  it("creates a charge at the listing amount when checked", async () => {
    render(<ApplicationHoldingFeeToggle row={ROW} />);
    const checkbox = document.querySelector(
      'input[data-attr="application-holding-fee-checkbox"]',
    ) as HTMLInputElement;
    expect(checkbox).not.toBeNull();
    fireEvent.click(checkbox!);
    await Promise.resolve();
    expect(setFee).toHaveBeenCalledWith(
      expect.objectContaining({ amount: 500, applicationId: "APP-1" }),
    );
    expect(deliver).toHaveBeenCalled();
  });
});
