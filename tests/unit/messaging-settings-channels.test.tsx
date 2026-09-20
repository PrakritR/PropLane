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

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  usePathname: () => "/portal/profile",
}));

vi.mock("@/hooks/use-manager-user-id", () => ({
  useManagerUserId: () => ({ userId: "mgr-test", email: "mgr@example.com", ready: true }),
}));

vi.mock("@/lib/manager-inbox-contacts", () => ({
  buildManagerInboxLiveContacts: vi.fn(() => [
    { id: "res-1", name: "Alex Resident", email: "alex@example.com", role: "resident", tenancyStatus: "resident" },
    { id: "res-2", name: "Jordan Resident", email: "jordan@example.com", role: "resident", tenancyStatus: "resident" },
    { id: "app-1", name: "Pending Applicant", email: "pending@example.com", role: "resident", tenancyStatus: "applicant" },
  ]),
}));

import {
  ManagerMessagingSettingsPanel,
  approvedResidentsForWorkNumberAnnounce,
  formatWorkNumberAnnounceRecipientDisplay,
} from "@/components/portal/pro-messaging-settings-panel";
import type { ManagerMessagingNumberStatus } from "@/lib/sms/manager-messaging-number";
import type { ManagerAssistantEmailStatus } from "@/lib/manager-assistant-email/manager-assistant-email-status";

/**
 * PLAN-0920-1530: Settings → Communication becomes one Channels list —
 * one row per work number per workspace, one row for the work email, a
 * workspace filter, and a ⋯ menu per row instead of three separate cards
 * (the old status card, the per-workspace list, and the read-only copy box).
 */
function twoWorkspaceStatus(overrides: Partial<ManagerMessagingNumberStatus> = {}): ManagerMessagingNumberStatus {
  return {
    mode: "automatic",
    workspaceRole: "primary",
    provisioningAvailable: true,
    sendingAvailable: true,
    planTier: "paid",
    entitlement: { eligible: true, tier: "business", source: "stripe" },
    number: {
      state: "active",
      registrationState: "approved",
      carrierRegistrationState: "registered",
      attachmentState: "attached",
      phoneNumber: "+12065550001",
      lastError: null,
    },
    workspace: { id: "ws-1", name: "My workspace", owned: true, isDefault: true },
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
    canRequest: false,
    requestedAtSignup: false,
    canSend: true,
    personalPhone: { phone: null, verifiedAt: null, forwardInbound: false },
    ...overrides,
  };
}

const readyEmail: ManagerAssistantEmailStatus = {
  provisioningAvailable: true,
  sendingAvailable: true,
  receivingAvailable: true,
  storageReady: true,
  planTier: "paid",
  entitlement: { eligible: true, tier: "pro", source: "stripe" },
  workspaceRole: "primary",
  workspaceEmail: null,
  address: "assist-test-manager@prop-lane.space",
  state: "ready",
  canRequest: false,
  canUse: true,
  requestedAtSignup: false,
};

function stubFetch(
  status: ManagerMessagingNumberStatus,
  email: ManagerAssistantEmailStatus | null = readyEmail,
  handlers: {
    patch?: (body: unknown) => Response;
    post?: (body: unknown, url: string) => Response;
  } = {},
) {
  const fn = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(async (input, init) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    if (url.includes("/api/manager/assistant-email")) {
      return email ? Response.json(email) : new Response("missing", { status: 404 });
    }
    if (url.includes("/api/manager/messaging-number")) {
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      if (method === "PATCH") return handlers.patch ? handlers.patch(body) : Response.json(status);
      if (method === "POST") return handlers.post ? handlers.post(body, url) : Response.json(status);
      return Response.json(status);
    }
    return Response.json({});
  });
  return fn;
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  showToast.mockClear();
});

describe("work number resident announce recipients", () => {
  it("lists only approved residents for the broadcast", () => {
    const residents = approvedResidentsForWorkNumberAnnounce("mgr-test");
    expect(residents.map((r) => r.email)).toEqual(["alex@example.com", "jordan@example.com"]);
  });

  it("formats resident emails for the To field", () => {
    const residents = approvedResidentsForWorkNumberAnnounce("mgr-test");
    expect(formatWorkNumberAnnounceRecipientDisplay(residents)).toBe(
      "alex@example.com, jordan@example.com",
    );
  });

  it("ignores malformed legacy recipient emails instead of crashing", () => {
    const residents = approvedResidentsForWorkNumberAnnounce("mgr-test");
    Object.assign(residents[0]!, { email: { legacy: "alex@example.com" } });
    expect(() => formatWorkNumberAnnounceRecipientDisplay(residents)).not.toThrow();
    expect(formatWorkNumberAnnounceRecipientDisplay(residents)).toBe("jordan@example.com");
  });
});

