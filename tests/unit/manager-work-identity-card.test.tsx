// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import type { ManagerMessagingNumberStatus } from "@/lib/sms/manager-messaging-number";

const statusState = vi.fn();
vi.mock("@/hooks/use-manager-messaging-number-status", () => ({
  useManagerMessagingNumberStatus: () => statusState(),
}));
vi.mock("@/lib/demo/demo-session", () => ({
  isDemoModeActive: () => false,
}));

import { ManagerWorkNumberCard } from "@/components/portal/pro-work-number-card";

function status(overrides: Partial<ManagerMessagingNumberStatus> = {}): ManagerMessagingNumberStatus {
  return {
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
      phoneNumber: "+12069228062",
      lastError: null,
    },
    canRequest: false,
    requestedAtSignup: false,
    canSend: true,
    personalPhone: { phone: null, verifiedAt: null, forwardInbound: false },
    ...overrides,
  };
}

function assistantEmailPayload(address: string | null) {
  return {
    provisioningAvailable: true,
    sendingAvailable: true,
    receivingAvailable: true,
    storageReady: true,
    planTier: "paid",
    entitlement: { eligible: true, tier: "pro", source: "stripe" },
    workspaceRole: "primary",
    workspaceEmail: address ? { address, ownerUserId: "mgr-test", ownerName: "Alex" } : null,
    address,
    state: address ? "ready" : "unavailable",
    canRequest: false,
    canUse: Boolean(address),
    requestedAtSignup: false,
  };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  statusState.mockReset();
});

describe("ManagerWorkNumberCard identity", () => {
  it("shows work email on the same card and has no megaphone", async () => {
    statusState.mockReturnValue({
      ready: true,
      resolved: true,
      statusError: false,
      status: status(),
      retry: () => {},
    });
    const writeText = vi.fn(async () => undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo) => {
        const url = typeof input === "string" ? input : input.url;
        if (url.includes("/api/manager/assistant-email")) {
          return Response.json(assistantEmailPayload("inbox@axis.housing"));
        }
        return new Response(null, { status: 404 });
      }),
    );

    render(<ManagerWorkNumberCard />);

    expect(screen.getByText(/Your work number/)).toBeTruthy();
    await waitFor(() => {
      expect(screen.getByText("inbox@axis.housing")).toBeTruthy();
    });
    expect(screen.getByText("Your work email")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Tell residents" })).toBeNull();
    expect(screen.queryByRole("link", { name: "Tell residents about this number" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Copy email" }));
    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith("inbox@axis.housing");
    });
  });

  it("hides the email row when the workspace has no address", async () => {
    statusState.mockReturnValue({
      ready: true,
      resolved: true,
      statusError: false,
      status: status(),
      retry: () => {},
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json(assistantEmailPayload(null))),
    );

    render(<ManagerWorkNumberCard />);

    expect(screen.getByText(/Your work number/)).toBeTruthy();
    await waitFor(() => {
      expect(fetch).toHaveBeenCalled();
    });
    expect(screen.queryByText("Your work email")).toBeNull();
  });
});
