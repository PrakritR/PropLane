// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

vi.mock("@/components/providers/app-ui-provider", () => ({
  useAppUi: () => ({ showToast: vi.fn() }),
}));

vi.mock("@/hooks/use-manager-user-id", () => ({
  useManagerUserId: () => ({
    userId: "mgr-test",
    email: "mgr@test.proplane.local",
    ready: true,
  }),
}));

import { ManagerWorkNumberButton } from "@/components/portal/pro-work-number-button";
import type { ManagerMessagingNumberStatus } from "@/lib/sms/manager-messaging-number";
import { resetManagerMessagingNumberStatusClientCache } from "@/lib/sms/manager-messaging-number-client";

const status: ManagerMessagingNumberStatus = {
  mode: "paused",
  workspaceRole: "primary",
  provisioningAvailable: false,
  sendingAvailable: false,
  planTier: "paid",
  entitlement: { eligible: true, tier: "pro", source: "stripe" },
  number: null,
  canRequest: false,
  canSend: false,
  personalPhone: { phone: null, verifiedAt: null, forwardInbound: true },
};

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  resetManagerMessagingNumberStatusClientCache();
});

describe("ManagerWorkNumberButton", () => {
  it("shows a loading placeholder before messaging status resolves", () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Promise(() => {})));
    render(<ManagerWorkNumberButton />);

    const button = screen.getByRole("button", { name: "Set up messaging" });
    expect(button).toHaveAttribute("aria-busy", "true");
    expect(button).toBeDisabled();
  });

  it("reads the side-effect-free status route and deep-links setup when no number exists", async () => {
    const fetchMock = vi.fn(async () => Response.json(status));
    vi.stubGlobal("fetch", fetchMock);
    render(<ManagerWorkNumberButton />);

    const link = await screen.findByRole("link", { name: "Set up messaging" });
    expect(link.getAttribute("href")).toBe("/portal/profile?tab=messaging");
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/manager/messaging-number",
      expect.objectContaining({ cache: "no-store", credentials: "include" }),
    );
  });

  it("shows a greyed, non-actionable upsell with a tooltip for free plans", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ ...status, planTier: "free" })),
    );
    render(<ManagerWorkNumberButton />);

    const button = await screen.findByRole("button", {
      name: "Subscribe to Pro to unlock SMS",
    });
    expect(button).toBeDisabled();
    expect(button.getAttribute("title")).toBe("Subscribe to Pro to unlock SMS");
    // A free plan never gets a setup link.
    expect(screen.queryByRole("link")).toBeNull();
  });

  it("renders nothing once a work number is assigned", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          ...status,
          number: {
            state: "active",
            registrationState: "approved",
            carrierRegistrationState: "registered",
            attachmentState: "attached",
            phoneNumber: "+12065551234",
            lastError: null,
          },
        }),
      ),
    );
    const { container } = render(<ManagerWorkNumberButton />);

    await waitFor(() =>
      expect(container.querySelector("a,button")).toBeNull(),
    );
  });

  it("links co-managers to messaging setup when no number is assigned", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          ...status,
          workspaceRole: "co_manager",
          planTier: "paid",
        }),
      ),
    );
    render(<ManagerWorkNumberButton />);

    const link = await screen.findByRole("link", { name: "Set up messaging" });
    expect(link.getAttribute("href")).toBe("/portal/profile?tab=messaging");
  });

  it("shows an actionable error and retries when status cannot be loaded", async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error("network failed"))
      .mockResolvedValueOnce(Response.json(status));
    vi.stubGlobal("fetch", fetchMock);
    render(<ManagerWorkNumberButton />);

    expect(await screen.findByRole("alert")).toHaveTextContent("Messaging status unavailable.");
    fireEvent.click(screen.getByRole("button", { name: "Retry messaging status" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(await screen.findByRole("link", { name: "Set up messaging" })).toBeTruthy();
  });
});