describe("Channels renders one row per number per workspace and one email row", () => {
  it("shows a work number row for each owned workspace and exactly one work email row", async () => {
    globalThis.fetch = stubFetch(twoWorkspaceStatus());
    render(<ManagerMessagingSettingsPanel />);

    await waitFor(() => expect(screen.getAllByText(/Work number ·/).length).toBe(1));
    expect(screen.getByText(/\+1 \(206\) 555-0001/)).toBeTruthy();
    expect(screen.getByText("Add number")).toBeTruthy(); // dashed row for Ballard houses
    expect(await screen.findByText("assist-test-manager@prop-lane.space")).toBeTruthy();

    // The email address appears exactly once on the page.
    expect(screen.getAllByText("assist-test-manager@prop-lane.space")).toHaveLength(1);
  });

  it("shows an 'assigning' placeholder and the coarse status for a number with no phone yet", async () => {
    const status = twoWorkspaceStatus({
      number: {
        state: "pending_registration",
        registrationState: "pending",
        carrierRegistrationState: "not_submitted",
        attachmentState: "not_attached",
        phoneNumber: null,
        lastError: null,
      },
      canSend: false,
      workspaces: [
        {
          workspaceId: "ws-1",
          workspaceName: "My workspace",
          owned: true,
          isDefault: true,
          ownerName: "Prakrit",
          phoneNumber: null,
          provisionState: "pending_registration",
          numbers: [
            {
              numberId: "n-1",
              phoneNumber: null,
              isPrimary: true,
              provisionState: "pending_registration",
              sharedWithWorkspaceIds: [],
              sharedWithWorkspaceNames: [],
            },
          ],
        },
      ],
    });
    globalThis.fetch = stubFetch(status);
    render(<ManagerMessagingSettingsPanel />);

    expect(await screen.findByText(/Work number · assigning/)).toBeTruthy();
    expect(screen.getByText("Assigning")).toBeTruthy();
  });

  it("shows the shared-with qualifier and a coarser status for a number shared from another workspace", async () => {
    const status = twoWorkspaceStatus({
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
              sharedWithWorkspaceIds: ["ws-2"],
              sharedWithWorkspaceNames: ["Ballard houses"],
            },
          ],
        },
        {
          workspaceId: "ws-2",
          workspaceName: "Ballard houses",
          owned: true,
          isDefault: false,
          ownerName: "Prakrit",
          phoneNumber: "+12065550001",
          provisionState: "provisioning",
          numbers: [
            {
              numberId: "n-1",
              phoneNumber: "+12065550001",
              isPrimary: false,
              provisionState: "provisioning",
              sharedWithWorkspaceIds: [],
              sharedWithWorkspaceNames: ["My workspace"],
            },
          ],
        },
      ],
    });
    globalThis.fetch = stubFetch(status);
    render(<ManagerMessagingSettingsPanel />);

    expect(await screen.findByText(/shared with My workspace/)).toBeTruthy();
    // The foreign row only has `provisionState`, never the richer carrier
    // detail, so it still reads the coarser "Setting up" phrase rather than
    // "Ready" even though its own workspace record says "provisioning".
    expect(screen.getAllByText("Setting up · carrier registration pending").length).toBeGreaterThan(0);
  });
});

describe("Channels ⋯ actions call the existing routes", () => {
  it("Use in another workspace PATCHes assign with the chosen target", async () => {
    const status = twoWorkspaceStatus();
    let patchBody: unknown = null;
    globalThis.fetch = stubFetch(status, readyEmail, {
      patch: (body) => {
        patchBody = body;
        return Response.json(status);
      },
    });
    render(<ManagerMessagingSettingsPanel />);

    const menuTrigger = await screen.findByLabelText(/\+1 \(206\) 555-0001 actions/);
    fireEvent.click(menuTrigger);
    fireEvent.click(screen.getByText("Use in another workspace"));

    const modal = await screen.findByRole("dialog");
    const select = within(modal).getByRole("button", { name: /Use \+1 \(206\) 555-0001 in/i });
    fireEvent.click(select);
    const listbox = screen.getByRole("listbox");
    tapOption(within(listbox).getByText("Ballard houses"));
    fireEvent.click(within(modal).getByRole("button", { name: "Share" }));

    await waitFor(() => expect(patchBody).toEqual({ action: "assign", numberId: "n-1", workspaceId: "ws-2" }));
  });

  it("Remove PATCHes unassign for that row's own workspace", async () => {
    const status = twoWorkspaceStatus();
    let patchBody: unknown = null;
    globalThis.fetch = stubFetch(status, readyEmail, {
      patch: (body) => {
        patchBody = body;
        return Response.json(status);
      },
    });
    render(<ManagerMessagingSettingsPanel />);

    const menuTrigger = await screen.findByLabelText(/\+1 \(206\) 555-0001 actions/);
    fireEvent.click(menuTrigger);
    fireEvent.click(screen.getByText("Remove"));

    await waitFor(() => expect(patchBody).toEqual({ action: "unassign", numberId: "n-1", workspaceId: "ws-1" }));
  });

  it("the email row's Copy address action copies the address", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    globalThis.fetch = stubFetch(twoWorkspaceStatus());
    render(<ManagerMessagingSettingsPanel />);

    const menuTrigger = await screen.findByLabelText("Work email actions");
    fireEvent.click(menuTrigger);
    fireEvent.click(screen.getByText("Copy address"));

    await waitFor(() => expect(writeText).toHaveBeenCalledWith("assist-test-manager@prop-lane.space"));
  });
});

describe("Channels workspace filter", () => {
  it("hides rows belonging to other workspaces", async () => {
    globalThis.fetch = stubFetch(twoWorkspaceStatus());
    render(<ManagerMessagingSettingsPanel />);

    await screen.findByText(/\+1 \(206\) 555-0001/);
    expect(screen.getByText("Add number")).toBeTruthy();

    const filterTrigger = await screen.findByRole("button", { name: "Workspace" });
    fireEvent.click(filterTrigger);
    const listbox = screen.getByRole("listbox");
    tapOption(within(listbox).getByText("My workspace"));

    await waitFor(() => expect(screen.queryByText("Add number")).toBeNull());
    expect(screen.getByText(/\+1 \(206\) 555-0001/)).toBeTruthy();
  });
});
