// @vitest-environment jsdom
//
// Reviewer evidence for comanager-number-1015, Settings half: the teammate's
// Settings → Messaging "Work identity" row is a fact about the LINE, so it
// reads `lineReady` — a read-only teammate (`canSend: false`) still sees the
// workspace's number as "Ready", never "Not set up" and never "Not ready".
//
// Renders the REAL `ManagerMessagingSettingsPanel` over the payload
// `/api/manager/messaging-number` returns for a teammate. With EVIDENCE_DIR set
// each surface is dumped for tests/browser/teammate-number-1017 to paint.
//
//   EVIDENCE_DIR=<dir> npx vitest run tests/unit/evidence-claude1-teammate-settings-row-1017.test.tsx
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";

import { writeEvidenceSurface } from "../helpers/evidence-dom";

vi.mock("@/components/providers/app-ui-provider", () => ({
  useConfirm: () => () => Promise.resolve(true),
  useAppUi: () => ({ showToast: vi.fn() }),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  usePathname: () => "/portal/profile",
}));
vi.mock("@/hooks/use-manager-user-id", () => ({
  useManagerUserId: () => ({ userId: "teammate-1", email: "sam@example.com", ready: true }),
}));
vi.mock("@/lib/manager-inbox-contacts", () => ({ buildManagerInboxLiveContacts: () => [] }));

import { ManagerMessagingSettingsPanel } from "@/components/portal/pro-messaging-settings-panel";
import type { ManagerMessagingNumberStatus } from "@/lib/sms/manager-messaging-number";

const OWNER_LINE = "+12065550199";

/** What the route really answers a teammate: no row of their own, the owner's line. */
function teammateStatus(over: Partial<ManagerMessagingNumberStatus> = {}): ManagerMessagingNumberStatus {
  return {
    mode: "automatic",
    workspaceRole: "co_manager",
    provisioningAvailable: false,
    sendingAvailable: true,
    planTier: "paid",
    entitlement: { eligible: true, tier: "pro", source: "stripe" },
    number: null,
    workspace: { id: "ws-capitol-hill", name: "Capitol Hill", owned: false, isDefault: false },
    workspaceNumber: { phoneNumber: OWNER_LINE, ownerUserId: "owner-1", ownerName: "Dana Reyes" },
    canRequest: false,
    requestedAtSignup: false,
    lineReady: true,
    canSend: true,
    personalPhone: { phone: null, verifiedAt: null, forwardInbound: false },
    ...over,
  };
}

function stubFetch(status: ManagerMessagingNumberStatus) {
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/api/manager/assistant-email")) {
      return Response.json({
        provisioningAvailable: true,
        sendingAvailable: true,
        receivingAvailable: true,
        storageReady: true,
        planTier: "paid",
        entitlement: { eligible: true, tier: "pro", source: "stripe" },
        workspaceRole: "co_manager",
        workspaceEmail: { address: "capitolhill@proplane.app", ownerUserId: "owner-1", ownerName: "Dana Reyes" },
        workspace: { id: "ws-capitol-hill", name: "Capitol Hill", owned: false, isDefault: false },
        workspaces: [
          {
            workspaceId: "ws-capitol-hill",
            workspaceName: "Capitol Hill",
            owned: false,
            isDefault: false,
            ownerName: "Dana Reyes",
            address: "capitolhill@proplane.app",
          },
        ],
        address: "capitolhill@proplane.app",
        state: "ready",
        canRequest: false,
        canUse: true,
        requestedAtSignup: false,
      });
    }
    if (url.includes("/api/manager/phone")) {
      return Response.json({ phone: null, phoneVerifiedAt: null, smsConfigured: true });
    }
    if (url.includes("/api/manager/messaging-number")) return Response.json(status);
    return Response.json({});
  }) as unknown as typeof fetch;
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("the teammate's Settings → Messaging work identity row", () => {
  it("reads Ready off the LINE even for a read-only teammate", async () => {
    // Read-only Communication: they may not send, but the line is set up.
    stubFetch(teammateStatus({ canSend: false }));
    render(<ManagerMessagingSettingsPanel />);

    await waitFor(() => expect(screen.getByText("Workspace number")).toBeTruthy());
    expect(await screen.findByText(/\+1 \(206\) 555-0199 · Ready/)).toBeTruthy();
    expect(screen.queryByText(/Not ready/)).toBeNull();
    expect(document.body.textContent).not.toContain("Not set up");

    writeEvidenceSurface(
      "10-teammate-settings-work-identity-ready",
      "Teammate's Settings → Messaging — \"Workspace number · Ready\" on the owner's live line, read off lineReady, even though this teammate has read-only Communication (canSend: false).",
    );
  });

  it("says Not ready only when the line itself is not ready", async () => {
    stubFetch(teammateStatus({ lineReady: false, canSend: false }));
    render(<ManagerMessagingSettingsPanel />);

    expect(await screen.findByText(/\+1 \(206\) 555-0199 · Not ready/)).toBeTruthy();

    writeEvidenceSurface(
      "11-teammate-settings-work-identity-not-ready",
      "The same row when the LINE genuinely cannot send (lineReady: false) — the honest \"Not ready\" is still printed, so the fix is not a blanket suppression.",
    );
  });
});
