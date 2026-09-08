// @vitest-environment jsdom
//
// Holding fee must open PortalNotificationPreviewModal before writing the
// charge — same Tours / Add payment two-step pattern (PRP plan holding-fee-resident-message).
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const setApplicantHoldingFee = vi.fn();
const deliverPortalInboxMessage = vi.fn();
const showToast = vi.fn();

vi.mock("@/components/providers/app-ui-provider", () => ({
  useConfirm: () => (req: { description?: unknown }) =>
    Promise.resolve(
      typeof window === "undefined"
        ? true
        : window.confirm(typeof req?.description === "string" ? req.description : "Are you sure?"),
    ),

  useAppUi: () => ({ showToast }),
}));

vi.mock("@/lib/demo/demo-session", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/demo/demo-session")>()),
  isDemoModeActive: () => false,
}));

vi.mock("@/lib/household-charges", () => ({
  findHoldingDepositCharge: () => undefined,
  setApplicantHoldingFee: (...args: unknown[]) => setApplicantHoldingFee(...args),
  removeApplicantHoldingFee: () => ({ ok: true }),
}));

vi.mock("@/lib/portal-message-delivery", () => ({
  buildHoldingFeeNoticeBody: () => "Hi applicant,\n\nHolding deposit — $100.00",
  deliverPortalInboxMessage: (...args: unknown[]) => deliverPortalInboxMessage(...args),
}));

vi.mock("@/lib/rental-application/data", () => ({
  getPropertyById: () => ({ title: "4709A 8th Ave NE - Room 8", listingSubmission: null }),
}));

vi.mock("@/hooks/use-manager-communication-deliver-via", () => ({
  useManagerCommunicationDeliverVia: () => ({
    channelsFor: () => ({ viaEmail: true, viaSms: false }),
  }),
}));

import { ApplicationHoldingFeeModal } from "@/components/portal/application-holding-fee-box";

afterEach(() => {
  cleanup();
  setApplicantHoldingFee.mockReset();
  deliverPortalInboxMessage.mockReset();
  showToast.mockReset();
});

const ROW = {
  id: "app-veenu",
  name: "Veenu Jain",
  email: "veenu@example.com",
  residentUserId: null as string | null,
  managerUserId: "mgr-1",
  propertyId: "mgr-seed-4709a-8th-ave-ne",
  application: { propertyId: "mgr-seed-4709a-8th-ave-ne" },
};

async function confirmNotificationPreview() {
  await waitFor(() => {
    const el = document.querySelector(
      'button[data-attr="portal-notification-confirm"]',
    ) as HTMLButtonElement | null;
    if (!el || el.disabled) throw new Error("confirm not ready");
    fireEvent.click(el);
  });
}

describe("ApplicationHoldingFeeModal — preview before write", () => {
  it("opens notification preview without writing the charge yet", async () => {
    render(<ApplicationHoldingFeeModal row={ROW} open onClose={() => {}} />);

    const amount = document.querySelector(
      'input[data-attr="application-holding-fee-amount"]',
    ) as HTMLInputElement;
    expect(amount).not.toBeNull();
    fireEvent.change(amount, { target: { value: "100" } });

    fireEvent.click(document.querySelector('button[data-attr="application-holding-fee-preview"]')!);

    expect(setApplicantHoldingFee).not.toHaveBeenCalled();
    expect(screen.getByText(/Holding fee — notification preview/i)).toBeTruthy();
    await waitFor(() => {
      const subject = document.querySelector(
        'input[data-attr="portal-notification-subject"]',
      ) as HTMLInputElement | null;
      expect(subject?.value).toMatch(/Holding fee due: \$100\.00/i);
    });
  });

  it("writes the fee and sends notice on confirm", async () => {
    setApplicantHoldingFee.mockReturnValue({
      ok: true,
      alreadyPaid: false,
      charge: {
        amountLabel: "$100.00",
        residentName: "Veenu Jain",
        propertyLabel: "4709A 8th Ave NE - Room 8",
      },
    });
    deliverPortalInboxMessage.mockResolvedValue({ ok: true });

    render(<ApplicationHoldingFeeModal row={ROW} open onClose={() => {}} />);

    fireEvent.change(document.querySelector('input[data-attr="application-holding-fee-amount"]')!, {
      target: { value: "100" },
    });
    fireEvent.click(document.querySelector('button[data-attr="application-holding-fee-preview"]')!);

    await confirmNotificationPreview();

    await waitFor(() => {
      expect(setApplicantHoldingFee).toHaveBeenCalledWith(
        expect.objectContaining({ amount: 100, applicationId: "app-veenu" }),
      );
    });
    await waitFor(() => {
      expect(deliverPortalInboxMessage).toHaveBeenCalled();
    });
  });

  it("writes the fee without messaging when skip is checked", async () => {
    setApplicantHoldingFee.mockReturnValue({
      ok: true,
      alreadyPaid: false,
      charge: {
        amountLabel: "$100.00",
        residentName: "Veenu Jain",
        propertyLabel: "4709A 8th Ave NE - Room 8",
      },
    });

    render(<ApplicationHoldingFeeModal row={ROW} open onClose={() => {}} />);

    fireEvent.change(document.querySelector('input[data-attr="application-holding-fee-amount"]')!, {
      target: { value: "100" },
    });
    fireEvent.click(document.querySelector('button[data-attr="application-holding-fee-preview"]')!);

    fireEvent.click(document.querySelector('input[data-attr="portal-notification-skip-message"]')!);
    await confirmNotificationPreview();

    await waitFor(() => {
      expect(setApplicantHoldingFee).toHaveBeenCalled();
    });
    expect(deliverPortalInboxMessage).not.toHaveBeenCalled();
    expect(showToast).toHaveBeenCalledWith(expect.stringMatching(/no notification sent/i));
  });
});
