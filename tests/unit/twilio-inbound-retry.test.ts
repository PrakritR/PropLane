import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  handleInbound: vi.fn(),
  relayInbound: vi.fn(),
  deliverLeasing: vi.fn(),
  rpc: vi.fn(),
  inboundLogSelects: 0,
  receiptUpdates: [] as Record<string, unknown>[],
  receipt: { status: "processing" } as Record<string, unknown>,
  rateLimit: vi.fn(() => ({ ok: true })),
}));

vi.mock("twilio", () => ({ default: { validateRequest: vi.fn(() => true) } }));
vi.mock("@/lib/twilio-client.server", () => ({
  twilioWebhookAuthToken: () => "auth-token",
  fetchTwilioMessageCreatedAt: vi.fn(),
}));
vi.mock("@/lib/rate-limit", () => ({ rateLimit: mocks.rateLimit }));
vi.mock("@/lib/claw-leasing-bot.server", () => ({
  handleClawLeasingInbound: mocks.handleInbound,
}));
vi.mock("@/lib/agent/leasing-sms-agent.server", () => ({
  deliverLeasingSmsReply: mocks.deliverLeasing,
}));
vi.mock("@/lib/sms-relay.server", () => ({ relayInboundSms: mocks.relayInbound }));
vi.mock("@/lib/sms/manager-relay.server", () => ({
  detectManagerSelfReply: vi.fn(async () => null),
  forwardResidentInboundToManagerCell: vi.fn(async () => ({ ok: true })),
  handleManagerReplyInbound: vi.fn(),
}));
vi.mock("@/lib/claw-leasing-links", () => ({ isClawSharedLineBridgeEnabled: () => true }));
vi.mock("@/lib/supabase/service", () => ({
  createSupabaseServiceRoleClient: () => makeDb(),
}));

function makeDb() {
  return {
    rpc: mocks.rpc,
    from(table: string) {
      let isUpdate = false;
      const builder: Record<string, unknown> = {
        select() {
          if (table === "inbound_sms_log") mocks.inboundLogSelects += 1;
          return builder;
        },
        in: () => builder,
        eq: () => builder,
        not: () => builder,
        order: () => builder,
        limit: () =>
          table === "manager_sms_numbers"
            ? Promise.resolve({
                data: [
                  {
                    manager_user_id: "11111111-1111-4111-8111-111111111111",
                    messaging_service_sid: "MG11111111111111111111111111111111",
                    provision_state: "active",
                    grace_expires_at: null,
                    updated_at: "2026-08-25T00:00:00.000Z",
                  },
                ],
                error: null,
              })
            : Promise.resolve({ data: [], error: null }),
        insert: () => Promise.resolve({ data: null, error: null }),
        update: (values: Record<string, unknown>) => {
          isUpdate = true;
          if (table === "sms_inbound_receipts") mocks.receiptUpdates.push(values);
          return builder;
        },
        maybeSingle: () =>
          Promise.resolve({
            data:
              table === "sms_inbound_receipts" && !isUpdate
                ? mocks.receipt
                : { message_sid: "SM111" },
            error: null,
          }),
        then(resolve: (value: { data: unknown; error: null }) => unknown) {
          return Promise.resolve({ data: null, error: null }).then(resolve);
        },
      };
      return builder;
    },
  };
}

import { POST } from "@/app/api/twilio/inbound/route";

