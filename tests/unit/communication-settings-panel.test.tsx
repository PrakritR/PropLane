// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";

const showToast = vi.fn();

vi.mock("next/navigation", () => ({
  usePathname: () => "/portal/communication",
}));
vi.mock("@/components/providers/app-ui-provider", () => ({
  useConfirm: () => (req: { description?: unknown }) =>
    Promise.resolve(
      typeof window === "undefined"
        ? true
        : window.confirm(typeof req?.description === "string" ? req.description : "Are you sure?"),
    ),

  useAppUi: () => ({ showToast }),
}));
// The automation-settings read now goes through the shared cache
// (`manager-automation-settings-client.ts`), which is keyed on the viewer id
// this hook supplies — without it the panel's load effect no-ops forever.
vi.mock("@/hooks/use-portal-session", () => ({
  usePortalSession: () => ({ ready: true, email: "manager@example.com", userId: "mgr-1" }),
}));
vi.mock("@/lib/demo/demo-session", async (importOriginal) => ({
  // Spread the real module: this file only needs to override demo mode,
  // and a hand-listed mock silently breaks every time the module gains an
  // export a component calls at import time.
  ...(await importOriginal<typeof import("@/lib/demo/demo-session")>()),
  isDemoModeActive: () => false,
}));

import { CommunicationSettingsPanel } from "@/components/portal/pro-portal-settings-panels";
import { invalidateManagerAutomationSettingsCache } from "@/lib/manager-automation-settings-client";
import { DEFAULT_MANAGER_AUTOMATION_SETTINGS } from "@/lib/payment-automation-settings";
import type { ManagerMessagingNumberStatus } from "@/lib/sms/manager-messaging-number";
import type { ManagerAssistantEmailStatus } from "@/lib/manager-assistant-email/manager-assistant-email-status";

const readyNumber: ManagerMessagingNumberStatus = {
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
  personalPhone: { phone: null, verifiedAt: null, forwardInbound: false },
};

const readyEmail: ManagerAssistantEmailStatus = {
  provisioningAvailable: true,
  sendingAvailable: true,
  receivingAvailable: true,
  storageReady: true,
  planTier: "paid",
  entitlement: { eligible: true, tier: "pro", source: "stripe" },
  workspaceRole: "primary",
  workspaceEmail: null,
  address: "manager@inbound.prop-lane.space",
  state: "ready",
  canRequest: false,
  canUse: true,
  requestedAtSignup: false,
};

afterEach(() => {
  cleanup();
  showToast.mockReset();
  vi.unstubAllGlobals();
  // The shared automation-settings read cache (N032) is module-level and
  // outlives a single test's render.
  invalidateManagerAutomationSettingsCache();
});

function stubPanelFetches(
  status: ManagerMessagingNumberStatus | null,
  emailStatus: ManagerAssistantEmailStatus | null = null,
) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo) => {
      const url = String(input);
      if (url.includes("/api/portal/automation-settings")) {
        return Response.json({ settings: DEFAULT_MANAGER_AUTOMATION_SETTINGS });
      }
      // PLAN-0915 rows on the same panel load their own settings.
      if (url.includes("/api/portal/reminder-settings")) return Response.json({ settings: {} });
      if (url.includes("/api/portal/automated-messages")) return Response.json({ settings: {}, defaults: {} });
      if (url.includes("/api/manager/messaging-number")) {
        return status ? Response.json(status) : new Response("missing", { status: 404 });
      }
      if (url.includes("/api/manager/assistant-email")) {
        return emailStatus ? Response.json(emailStatus) : new Response("missing", { status: 404 });
      }
      return new Response("not found", { status: 404 });
    }),
  );
}

/** Waits until the panel has finished loading (its work-number read has landed and the loading line is gone). */
async function panelSettled(container: HTMLElement) {
  await waitFor(() => {
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    expect(fetchMock.mock.calls.some(([input]) => String(input).includes("/api/manager/messaging-number"))).toBe(true);
    expect(container.textContent ?? "").not.toContain("Loading…");
  });
}

/**
 * PLAN-0920-1530: the work number and work email each appear exactly once now
 * — on their Channels row in `pro-messaging-settings-panel.tsx`. The
 * standalone copy controls this panel used to render (`Copy work number` /
 * `Copy work email`) are gone.
 *
 * Captain, Oct 3: the "Reminders and messages" entry row ("Edit reminder
 * timing and automated messages") is gone too. Reminder timing is fixed
 * (docs/agents/automated-communication.md), so the row only linked to a
 * removed Settings tab.
 */
describe("CommunicationSettingsPanel", () => {
  it("renders no Reminders and messages row and no copy controls", async () => {
    stubPanelFetches(readyNumber, readyEmail);
    const { container } = render(<CommunicationSettingsPanel />);
    await panelSettled(container);

    expect(screen.queryByText("Reminders and messages")).toBeNull();
    expect(screen.queryByText("Edit reminder timing and automated messages")).toBeNull();
    expect(container.querySelector('[data-attr="communication-open-reminders-hub"]')).toBeNull();
    expect(screen.queryByRole("button", { name: /Copy work number/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Copy work email/ })).toBeNull();
    expect(showToast).not.toHaveBeenCalled();
  });

  it("does not expose personal contact fallback settings when work email is ready", async () => {
    stubPanelFetches(readyNumber, readyEmail);
    const { container } = render(<CommunicationSettingsPanel />);
    await panelSettled(container);

    expect(screen.queryByText("Who can email the assistant")).toBeNull();
    expect(screen.queryByText(/Share my profile phone and email/)).toBeNull();
  });

  it("does not expose work email audience status in automation settings", async () => {
    stubPanelFetches(readyNumber, { ...readyEmail, state: "assigned_plan_hold", canUse: false });
    const { container } = render(<CommunicationSettingsPanel />);
    await panelSettled(container);

    expect(screen.queryByText("Who can email the assistant")).toBeNull();
  });

  it("omits the row when the work email status could not be read", async () => {
    stubPanelFetches(readyNumber, null);
    const { container } = render(<CommunicationSettingsPanel />);
    await panelSettled(container);

    expect(screen.queryByText("Who can email the assistant")).toBeNull();
  });
});
