// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

function tapOption(target: Element | Node) {
  fireEvent.pointerDown(target, { pointerId: 1, clientX: 10, clientY: 10 });
  fireEvent.pointerUp(target, { pointerId: 1, clientX: 10, clientY: 10 });
}

const showToast = vi.fn();

vi.mock("@/components/providers/app-ui-provider", () => ({
  useConfirm: () => () => Promise.resolve(true),
  useAppUi: () => ({ showToast }),
}));

import { ManagerWorkNumbersPanel } from "@/components/portal/pro-messaging-settings-panel";
import type { ManagerMessagingNumberStatus } from "@/lib/sms/manager-messaging-number";

/**
 * Settings → Communication → Work numbers: every OWNED workspace lists its
 * held numbers (up to 2), grouped under the workspace's own heading, with
 * "Use in another workspace" sharing a number into a sibling.
 */
function baseStatus(overrides: Partial<ManagerMessagingNumberStatus> = {}): ManagerMessagingNumberStatus {
  return {
    mode: "automatic",
    workspaceRole: "primary",
    provisioningAvailable: true,
    sendingAvailable: true,
    planTier: "paid",
    entitlement: { eligible: true, tier: "business", source: "stripe" },
    number: null,
    workspace: { id: "ws-1", name: "My workspace", owned: true, isDefault: true },
    workspaces: [],
    canRequest: false,
    requestedAtSignup: false,
    canSend: false,
    personalPhone: { phone: null, verifiedAt: null, forwardInbound: false },
    ...overrides,
  };
}

function twoWorkspaceStatus(): ManagerMessagingNumberStatus {
  return baseStatus({
    workspaces: [
      {
        workspaceId: "ws-1",
        workspaceName: "My workspace",
        owned: true,
        isDefault: true,
        ownerName: "Prakrit",
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
        ownerName: "Prakrit",
        phoneNumber: null,
        provisionState: null,
        numbers: [],
      },
    ],
  });
}

function fetchMock(status: ManagerMessagingNumberStatus, patchHandler?: (body: unknown) => Response) {
  return vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(async (input, init) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    if (url.includes("/api/manager/messaging-number") && method === "PATCH") {
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      return patchHandler ? patchHandler(body) : Response.json(status);
    }
    return Response.json(status);
  });
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  showToast.mockClear();
});

describe("ManagerWorkNumbersPanel groups numbers per workspace", () => {
  it("renders one section per owned workspace with its own numbers count", async () => {
    globalThis.fetch = fetchMock(twoWorkspaceStatus());
    render(<ManagerWorkNumbersPanel />);

    await waitFor(() => expect(screen.getByText("My workspace")).toBeInTheDocument());
    // "Ballard houses" also appears as the share-select's <option>, so scope
    // this to the section heading rather than the generic text query.
    expect(screen.getAllByText("Ballard houses").length).toBeGreaterThan(0);
    expect(screen.getByText("1 of 2 numbers")).toBeInTheDocument();
    expect(screen.getByText("0 of 2 numbers")).toBeInTheDocument();
    expect(screen.getAllByText(/included/).length).toBeGreaterThan(0);
    // The workspace with no numbers of its own gets an Add-number action.
    expect(screen.getByText("Add number")).toBeInTheDocument();
  });

  it("shows a co-manager nothing — they own no workspace to manage numbers for", async () => {
    globalThis.fetch = fetchMock(baseStatus({ workspaceRole: "co_manager", workspaces: [] }));
    const { container } = render(<ManagerWorkNumbersPanel />);
    await waitFor(() => expect(globalThis.fetch).toHaveBeenCalled());
    expect(container.textContent).toBe("");
  });
});

describe("ManagerWorkNumbersPanel — Use in another workspace assigns", () => {
  it("selecting a sibling workspace PATCHes assign with the number and target workspace ids", async () => {
    const status = twoWorkspaceStatus();
    let patchBody: unknown = null;
    globalThis.fetch = fetchMock(status, (body) => {
      patchBody = body;
      return Response.json(status);
    });
    render(<ManagerWorkNumbersPanel />);

    const trigger = await screen.findByRole("button", { name: /Use \+1 \(206\) 555-0001 in another workspace/i });
    fireEvent.click(trigger);
    const listbox = screen.getByRole("listbox");
    tapOption(within(listbox).getByText("Ballard houses"));

    await waitFor(() => expect(patchBody).toEqual({ action: "assign", numberId: "n-1", workspaceId: "ws-2" }));
    await waitFor(() => expect(showToast).toHaveBeenCalledWith("Number shared into that workspace."));
  });

  it("Remove PATCHes unassign for that workspace's own number", async () => {
    const status = twoWorkspaceStatus();
    let patchBody: unknown = null;
    globalThis.fetch = fetchMock(status, (body) => {
      patchBody = body;
      return Response.json(status);
    });
    render(<ManagerWorkNumbersPanel />);

    await waitFor(() => expect(screen.getByText("My workspace")).toBeInTheDocument());
    const removeButtons = screen.getAllByRole("button", { name: "Remove" });
    fireEvent.click(removeButtons[0]);

    await waitFor(() => expect(patchBody).toEqual({ action: "unassign", numberId: "n-1", workspaceId: "ws-1" }));
  });
});
