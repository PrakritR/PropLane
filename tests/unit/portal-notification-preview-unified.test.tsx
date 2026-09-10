/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const showToast = vi.fn();
vi.mock("@/components/providers/app-ui-provider", () => ({
  useAppUi: () => ({ showToast }),
}));

import { PortalNotificationPreviewModal } from "@/components/portal/portal-notification-preview-modal";

/**
 * Every message popup shares one field set: To / Subject / Send via / Message /
 * Don't message … / Schedule for later. Surfaces used to differ — a work-number
 * row on some, an intro paragraph on others, and a Schedule checkbox that some
 * call sites switched off entirely.
 */
function renderModal(props: Partial<Parameters<typeof PortalNotificationPreviewModal>[0]> = {}) {
  const onConfirm = vi.fn();
  render(
    <PortalNotificationPreviewModal
      open
      title="Delete tour"
      onClose={() => {}}
      recipient="guest@example.com"
      recipientPhone="+12065550110"
      subject="Your PropLane tour request was removed"
      body="The property manager removed your tour request."
      skipMessageLabel="Don't message guest"
      confirmLabel="Delete tour & send notification"
      onConfirm={onConfirm}
      {...props}
    />,
  );
  return { onConfirm };
}

beforeEach(() => {
  showToast.mockClear();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (String(url).includes("/api/manager/messaging-number")) {
        return new Response(
          JSON.stringify({ canSend: true, number: { phoneNumber: "+12065550000" } }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("PortalNotificationPreviewModal", () => {
  it("never shows a work number or its copy hint", async () => {
    renderModal();

    await waitFor(() => expect(screen.getByText("Message")).toBeInTheDocument());
    expect(screen.queryByText("Work number")).toBeNull();
    expect(screen.queryByText(/Click the number to copy/i)).toBeNull();
  });

  it("offers Schedule for later with no call site able to switch it off", async () => {
    renderModal();

    await waitFor(() =>
      expect(document.querySelector("[data-attr='portal-notification-schedule-later']")).toBeTruthy(),
    );
  });

  it("schedules the message and completes the action without sending now", async () => {
    const { onConfirm } = renderModal();

    const schedule = await waitFor(() => {
      const el = document.querySelector("[data-attr='portal-notification-schedule-later']");
      if (!el) throw new Error("no schedule checkbox");
      return el as HTMLInputElement;
    });
    await userEvent.click(schedule);

    // A scheduled send says Schedule, not "Delete tour & send notification".
    const confirm = screen.getByRole("button", { name: "Schedule" });
    await userEvent.click(confirm);

    const scheduleCall = await waitFor(() => {
      const call = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.find(
        ([url]) => url === "/api/portal/scheduled-inbox-messages",
      );
      if (!call) throw new Error("no schedule request");
      return call as [string, RequestInit];
    });
    const [, init] = scheduleCall;
    const payload = JSON.parse(String(init.body)) as { recipientEmail: string; sendAt: string };
    expect(payload.recipientEmail).toBe("guest@example.com");
    expect(Date.parse(payload.sendAt)).toBeGreaterThan(Date.now());

    // skipMessage true: the tour is still deleted, but the popup already owns
    // delivery, so the surface must not also send its own message now.
    await waitFor(() => expect(onConfirm).toHaveBeenCalled());
    expect(onConfirm.mock.calls[0]![0]).toBe(true);
  });

  it("refuses to schedule a recipient with no email address", async () => {
    const { onConfirm } = renderModal({ recipient: "", emailAvailable: false });

    const schedule = await waitFor(() => {
      const el = document.querySelector("[data-attr='portal-notification-schedule-later']");
      if (!el) throw new Error("no schedule checkbox");
      return el as HTMLInputElement;
    });
    await userEvent.click(schedule);

    expect(screen.getByText(/Scheduling needs an email address/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Schedule" })).toBeDisabled();
    expect(onConfirm).not.toHaveBeenCalled();
  });
});
