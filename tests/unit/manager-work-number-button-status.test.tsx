// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

vi.mock("@/components/providers/app-ui-provider", () => ({
  useAppUi: () => ({ showToast: vi.fn() }),
}));

import { ManagerWorkNumberButton } from "@/components/portal/manager-work-number-button";
import type { ManagerMessagingNumberStatus } from "@/lib/sms/manager-messaging-number";

const status: ManagerMessagingNumberStatus = {
  mode: "paused",
  workspaceRole: "primary",
  provisioningAvailable: false,
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
});

describe("ManagerWorkNumberButton", () => {
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

  it("links co-managers to honest read-only messaging details", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({ ...status, workspaceRole: "co_manager" }),
      ),
    );
    render(<ManagerWorkNumberButton />);

    const link = await screen.findByRole("link", { name: "View messaging" });
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
