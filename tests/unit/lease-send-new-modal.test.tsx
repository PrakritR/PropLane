// @vitest-environment jsdom
// Send new lease: the signed lease's replacement opens in the standard pop-up (Lease · Terms · Review & send),
// with the "Resident sees" preview, the header Upload icon and the terms prefilled from the current lease.
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { AppUiProvider } from "@/components/providers/app-ui-provider";
import { SendNewLeaseModal } from "@/components/portal/lease-send-new-modal";
import type { LeasePipelineRow } from "@/lib/lease-pipeline-storage";

afterEach(async () => {
  cleanup();
  await act(async () => {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  });
});

const row = {
  id: "lease-1",
  axisId: "AXIS-1",
  residentName: "Maya Chen",
  residentEmail: "maya@example.com",
  unit: "Room 1 · Alder Row",
  propertyId: "prop-1",
  status: "Fully Signed",
  bucket: "signed",
  signedRentLabel: "$1,150 / month",
  application: { leaseTerm: "12 Months", leaseStart: "2026-10-05", leaseEnd: "2027-10-05" },
} as unknown as LeasePipelineRow;

function mount() {
  return render(
    <AppUiProvider>
      <SendNewLeaseModal row={row} managerUserId="mgr-1" onClose={() => {}} onCreated={() => {}} onNeedsSendScreen={vi.fn()} />
    </AppUiProvider>,
  );
}

describe("Send new lease pop-up", () => {
  it("opens in the standard shell: Lease · Terms · Review & send, the Resident sees preview and one header Upload icon", async () => {
    mount();
    await waitFor(() => expect(screen.getByText("Send new lease")).toBeTruthy());
    for (const label of ["Lease", "Terms", "Review & send"]) {
      expect(screen.getAllByText(label).length).toBeGreaterThan(0);
    }
    expect(screen.getByText("Resident sees")).toBeTruthy();
    expect(document.querySelector('[data-attr="lease-send-new-header-upload"]')).not.toBeNull();
    expect(screen.queryByText("New terms")).toBeNull();
  });

  it("the Terms step is prefilled from the current lease: day after it ends and its rent", async () => {
    mount();
    await waitFor(() => expect(screen.getByText("Send new lease")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: /next/i }));
    await waitFor(() => expect(document.querySelector('[data-attr="lease-send-new-terms"]')).not.toBeNull());
    const start = document.querySelector('input[type="date"]') as HTMLInputElement;
    expect(start.value).toBe("2027-10-06");
    expect((document.querySelector('[data-attr="lease-renew-rent"]') as HTMLInputElement).value).toBe("1150");
  });
});
