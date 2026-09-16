// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import type { ManagerMessagingNumberStatus } from "@/lib/sms/manager-messaging-number";

vi.mock("next/link", () => ({
  default: ({
    href,
    children,
    ...rest
  }: {
    href: string;
    children: React.ReactNode;
  }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

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

function stubEmail(address: string | null) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo) => {
      const url = typeof input === "string" ? input : input.url;
      if (url.includes("/api/manager/assistant-email")) {
        return Response.json(assistantEmailPayload(address));
      }
      return new Response(null, { status: 404 });
    }),
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  statusState.mockReset();
});

describe("ManagerWorkNumberCard identity", () => {
  it("shows work email on its own box and has no phone glyph", async () => {
    statusState.mockReturnValue({
      ready: true,
      resolved: true,
      statusError: false,
      status: status(),
      retry: () => {},
    });
    const writeText = vi.fn(async () => undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    stubEmail("inbox@axis.housing");

    render(<ManagerWorkNumberCard />);

    expect(screen.getByText(/Your work number/)).toBeTruthy();
    await waitFor(() => {
      expect(screen.getByText("inbox@axis.housing")).toBeTruthy();
    });
    expect(screen.getByText(/Your work email/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Tell residents" })).toBeNull();
    expect(screen.queryByRole("link", { name: "Tell residents about this number" })).toBeNull();
    expect(screen.queryByRole("link", { name: "Set up messaging" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Copy email" }));
    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith("inbox@axis.housing");
    });
  });

  it("keeps a Set up work email box when the workspace has no address", async () => {
    statusState.mockReturnValue({
      ready: true,
      resolved: true,
      statusError: false,
      status: status(),
      retry: () => {},
    });
    stubEmail(null);

    render(<ManagerWorkNumberCard />);

    expect(screen.getByText(/Your work number/)).toBeTruthy();
    await waitFor(() => {
      expect(screen.getByText("Set up work email")).toBeTruthy();
    });
    expect(screen.getByRole("link", { name: /Set up work email/ }).getAttribute("href")).toBe(
      "/portal/profile?tab=messaging",
    );
  });

  it("renders setup boxes in the live identity slots when nothing is assigned", async () => {
    statusState.mockReturnValue({
      ready: true,
      resolved: true,
      statusError: false,
      status: status({
        number: null,
        canSend: false,
      }),
      retry: () => {},
    });
    stubEmail(null);

    render(<ManagerWorkNumberCard />);

    await waitFor(() => {
      expect(screen.getByText("Set up work number")).toBeTruthy();
      expect(screen.getByText("Set up work email")).toBeTruthy();
    });
    expect(screen.getByRole("link", { name: /Set up work number/ }).getAttribute("data-attr")).toBe(
      "manager-work-number-setup",
    );
    expect(screen.getByRole("link", { name: /Set up work email/ }).getAttribute("data-attr")).toBe(
      "manager-work-email-setup",
    );
  });
});