function inboundRequest() {
  return new Request("https://prop-lane.space/api/twilio/inbound", {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "x-twilio-signature": "valid",
    },
    body: new URLSearchParams({
      From: "+12065552222",
      To: "+12065559999",
      Body: "Is the apartment available?",
      MessageSid: "SM11111111111111111111111111111111",
    }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.inboundLogSelects = 0;
  mocks.receiptUpdates = [];
  mocks.receipt = { status: "processing" };
  mocks.rateLimit.mockReturnValue({ ok: true });
  vi.stubEnv("TWILIO_MESSAGING_SERVICE_SID", "MG11111111111111111111111111111111");
  vi.stubEnv("SMS_RUNTIME_ENABLED", "1");
  mocks.rpc.mockImplementation(async (name: string) => {
    if (name === "claim_sms_inbound") return { data: true, error: null };
    if (name === "prepare_sms_inbound_reply") {
      return { data: true, error: null };
    }
    if (name === "attach_sms_inbound_outbox") return { data: true, error: null };
    return { data: null, error: null };
  });
});

describe("managed Twilio inbound retry", () => {
  it("reclaims a retryable receipt even when the durable message log already exists", async () => {
    mocks.handleInbound.mockImplementationOnce(async (args: {
      onPreparedReply: (prepared: Record<string, unknown>) => Promise<boolean>;
    }) => {
      const replyBody = "Yes, the apartment is available.";
      const prepared = await args.onPreparedReply({ routeKind: "leasing_agent", replyBody });
      mocks.receipt = {
        status: "processing",
        route_kind: "leasing_agent",
        reply_body: replyBody,
      };
      return prepared
        ? { ok: false, error: "reply unavailable" }
        : { ok: false, error: "prepare unavailable" };
    });
    mocks.deliverLeasing.mockResolvedValue({
      ok: false,
      error: "deferred",
      outboxId: "44444444-4444-4444-8444-444444444444",
      durablyAccepted: true,
    });

    const first = await POST(inboundRequest());
    const retry = await POST(inboundRequest());

    expect(first.status).toBe(503);
    expect(retry.status).toBe(200);
    expect(mocks.handleInbound).toHaveBeenCalledTimes(1);
    expect(mocks.deliverLeasing).toHaveBeenCalledTimes(1);
    expect(mocks.deliverLeasing).toHaveBeenCalledWith(
      expect.objectContaining({ text: "Yes, the apartment is available." }),
    );
    expect(mocks.rpc).toHaveBeenCalledWith(
      "claim_sms_inbound",
      expect.objectContaining({ p_message_sid: "SM11111111111111111111111111111111" }),
    );
    expect(mocks.inboundLogSelects).toBe(0);
    expect(mocks.relayInbound).not.toHaveBeenCalled();
  });

  it("completes without re-entering the handler once its durable outbox owns the reply", async () => {
    mocks.receipt = {
      status: "processing",
      route_kind: "leasing_agent",
      reply_body: "The prepared answer must not be regenerated.",
      turn_trace_id: "trace-original",
      outbox_id: "55555555-5555-4555-8555-555555555555",
    };

    const response = await POST(inboundRequest());

    expect(response.status).toBe(200);
    expect(mocks.handleInbound).not.toHaveBeenCalled();
    expect(mocks.deliverLeasing).not.toHaveBeenCalled();
    expect(mocks.receiptUpdates).toContainEqual(
      expect.objectContaining({ status: "completed", lease_owner: null, lease_expires_at: null }),
    );
    expect(mocks.rpc).not.toHaveBeenCalledWith("attach_sms_inbound_outbox", expect.anything());
    expect(mocks.rateLimit).not.toHaveBeenCalled();
  });

  it("hands retry ownership to a newly created outbox and never handles the duplicate again", async () => {
    const replyBody = "This exact answer is now owned by the outbox.";
    mocks.handleInbound.mockImplementationOnce(async (args: {
      onPreparedReply: (prepared: Record<string, unknown>) => Promise<boolean>;
    }) => {
      const prepared = await args.onPreparedReply({ routeKind: "leasing_agent", replyBody });
      return prepared
        ? {
            ok: true,
            replied: false,
            outboxId: "66666666-6666-4666-8666-666666666666",
          }
        : { ok: false, error: "prepare unavailable" };
    });

    const first = await POST(inboundRequest());
    expect(first.status).toBe(200);
    expect(mocks.handleInbound).toHaveBeenCalledTimes(1);
    expect(mocks.rpc).toHaveBeenCalledWith("prepare_sms_inbound_reply", expect.objectContaining({
      p_message_sid: "SM11111111111111111111111111111111",
      p_reply_body: replyBody,
    }));
    expect(mocks.rpc).toHaveBeenCalledWith("attach_sms_inbound_outbox", expect.objectContaining({
      p_message_sid: "SM11111111111111111111111111111111",
      p_outbox_id: "66666666-6666-4666-8666-666666666666",
    }));

    mocks.receipt = { status: "completed" };
    mocks.rpc.mockImplementation(async (name: string) => {
      if (name === "claim_sms_inbound") return { data: false, error: null };
      return { data: null, error: null };
    });
    const duplicate = await POST(inboundRequest());

    expect(duplicate.status).toBe(200);
    expect(mocks.handleInbound).toHaveBeenCalledTimes(1);
    expect(mocks.deliverLeasing).not.toHaveBeenCalled();
  });

  it("asks Twilio to retry while another receipt lease is not completed", async () => {
    mocks.rpc.mockResolvedValue({ data: false, error: null });

    const response = await POST(inboundRequest());

    expect(response.status).toBe(503);
    expect(mocks.handleInbound).not.toHaveBeenCalled();
  });

  it("acknowledges a duplicate only after the receipt is completed", async () => {
    mocks.rpc.mockResolvedValue({ data: false, error: null });
    mocks.receipt = { status: "completed" };

    const response = await POST(inboundRequest());

    expect(response.status).toBe(200);
    expect(mocks.handleInbound).not.toHaveBeenCalled();
  });
});
