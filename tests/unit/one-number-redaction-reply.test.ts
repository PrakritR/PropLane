import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  payload: null as Record<string, unknown> | null,
  readError: false,
  send: vi.fn(),
}));

vi.mock("@/lib/supabase/service", () => ({
  createSupabaseServiceRoleClient: () => ({
    from: () => {
      const q: Record<string, unknown> = {
        select: () => q, eq: () => q, limit: () => q,
        maybeSingle: async () => mocks.readError ? { data: null, error: { message: "x" } } : { data: mocks.payload ? { inbound_payload: mocks.payload } : null, error: null },
      };
      return q;
    },
  }),
}));
vi.mock("@/lib/proplane-sms-transport.server", () => ({ sendFromManagerWorkNumber: mocks.send }));

import { redactedInboundReplyOverride } from "@/lib/one-number/redact-reply.server";
import { SECURE_PAYMENT_REPLY } from "@/lib/one-number/redact";
import { deliverManagerSmsReply } from "@/lib/agent/manager-sms-agent.server";
import { deliverResidentSmsReply } from "@/lib/agent/resident-sms-agent.server";

const SID = "SM" + "2".repeat(32);

describe("the reply to a redacted inbound", () => {
  beforeEach(() => {
    mocks.payload = null;
    mocks.readError = false;
    mocks.send.mockReset().mockResolvedValue({ ok: true });
  });

  it("is the secure-link notice only when the receipt was flagged", async () => {
    await expect(redactedInboundReplyOverride(SID)).resolves.toBeNull();
    mocks.payload = { body: "x", redacted: true };
    await expect(redactedInboundReplyOverride(SID)).resolves.toBe(SECURE_PAYMENT_REPLY);
    await expect(redactedInboundReplyOverride(null)).resolves.toBeNull();
    mocks.readError = true;
    await expect(redactedInboundReplyOverride(SID)).resolves.toBeNull();
  });

  it("replaces whatever the agent drafted, for manager and resident replies", async () => {
    mocks.payload = { body: "x", redacted: true };
    await deliverResidentSmsReply({ ownerManagerUserId: "o", residentUserId: "r", toPhone: "+12065551234", text: "Got your card, thanks!", inboundMessageSid: SID });
    expect(mocks.send.mock.calls[0][0].text).toBe(SECURE_PAYMENT_REPLY);
    await deliverManagerSmsReply({ managerUserId: "o", toPhone: "+12065551234", text: "Got it", inboundMessageSid: SID });
    expect(mocks.send.mock.calls[1][0].text).toBe(SECURE_PAYMENT_REPLY);
  });

  it("keeps the reply (made GSM-7) for an ordinary inbound", async () => {
    await deliverResidentSmsReply({ ownerManagerUserId: "o", residentUserId: "r", toPhone: "+12065551234", text: "It’s fixed 😊", inboundMessageSid: SID });
    expect(mocks.send.mock.calls[0][0].text).toBe("It's fixed");
    await deliverManagerSmsReply({ managerUserId: "o", toPhone: "+12065551234", text: "Plain reply", inboundMessageSid: SID });
    expect(mocks.send.mock.calls[1][0].text).toBe("Plain reply");
  });
});
