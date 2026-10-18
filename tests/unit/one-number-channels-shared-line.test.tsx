// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

vi.mock("@/components/providers/app-ui-provider", () => ({
  useConfirm: () => () => Promise.resolve(true),
  useAppUi: () => ({ showToast: vi.fn() }),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  usePathname: () => "/portal/profile",
}));
vi.mock("@/hooks/use-manager-user-id", () => ({
  useManagerUserId: () => ({ userId: "mgr-test", email: "mgr@example.com", ready: true }),
}));
vi.mock("@/lib/manager-inbox-contacts", () => ({ buildManagerInboxLiveContacts: vi.fn(() => []) }));

import { ManagerMessagingSettingsPanel } from "@/components/portal/pro-messaging-settings-panel";
import type { ManagerMessagingNumberStatus } from "@/lib/sms/manager-messaging-number";
import { workNumberStatusWord } from "@/lib/sms/work-number-status";

const SHARED = "+12065550100";
const workspace = { workspaceId: "ws-1", workspaceName: "My workspace", owned: true, isDefault: true, ownerName: "Prakrit" };

function status(over: Partial<ManagerMessagingNumberStatus> & { own?: boolean } = {}): ManagerMessagingNumberStatus {
  const { own, ...rest } = over;
  return {
    mode: "automatic",
    workspaceRole: "primary",
    provisioningAvailable: true,
    sendingAvailable: true,
    planTier: "paid",
    entitlement: { eligible: true, tier: "pro", source: "stripe" },
    number: own
      ? { state: "active", registrationState: "approved", carrierRegistrationState: "registered", attachmentState: "attached", phoneNumber: "+12065550001", lastError: null }
      : null,
    workspace: { id: "ws-1", name: "My workspace", owned: true, isDefault: true },
    workspaces: [
      own
        ? { ...workspace, phoneNumber: "+12065550001", provisionState: "active", numbers: [{ numberId: "n-1", phoneNumber: "+12065550001", isPrimary: true, provisionState: "active", sharedWithWorkspaceIds: [], sharedWithWorkspaceNames: [] }] }
        : { ...workspace, phoneNumber: null, provisionState: null, numbers: [] },
    ],
    canRequest: !own,
    requestedAtSignup: false,
    lineReady: true,
    canSend: true,
    personalPhone: { phone: null, verifiedAt: null, forwardInbound: false },
    ...rest,
  };
}

function stub(next: ManagerMessagingNumberStatus) {
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/api/manager/assistant-email")) return new Response("missing", { status: 404 });
    if (url.includes("/api/manager/phone")) return Response.json({ phone: null, phoneVerifiedAt: null, smsConfigured: true });
    if (url.includes("/api/manager/messaging-number")) return Response.json(next);
    return Response.json({});
  }) as typeof fetch;
}

afterEach(() => cleanup());

describe("Settings > Communication > Channels with the set PropLane line", () => {
  it("a Free workspace on the shared line sees the PropLane line row and no way to get its own number", async () => {
    stub(status({
      planTier: "free", canRequest: false, entitlement: { eligible: false, reason: "free" },
      sharedLine: { number: SHARED, onSharedLine: true },
    }));
    render(<ManagerMessagingSettingsPanel />);
    expect(await screen.findByRole("button", { name: /PropLane line.*555-0100/ })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Get your own number/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Work number/ })).toBeNull();
  });

  it("a Pro or Business workspace on the shared line sees the line and 'Get your own number'", async () => {
    stub(status({ sharedLine: { number: SHARED, onSharedLine: true } }));
    render(<ManagerMessagingSettingsPanel />);
    expect(await screen.findByRole("button", { name: /PropLane line.*555-0100/ })).toBeTruthy();
    const get = await screen.findByRole("button", { name: /Get your own number/ });
    fireEvent.click(get);
    expect(await screen.findByRole("dialog")).toBeTruthy();
  });

  it("a workspace with its own number shows it as today and no PropLane line row", async () => {
    stub(status({ own: true, sharedLine: { number: SHARED, onSharedLine: false } }));
    render(<ManagerMessagingSettingsPanel />);
    expect(await screen.findByRole("button", { name: /Work number.*555-0001/ })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /PropLane line/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Get your own number/ })).toBeNull();
  });

  it("per_workspace mode (no sharedLine) draws exactly what it always has", async () => {
    stub(status({ sharedLine: null }));
    render(<ManagerMessagingSettingsPanel />);
    expect(await screen.findByRole("button", { name: /Work number Set up/ })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /PropLane line/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Get your own number/ })).toBeNull();
  });

  it("a teammate on the shared line reads the PropLane line number", async () => {
    stub(status({
      workspaceRole: "co_manager", canRequest: false, workspaceNumber: { phoneNumber: null, ownerUserId: "o", ownerName: "Owner" },
      workspace: { id: "ws-1", name: "My workspace", owned: false, isDefault: false },
      sharedLine: { number: SHARED, onSharedLine: true },
    }));
    render(<ManagerMessagingSettingsPanel />);
    expect(await screen.findByRole("button", { name: /Workspace number.*555-0100.*PropLane line/ })).toBeTruthy();
  });
});

describe("workNumberStatusWord", () => {
  it("names the PropLane line for a workspace on it, whatever else the input says", () => {
    expect(workNumberStatusWord({ sharedLine: true })).toBe("PropLane line");
    expect(workNumberStatusWord({ sharedLine: true, state: "failed" })).toBe("PropLane line");
    expect(workNumberStatusWord({ sharedLine: false, state: "active" })).toBe("Ready");
  });
});
