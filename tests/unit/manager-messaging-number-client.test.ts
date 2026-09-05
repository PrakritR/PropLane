import { afterEach, describe, expect, it, vi } from "vitest";
import {
  loadManagerMessagingNumberStatusClient,
  resetManagerMessagingNumberStatusClientCache,
} from "@/lib/sms/manager-messaging-number-client";
import type { ManagerMessagingNumberStatus } from "@/lib/sms/manager-messaging-number";

const status: ManagerMessagingNumberStatus = {
  mode: "paused",
  workspaceRole: "primary",
  provisioningAvailable: false,
  sendingAvailable: false,
  planTier: "paid",
  entitlement: { eligible: true, tier: "pro", source: "stripe" },
  number: null,
  canRequest: false,
  requestedAtSignup: false,
  canSend: false,
  personalPhone: { phone: null, verifiedAt: null, forwardInbound: true },
};

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  resetManagerMessagingNumberStatusClientCache();
});

describe("manager-messaging-number-client", () => {
  it("dedupes concurrent loads for the same manager", async () => {
    const fetchMock = vi.fn(async () => Response.json(status));
    vi.stubGlobal("fetch", fetchMock);

    const [first, second] = await Promise.all([
      loadManagerMessagingNumberStatusClient("mgr-1"),
      loadManagerMessagingNumberStatusClient("mgr-1"),
    ]);

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
