// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ManagerMessagingNumberStatus } from "@/lib/sms/manager-messaging-number";
import {
  resolveWorkNumberSetupStepIndex,
  WorkNumberSetupModal,
} from "@/components/portal/pro-work-number-setup-modal";

const showToast = vi.fn();

vi.mock("@/components/providers/app-ui-provider", () => ({
  useConfirm: () => () => Promise.resolve(true),
  useAppUi: () => ({ showToast }),
}));

function baseStatus(overrides: Partial<ManagerMessagingNumberStatus> = {}): ManagerMessagingNumberStatus {
  return {
    mode: "automatic",
    workspaceRole: "primary",
    provisioningAvailable: true,
    sendingAvailable: true,
    planTier: "paid",
    entitlement: { eligible: true, tier: "business", source: "stripe" },
    number: null,
    workspace: { id: "ws-1", name: "Seattle Homes", owned: true, isDefault: true },
    workspaces: [
      {
        workspaceId: "ws-1",
        workspaceName: "Seattle Homes",
        owned: true,
        isDefault: true,
        ownerName: "Manager",
        phoneNumber: null,
        provisionState: null,
        numbers: [],
      },
    ],
    canRequest: true,
    requestedAtSignup: false,
    canSend: false,
    personalPhone: { phone: null, verifiedAt: null, forwardInbound: false },
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  showToast.mockClear();
});

describe("resolveWorkNumberSetupStepIndex", () => {
  it("starts on verify when personal phone is not verified", () => {
    expect(resolveWorkNumberSetupStepIndex(baseStatus(), "ws-1")).toBe(0);
  });

  it("starts on get-number when phone is verified but workspace has no number", () => {
    const status = baseStatus({
      personalPhone: { phone: "+12065551234", verifiedAt: "2026-01-01T00:00:00.000Z", forwardInbound: true },
    });
    expect(resolveWorkNumberSetupStepIndex(status, "ws-1")).toBe(1);
  });

  it("does not treat another workspace's status.number as this workspace's phone", () => {
    const status = baseStatus({
      workspace: { id: "ws-2", name: "Ballard houses", owned: true, isDefault: false },
      number: {
        state: "active",
        registrationState: "approved",
        carrierRegistrationState: "registered",
        attachmentState: "attached",
        phoneNumber: "+12065550001",
        lastError: null,
      },
      workspaces: [
        {
          workspaceId: "ws-1",
          workspaceName: "Seattle Homes",
          owned: true,
          isDefault: true,
          ownerName: "Manager",
          phoneNumber: "+12065550001",
          provisionState: "active",
          numbers: [
            {
              numberId: "n-1",
              phoneNumber: "+12065550001",
              isPrimary: true,
              provisionState: "active",
              sharedWithWorkspaceIds: [],
              sharedWithWorkspaceNames: [],
            },
          ],
        },
        {
          workspaceId: "ws-2",
          workspaceName: "Ballard houses",
          owned: true,
          isDefault: false,
          ownerName: "Manager",
          phoneNumber: null,
          provisionState: null,
          numbers: [],
        },
      ],
      personalPhone: {
        phone: "+12065551234",
        verifiedAt: "2026-01-01T00:00:00.000Z",
        forwardInbound: true,
      },
    });
    expect(resolveWorkNumberSetupStepIndex(status, "ws-2")).toBe(1);
  });

  it("starts on done when workspace already has a number", () => {
    const status = baseStatus({
      personalPhone: { phone: "+12065551234", verifiedAt: "2026-01-01T00:00:00.000Z", forwardInbound: true },
      number: {
        state: "active",
        registrationState: "approved",
        carrierRegistrationState: "registered",
        attachmentState: "attached",
        phoneNumber: "+12065550099",
        lastError: null,
      },
      workspaces: [
        {
          workspaceId: "ws-1",
          workspaceName: "Seattle Homes",
          owned: true,
          isDefault: true,
          ownerName: "Manager",
          phoneNumber: "+12065550099",
          provisionState: "active",
          numbers: [
            {
              numberId: "n-1",
              phoneNumber: "+12065550099",
              isPrimary: true,
              provisionState: "active",
              sharedWithWorkspaceIds: [],
              sharedWithWorkspaceNames: [],
            },
          ],
        },
      ],
    });
    expect(resolveWorkNumberSetupStepIndex(status, "ws-1")).toBe(2);
  });
});

