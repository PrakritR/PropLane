// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { MANAGER_NOTIFICATION_CATEGORIES } from "@/lib/manager-notification-preferences";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ManagerNotificationRoutingSetting } from "@/components/portal/pro-notification-routing-setting";
import { DEFAULT_MANAGER_AUTOMATION_SETTINGS } from "@/lib/payment-automation-settings";
import type { ManagerMessagingNumberStatus } from "@/lib/sms/manager-messaging-number";

const showToast = vi.fn();

vi.mock("@/components/providers/app-ui-provider", () => ({
  useAppUi: () => ({ showToast }),
}));

const numberStatus: ManagerMessagingNumberStatus = {
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
  personalPhone: {
    phone: "+13175550123",
    verifiedAt: "2026-09-01T12:00:00.000Z",
    forwardInbound: true,
  },
};

afterEach(() => {
  cleanup();
  showToast.mockReset();
  vi.unstubAllGlobals();
});

describe("ManagerNotificationRoutingSetting", () => {
  it("shows the automatic phone route and all topic controls", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo) =>
        String(input).includes("messaging-number")
          ? Response.json(numberStatus)
          : Response.json({ settings: DEFAULT_MANAGER_AUTOMATION_SETTINGS }),
      ),
    );

    render(<ManagerNotificationRoutingSetting />);

    expect(await screen.findByText("Phone connection ready")).toBeTruthy();
    // The default is Both — PropLane plus a copy to the manager's phone.
    expect(screen.getByRole("radio", { name: /^Both/ })).toHaveProperty("checked", true);
    expect(screen.getByRole("radio", { name: /^PropLane Assistant/ })).toHaveProperty("checked", false);
    expect(screen.getByRole("radio", { name: /No updates/ })).toBeTruthy();
    expect(screen.getAllByRole("checkbox")).toHaveLength(MANAGER_NOTIFICATION_CATEGORIES.length);
    expect(screen.getByRole("radio", { name: /^Off/ })).toHaveProperty("checked", true);
  });

  it("saves a destination and per-topic text selection", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo, init?: RequestInit) => {
      const url = String(input);
      if (init?.method === "PATCH") {
        const patch = JSON.parse(String(init.body)) as Record<string, unknown>;
        return Response.json({ settings: { ...DEFAULT_MANAGER_AUTOMATION_SETTINGS, ...patch } });
      }
      return url.includes("messaging-number")
        ? Response.json(numberStatus)
        : Response.json({ settings: DEFAULT_MANAGER_AUTOMATION_SETTINGS });
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<ManagerNotificationRoutingSetting />);
    fireEvent.click(await screen.findByRole("radio", { name: /Both/ }));
    fireEvent.click(screen.getByRole("checkbox", { name: /Maintenance/ }));
    fireEvent.click(screen.getByRole("radio", { name: /^Weekly/ }));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(showToast).toHaveBeenCalledWith("Manager alert preferences saved."));
    const patchCall = fetchMock.mock.calls.find(([, init]) => init?.method === "PATCH");
    expect(patchCall).toBeTruthy();
    const body = JSON.parse(String(patchCall?.[1]?.body)) as {
      managerNotificationDestination: string;
      managerNotificationCategories: Record<string, boolean>;
      managerAttentionDigestCadence: string;
    };
    expect(body.managerNotificationDestination).toBe("both");
    expect(body.managerNotificationCategories.maintenance).toBe(false);
    expect(body.managerAttentionDigestCadence).toBe("weekly");
  });

  it("explains the Assistant fallback when work-number setup is incomplete", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo) =>
        String(input).includes("messaging-number")
          ? Response.json({ ...numberStatus, canSend: false, number: null })
          : Response.json({ settings: DEFAULT_MANAGER_AUTOMATION_SETTINGS }),
      ),
    );

    render(<ManagerNotificationRoutingSetting />);

    expect(await screen.findByText("Assistant fallback active")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Finish messaging setup" })).toBeTruthy();
  });
});
