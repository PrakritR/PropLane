// @vitest-environment jsdom
/**
 * Settings Communication follows the settings-bar workspace, not the
 * portal header switcher. A named workspace fetches with workspaceId and
 * filters Channels; All workspaces leaves the query off.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";

const showToast = vi.fn();

vi.mock("@/components/providers/app-ui-provider", () => ({
  useConfirm: () => () => Promise.resolve(true),
  useAppUi: () => ({ showToast }),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  usePathname: () => "/portal/profile",
}));

vi.mock("@/hooks/use-manager-user-id", () => ({
  useManagerUserId: () => ({ userId: "mgr-test", email: "mgr@example.com", ready: true }),
}));

vi.mock("@/lib/manager-inbox-contacts", () => ({
  buildManagerInboxLiveContacts: vi.fn(() => []),
}));

vi.mock("@/components/portal/workspace-provider", () => ({
  useWorkspaces: () => ({
    workspaces: [
      {
        id: "ws-1",
        name: "Ash Flats",
        propertyIds: ["prop-1"],
        propertyLabels: { "prop-1": "Ballard House" },
        owned: true,
        isDefault: true,
      },
    ],
    active: { id: "ws-other", name: "Portal header workspace", owned: true, isDefault: false, propertyIds: [] },
    loading: false,
    select: vi.fn(),
  }),
}));

import { ManagerMessagingSettingsPanel } from "@/components/portal/pro-messaging-settings-panel";
import { SettingsPropertyScopeProvider } from "@/components/portal/settings-property-scope";
import type { ManagerMessagingNumberStatus } from "@/lib/sms/manager-messaging-number";

const scopedStatus: ManagerMessagingNumberStatus = {
  mode: "paused",
  workspaceRole: "primary",
  provisioningAvailable: false,
  sendingAvailable: false,
  planTier: "paid",
  entitlement: { eligible: true, tier: "pro", source: "stripe" },
  number: null,
  workspace: { id: "ws-1", name: "Ash Flats", owned: true, isDefault: true },
  workspaces: [
    {
      workspaceId: "ws-1",
      workspaceName: "Ash Flats",
      owned: true,
      isDefault: true,
      ownerName: null,
      phoneNumber: null,
      provisionState: null,
      numbers: [],
    },
    {
      workspaceId: "ws-other",
      workspaceName: "Portal header workspace",
      owned: true,
      isDefault: false,
      ownerName: null,
      phoneNumber: "+12065550999",
      provisionState: "active",
      numbers: [
        {
          numberId: "n-other",
          phoneNumber: "+12065550999",
          isPrimary: true,
          provisionState: "active",
          sharedWithWorkspaceIds: [],
          sharedWithWorkspaceNames: [],
        },
      ],
    },
  ],
  canRequest: false,
  canSend: false,
  personalPhone: {
    phone: "+15105550123",
    verifiedAt: "2026-08-25T12:00:00.000Z",
    forwardInbound: true,
  },
};

function messagingFetchMock() {
  return vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(async (input) => {
    const url = String(input);
    if (url.includes("/api/manager/comms-billing")) {
      return Response.json({ paygEnabled: false });
    }
    if (url.includes("/api/manager/assistant-email")) {
      return Response.json({
        provisioningAvailable: true,
        sendingAvailable: false,
        storageReady: true,
        planTier: "paid",
        entitlement: { eligible: true, tier: "pro", source: "stripe" },
        workspaceRole: "primary",
        address: "ash@prop-lane.space",
        state: "requestable",
        canRequest: true,
        canUse: false,
        requestedAtSignup: false,
      });
    }
    return Response.json(scopedStatus);
  });
}

function renderScoped(workspaceId: string) {
  return render(
    <SettingsPropertyScopeProvider
      workspaceId={workspaceId}
      onWorkspaceIdChange={() => {}}
      propertyIds={[]}
      onPropertyIdsChange={() => {}}
      options={[]}
    >
      <ManagerMessagingSettingsPanel />
    </SettingsPropertyScopeProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("settings-bar workspace scopes Communication identity", () => {
  it("fetches the bar workspace, filters Channels to it, and labels the email row", async () => {
    const fetchMock = messagingFetchMock();
    vi.stubGlobal("fetch", fetchMock);
    renderScoped("ws-1");

    await waitFor(() => {
      expect(screen.getByText("Channels")).toBeTruthy();
    });
    // Each Channels row (number, email) names its workspace.
    expect(screen.getAllByText("Ash Flats").length).toBeGreaterThan(0);
    expect(screen.queryByText("Portal header workspace")).toBeNull();
    expect(screen.queryByText(/\+1 \(206\) 555-0999/)).toBeNull();

    const post = fetchMock.mock.calls.find(
      (call) =>
        String(call[0]).includes("/api/manager/messaging-number") &&
        call[1]?.method === "POST",
    );
    expect(post).toBeTruthy();
    expect(JSON.parse(String(post?.[1]?.body))).toMatchObject({
      action: "refresh_eligibility",
      workspaceId: "ws-1",
    });

    const emailGet = fetchMock.mock.calls.find((call) =>
      String(call[0]).includes("/api/manager/assistant-email?workspaceId=ws-1"),
    );
    expect(emailGet).toBeTruthy();
  });

  it("All workspaces keeps Channels unfiltered and omits workspaceId", async () => {
    const fetchMock = messagingFetchMock();
    vi.stubGlobal("fetch", fetchMock);
    renderScoped("");

    await waitFor(() => {
      expect(screen.getByText("Channels")).toBeTruthy();
    });
    expect(screen.getByText("All workspaces")).toBeTruthy();
    expect(screen.getByText("Portal header workspace")).toBeTruthy();
    expect(screen.getByText(/\+1 \(206\) 555-0999/)).toBeTruthy();

    const post = fetchMock.mock.calls.find(
      (call) =>
        String(call[0]).includes("/api/manager/messaging-number") &&
        call[1]?.method === "POST",
    );
    expect(post).toBeTruthy();
    expect(JSON.parse(String(post?.[1]?.body))).toEqual({ action: "refresh_eligibility" });

    const messagingGet = fetchMock.mock.calls.find((call) =>
      String(call[0]).includes("/api/manager/messaging-number?workspaceId="),
    );
    expect(messagingGet).toBeUndefined();
  });
});