describe("WorkNumberSetupModal", () => {
  it("shows fixed workspace context and verify step without a workspace picker", async () => {
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api/manager/phone")) {
        return Response.json({
          phone: null,
          phoneVerifiedAt: null,
          smsConfigured: true,
        });
      }
      return Response.json({});
    }) as typeof fetch;

    render(
      <WorkNumberSetupModal
        open
        onClose={() => {}}
        workspaceId="ws-1"
        workspaceName="Seattle Homes"
        status={baseStatus()}
        planMessage={null}
        unverifiedEntitlement={false}
        onStatusChange={() => {}}
      />,
    );

    expect(await screen.findByRole("dialog", { name: "Set up a work number" })).toBeTruthy();
    expect(screen.getByText("Seattle Homes")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Verify your phone" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Workspace" })).toBeNull();
    expect(screen.queryByLabelText(/workspace/i)).toBeNull();
  });

  it("tapping a locked phone step tab says why in a toast and stays on the current step", async () => {
    globalThis.fetch = vi.fn(async () =>
      Response.json({ phone: null, phoneVerifiedAt: null, smsConfigured: true }),
    ) as typeof fetch;
    render(
      <WorkNumberSetupModal
        open
        onClose={() => {}}
        workspaceId="ws-1"
        workspaceName="Seattle Homes"
        status={baseStatus()}
        planMessage={null}
        unverifiedEntitlement={false}
        onStatusChange={() => {}}
      />,
    );
    await screen.findByRole("dialog", { name: "Set up a work number" });
    const second = screen.getByRole("tab", { name: "Get your work number" });
    expect(second.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(second);
    expect(showToast).toHaveBeenLastCalledWith("Verify your phone first");
    fireEvent.click(screen.getByRole("tab", { name: "Done" }));
    expect(showToast).toHaveBeenLastCalledWith("Get your work number first");
    expect(screen.getByRole("heading", { name: "Verify your phone" })).toBeTruthy();
  });

  it("shows get-number step with area code when phone is already verified", async () => {
    globalThis.fetch = vi.fn(async () =>
      Response.json({
        phone: "+12065551234",
        phoneVerifiedAt: "2026-01-01T00:00:00.000Z",
        smsConfigured: true,
      }),
    ) as typeof fetch;

    render(
      <WorkNumberSetupModal
        open
        onClose={() => {}}
        workspaceId="ws-1"
        workspaceName="Seattle Homes"
        status={baseStatus({
          personalPhone: {
            phone: "+12065551234",
            verifiedAt: "2026-01-01T00:00:00.000Z",
            forwardInbound: true,
          },
        })}
        planMessage={null}
        unverifiedEntitlement={false}
        onStatusChange={() => {}}
      />,
    );

    expect(await screen.findByLabelText("Preferred area code")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Request number" })).toBeTruthy();
    expect(screen.getAllByText("What residents see").length).toBeGreaterThan(0);
  });

  it("surfaces request errors in the step body", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/api/manager/phone")) {
        return Response.json({
          phone: "+12065551234",
          phoneVerifiedAt: "2026-01-01T00:00:00.000Z",
          smsConfigured: true,
        });
      }
      if (url.includes("/api/manager/messaging-number") && init?.method === "POST") {
        return Response.json(
          { error: "No SMS-capable numbers are available in area code 206 right now.", mode: "automatic" },
          { status: 502 },
        );
      }
      return Response.json({});
    });
    globalThis.fetch = fetchMock as typeof fetch;

    render(
      <WorkNumberSetupModal
        open
        onClose={() => {}}
        workspaceId="ws-1"
        workspaceName="Seattle Homes"
        status={baseStatus({
          personalPhone: {
            phone: "+12065551234",
            verifiedAt: "2026-01-01T00:00:00.000Z",
            forwardInbound: true,
          },
        })}
        planMessage={null}
        unverifiedEntitlement={false}
        onStatusChange={() => {}}
      />,
    );

    await screen.findByRole("button", { name: "Request number" });
    fireEvent.click(screen.getByRole("button", { name: "Request number" }));

    await waitFor(() =>
      expect(
        screen.getByText("No SMS-capable numbers are available in area code 206 right now."),
      ).toBeTruthy(),
    );
  });
});
