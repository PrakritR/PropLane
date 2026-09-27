import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  projectOriginalEvent,
  type SmsProjectionEventInput,
} from "@/lib/sms/sms-projection.server";

const event: SmsProjectionEventInput = {
  ownerManagerUserId: "owner-1",
  counterpartyRole: "prospect",
  workLineId: "line-1",
  identityKey: "phone:+14155550123",
  identityKind: "phone",
  counterpartyPhone: "+14155550123",
  sourceNamespace: "twilio-account-1",
  sourceEventId: "SM-original-1",
  direction: "inbound",
  body: "",
  occurredAt: "2026-09-25T12:00:00.000Z",
  fromPhone: "+14155550123",
  toPhone: "+14155550999",
};

describe("SMS projection writes", () => {
  beforeEach(() => vi.clearAllMocks());

  it("persists an attachment-only original event and returns the stable projection identifiers", async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: { conversationId: "conversation-1", turnId: "turn-1", inserted: true, eventCount: 1 },
      error: null,
    });
    const db = { rpc } as never;

    await expect(projectOriginalEvent(db, event)).resolves.toEqual({
      conversationId: "conversation-1",
      eventId: "turn-1",
      inserted: true,
      eventCount: 1,
    });
    expect(rpc).toHaveBeenCalledWith("project_sms_conversation_event", {
      p_event: expect.objectContaining({
        sourceEventId: "SM-original-1",
        sourceNamespace: "twilio-account-1",
        body: "",
        direction: "inbound",
      }),
    });
  });

  it("rejects invalid source timestamps before invoking storage", async () => {
    const rpc = vi.fn();
    await expect(projectOriginalEvent({ rpc } as never, { ...event, occurredAt: "invalid" }))
      .rejects.toThrow("Invalid SMS projection event");
    expect(rpc).not.toHaveBeenCalled();
  });
});
