// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const showToast = vi.fn();

vi.mock("next/navigation", () => ({
  usePathname: () => "/portal/communication",
}));
vi.mock("@/components/providers/app-ui-provider", () => ({
  useAppUi: () => ({ showToast }),
}));
vi.mock("@/lib/demo/demo-session", async (importOriginal) => ({
  // Spread the real module: this file only needs to override demo mode,
  // and a hand-listed mock silently breaks every time the module gains an
  // export a component calls at import time.
  ...(await importOriginal<typeof import("@/lib/demo/demo-session")>()),
  isDemoModeActive: () => false,
}));

import { CommunicationSettingsPanel } from "@/components/portal/pro-portal-settings-panels";
import { DEFAULT_MANAGER_AUTOMATION_SETTINGS } from "@/lib/payment-automation-settings";
import type { ManagerMessagingNumberStatus } from "@/lib/sms/manager-messaging-number";

const readyNumber: ManagerMessagingNumberStatus = {
  mode: "automatic",
  workspaceRole: "primary",
  provisioningAvailable: true,
  sendingAvailable: true,
  planTier: "paid",
  entitlement: { eligible: true, tier: "pro", source: "stripe" },
  number: {
    state: "active",
    registrationState: "approved",
    carrierRegistrationState: "registered",
    attachmentState: "attached",
    phoneNumber: "+18559168031",
    lastError: null,
  },
  canRequest: false,
  canSend: true,
  personalPhone: { phone: null, verifiedAt: null, forwardInbound: false },
};

afterEach(() => {
  cleanup();
  showToast.mockReset();
  vi.unstubAllGlobals();
});

function stubPanelFetches(status: ManagerMessagingNumberStatus | null) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo) => {
      const url = String(input);
      if (url.includes("/api/portal/automation-settings")) {
        return Response.json({ settings: DEFAULT_MANAGER_AUTOMATION_SETTINGS });
      }
      if (url.includes("/api/manager/messaging-number")) {
        return status ? Response.json(status) : new Response("missing", { status: 404 });
      }
      return new Response("not found", { status: 404 });
    }),
  );
}

describe("CommunicationSettingsPanel work number", () => {
  it("shows the assigned work number even when SMS is not a default channel", async () => {
    stubPanelFetches(readyNumber);
    render(<CommunicationSettingsPanel />);

    expect(
      await screen.findByRole("button", { name: "Copy work number +1 (855) 916-8031" }),
    ).toBeTruthy();
  });

  it("copies the work number to the clipboard when the number is clicked", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", {
      clipboard: { writeText },
    });
    stubPanelFetches(readyNumber);
    render(<CommunicationSettingsPanel />);

    fireEvent.click(
      await screen.findByRole("button", { name: "Copy work number +1 (855) 916-8031" }),
    );

    await waitFor(() => expect(writeText).toHaveBeenCalledWith("+18559168031"));
    expect(showToast).toHaveBeenCalledWith("Work number copied.");
  });

  it("omits the copy control when no work number is assigned", async () => {
    stubPanelFetches({ ...readyNumber, number: null, canSend: false });
    render(<CommunicationSettingsPanel />);

    expect(await screen.findByText("Auto-send AI drafts")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Copy work number/ })).toBeNull();
  });
});
