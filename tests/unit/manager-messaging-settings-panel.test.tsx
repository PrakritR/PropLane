// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";

const showToast = vi.fn();

vi.mock("@/components/providers/app-ui-provider", () => ({
  useAppUi: () => ({ showToast }),
}));

import { ManagerMessagingSettingsPanel } from "@/components/portal/manager-messaging-settings-panel";
import type { ManagerMessagingNumberStatus } from "@/lib/sms/manager-messaging-number";

const pausedStatus: ManagerMessagingNumberStatus = {
  mode: "paused",
  workspaceRole: "primary",
  provisioningAvailable: false,
  entitlement: { eligible: true, tier: "pro", source: "stripe" },
  number: null,
  canRequest: false,
  canSend: false,
  personalPhone: {
    phone: "+15105550123",
    verifiedAt: "2026-08-25T12:00:00.000Z",
    forwardInbound: true,
  },
};

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("ManagerMessagingSettingsPanel", () => {
  it("shows a paused rollout without offering a provisioning action", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json(pausedStatus)),
    );
    render(<ManagerMessagingSettingsPanel />);

    expect(
      await screen.findByText(
        "Dedicated number setup is in a limited rollout.",
        { exact: false },
      ),
    ).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: "Request work number" }),
    ).toBeNull();
    expect(screen.queryByText("+1 (510) 555-0123 · Verified")).toBeNull();
  });

  it("requests a number only from the explicit setup button", async () => {
    const readyToRequest: ManagerMessagingNumberStatus = {
      ...pausedStatus,
      mode: "automatic",
      canRequest: true,
    };
    const requested: ManagerMessagingNumberStatus = {
      ...readyToRequest,
      number: {
        state: "pending_registration",
        registrationState: "pending",
        carrierRegistrationState: "not_submitted",
        attachmentState: "not_attached",
        phoneNumber: null,
        lastError: null,
      },
      canRequest: false,
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(Response.json(readyToRequest))
      .mockResolvedValueOnce(Response.json(requested));
    vi.stubGlobal("fetch", fetchMock);
    render(<ManagerMessagingSettingsPanel />);

    const request = await screen.findByRole("button", {
      name: "Request work number",
    });
    expect((screen.getByLabelText("Preferred area code (optional)") as HTMLInputElement).value).toBe("510");
    fireEvent.click(request);

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(fetchMock.mock.calls[0]?.[1]).not.toMatchObject({ method: "POST" });
    expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({ method: "POST" });
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toEqual({
      action: "request_number",
      areaCode: "510",
    });
    expect(await screen.findByText("Request received")).toBeTruthy();
  });

  it("explains that co-managers cannot configure the workspace number", async () => {
    const actorScopedStatus: ManagerMessagingNumberStatus = {
      ...pausedStatus,
      workspaceRole: "co_manager",
      number: {
        state: "active",
        registrationState: "approved",
        carrierRegistrationState: "registered",
        attachmentState: "attached",
        phoneNumber: "+12065550999",
        lastError: null,
      },
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json(actorScopedStatus)),
    );
    render(<ManagerMessagingSettingsPanel />);

    expect(
      await screen.findByText(
        "The primary property manager manages messaging.",
      ),
    ).toBeTruthy();
    expect(
      screen.getByText(
        "Ask them to request or manage the work number for this workspace.",
      ),
    ).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: "Request work number" }),
    ).toBeNull();
    expect(screen.getByRole("heading", { name: "Work number" })).toBeTruthy();
    expect(screen.queryByText("Carrier registration")).toBeNull();
    expect(screen.queryByText("Personal phone")).toBeNull();
    expect(screen.queryByText("Inbound forwarding")).toBeNull();
    expect(screen.queryByText("+1 (206) 555-0999")).toBeNull();
    expect(screen.queryByText("+1 (510) 555-0123 · Verified")).toBeNull();
  });

  it("opens a resident-announce dialog after a number is assigned", async () => {
    const readyToRequest: ManagerMessagingNumberStatus = {
      ...pausedStatus,
      mode: "automatic",
      provisioningAvailable: true,
      canRequest: true,
    };
    const assigned: ManagerMessagingNumberStatus = {
      ...readyToRequest,
      canRequest: false,
      number: {
        state: "active",
        registrationState: "approved",
        carrierRegistrationState: "registered",
        attachmentState: "attached",
        phoneNumber: "+15105550199",
        lastError: null,
      },
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(Response.json(readyToRequest))
      .mockResolvedValueOnce(Response.json(assigned));
    vi.stubGlobal("fetch", fetchMock);
    render(<ManagerMessagingSettingsPanel />);

    fireEvent.click(await screen.findByRole("button", { name: "Request work number" }));
    expect(await screen.findByRole("dialog")).toBeTruthy();
    expect(
      screen.getByText("Want to send a message to all your residents to text this new number now?"),
    ).toBeTruthy();
    expect(screen.getByText(/Please text me at this new number:/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Notify all residents" })).toBeTruthy();
  });

  it("refreshes eligibility for an assigned number without requesting another number", async () => {
    const ineligible: ManagerMessagingNumberStatus = {
      ...pausedStatus,
      entitlement: { eligible: false, reason: "past_due" },
      number: {
        state: "active",
        registrationState: "approved",
        carrierRegistrationState: "registered",
        attachmentState: "attached",
        phoneNumber: "+12065550123",
        lastError: null,
      },
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(Response.json(ineligible))
      .mockResolvedValueOnce(Response.json(ineligible));
    vi.stubGlobal("fetch", fetchMock);
    render(<ManagerMessagingSettingsPanel />);

    fireEvent.click(
      await screen.findByRole("button", { name: "Refresh eligibility" }),
    );
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toEqual({
      action: "refresh_eligibility",
    });
  });

  it("gives ineligible managers a direct path to billing", async () => {
    const ineligible: ManagerMessagingNumberStatus = {
      ...pausedStatus,
      entitlement: { eligible: false, reason: "free" },
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json(ineligible)),
    );
    render(<ManagerMessagingSettingsPanel />);

    const link = await screen.findByRole("link", { name: "View plans" });
    expect(link.getAttribute("href")).toBe("/portal/profile?tab=billing");
  });
});
