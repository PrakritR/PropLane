import { beforeEach, describe, expect, it, vi } from "vitest";

const { recordResidentProspectInboxMessage } = vi.hoisted(() => ({
  recordResidentProspectInboxMessage: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/tour-notification-delivery.server", () => ({
  recordResidentProspectInboxMessage,
}));

vi.mock("@/lib/analytics/posthog", () => ({ track: vi.fn() }));

vi.mock("@/lib/test-workspaces/effects.server", () => ({
  captureTestWorkspaceEffectForUser: vi.fn().mockResolvedValue({ captured: false }),
}));

vi.mock("@/lib/manager-property-share-access", () => ({
  getShareablePropertyForUser: vi.fn(async () => ({
    title: "Test Property",
    buildingName: "Test Building",
    address: "123 Main St",
  })),
}));

import { sendLeadInvite } from "@/lib/lead-invite.server";

describe("sendLeadInvite inbox recording", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.RESEND_API_KEY = "test-key";
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ id: "email-1" }),
      }),
    );
  });

  it("records the outbound invite in the resident prospect inbox after a successful send", async () => {
    const db = {
      from: vi.fn(() => ({
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        maybeSingle: vi.fn().mockResolvedValue({ data: { role: "manager" }, error: null }),
      })),
    };

    const result = await sendLeadInvite(db as never, { userId: "mgr-1" }, {
      kind: "apply",
      to: "prospect@example.com",
      propertyId: "prop-1",
      origin: "https://example.com",
    });

    expect(result.ok).toBe(true);
    expect(recordResidentProspectInboxMessage).toHaveBeenCalledWith(
      db,
      expect.objectContaining({
        participantEmail: "prospect@example.com",
        subject: expect.any(String),
        body: expect.any(String),
      }),
    );
  });
});
