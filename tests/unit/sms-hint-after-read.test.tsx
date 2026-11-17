/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";

vi.mock("@/components/providers/app-ui-provider", () => ({
  useAppUi: () => ({ showToast: vi.fn() }),
  useConfirm: () => () => Promise.resolve(true),
}));
vi.mock("next/navigation", () => ({ usePathname: () => "/portal/communication" }));
vi.mock("@/lib/shared-get-cache", () => ({ sharedGet: (...a: unknown[]) => sharedGet(...a), invalidateSharedGets: vi.fn() }));

const sharedGet = vi.fn();

import { PortalNotificationPreviewModal } from "@/components/portal/portal-notification-preview-modal";

function renderModal() {
  render(
    <PortalNotificationPreviewModal
      open
      title="Message"
      onClose={() => {}}
      recipient="a@example.com"
      recipientPhone="+12065550110"
      subject="Hi"
      body="Hello"
      showChannelPicker
      smsAvailable
      emailAvailable
      defaultViaSms
      skipMessageLabel="Skip"
      confirmLabel="Send"
      onConfirm={() => {}}
    />,
  );
}

afterEach(() => {
  cleanup();
  sharedGet.mockReset();
});

describe("SMS work-number hint waits for the read", () => {
  it("shows nothing while the status is loading", async () => {
    sharedGet.mockReturnValue(new Promise(() => {}));
    renderModal();
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByText(/SMS needs an active work number/)).toBeNull();
  });

  it("shows nothing when the read fails", async () => {
    sharedGet.mockRejectedValue(new Error("boom"));
    renderModal();
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByText(/SMS needs an active work number/)).toBeNull();
  });

  it("warns once the read says there is no number", async () => {
    sharedGet.mockResolvedValue({ ok: true, data: { canSend: false, lineReady: false, number: null } });
    renderModal();
    await waitFor(() => expect(screen.getByText(/SMS needs an active work number/)).toBeTruthy());
  });
});
