vi.mock("@/lib/agent/vendor-agent.server", () => ({ resolveVendorAgentSessionForInbound: vi.fn(async () => ({ kind: "unknown_phone" })), runVendorAgentSessionTurn: vi.fn() }));
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  handleInbound: vi.fn(),
  relayInbound: vi.fn(),
  deliverLeasing: vi.fn(),
  rpc: vi.fn(),
  inboundLogSelects: 0,
  inboundBodies: [] as Record<string, unknown>[],
  inboundDeletes: 0,
  receiptUpdates: [] as Record<string, unknown>[],
  receipt: { status: "processing" } as Record<string, unknown> | null,
  ownedNumber: true,
  rateLimit: vi.fn((): { ok: boolean; unavailable?: true } => ({ ok: true })),
  detectSelfReply: vi.fn(async () => null),
  resolveManagerCtx: vi.fn(),
  runManagerTurn: vi.fn(),
  deliverManagerReply: vi.fn(),
  replyConsent: vi.fn(async () => "allowed"),
  after: vi.fn(),
  runInlineBurst: vi.fn(async () => undefined),
}));

vi.mock("twilio", () => ({ default: { validateRequest: vi.fn(() => true) } }));
vi.mock("next/server", async (importOriginal) => ({ ...(await importOriginal<typeof import("next/server")>()), after: mocks.after }));
vi.mock("@/lib/sms/prospect-sms-burst-job.server", () => ({ runInlineProspectBurst: mocks.runInlineBurst }));
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
  detectManagerSelfReply: mocks.detectSelfReply,
  forwardResidentInboundToManagerCell: vi.fn(async () => ({ ok: true })),
}));
vi.mock("@/lib/sms/manager-sms-access.server", () => ({
  resolveManagerSmsInboundIdentity: mocks.detectSelfReply,
}));
vi.mock("@/lib/sms/manager-conversation-consent.server", () => ({ ensureManagerInboundReplyConsent: mocks.replyConsent }));
vi.mock("@/lib/tools/manager-sms-context", () => ({
  resolveManagerSmsAgentContext: mocks.resolveManagerCtx,
}));
vi.mock("@/lib/agent/manager-sms-agent.server", () => ({
  runManagerSmsAgentTurn: mocks.runManagerTurn,
  deliverManagerSmsReply: mocks.deliverManagerReply,
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
                data: mocks.ownedNumber ? [
                  {
                    manager_user_id: "11111111-1111-4111-8111-111111111111",
                    messaging_service_sid: "MG11111111111111111111111111111111",
                    provision_state: "active",
                    grace_expires_at: null,
                    updated_at: "2026-08-25T00:00:00.000Z",
                  },
                ] : [],
                error: null,
              })
            : Promise.resolve({ data: [], error: null }),
        insert: (values: Record<string, unknown>) => { if (table === "inbound_sms_log") mocks.inboundBodies.push(values); return Promise.resolve({ data: null, error: null }); },
        delete: () => {
          if (table === "inbound_sms_log") mocks.inboundDeletes += 1;
          return builder;
        },
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
  mocks.inboundBodies = [];
  mocks.inboundDeletes = 0;
  mocks.inboundLogSelects = 0;
  mocks.receiptUpdates = [];
  mocks.receipt = { status: "processing" };
  mocks.ownedNumber = true;
  mocks.rateLimit.mockReturnValue({ ok: true });
  mocks.detectSelfReply.mockResolvedValue(null);
  mocks.resolveManagerCtx.mockReset();
  mocks.runManagerTurn.mockReset();
  mocks.deliverManagerReply.mockReset();
  mocks.replyConsent.mockResolvedValue("allowed");
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
  it("acknowledges Twilio and runs the burst after the response when the queue refused it", async () => {
    const inlineBurst = { burstId: "burst-1", revision: 2, dueAt: "2026-09-24T15:00:10.000Z" };
    mocks.handleInbound.mockResolvedValue({ ok: true, intent: "unknown", replied: false, durablyAccepted: true, inlineBurst });

    const response = await POST(inboundRequest());

    expect(response.status).toBe(200);
    expect(mocks.after).toHaveBeenCalledTimes(1);
    expect(mocks.runInlineBurst).not.toHaveBeenCalled();
    await mocks.after.mock.calls[0]![0]();
    expect(mocks.runInlineBurst).toHaveBeenCalledWith(expect.anything(), inlineBurst);
  });

  it("keeps the saved text on the leasing path when inbound credit cannot be reserved", async () => {
    const { recordManagerCommsUsage } = await import("@/lib/comms-billing/record-usage.server");
    vi.mocked(recordManagerCommsUsage).mockRejectedValueOnce(new Error("Communication credit could not be reserved."));
    mocks.handleInbound.mockResolvedValue({ ok: true, intent: "unknown", replied: false, durablyAccepted: true });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const response = await POST(inboundRequest());

    expect(response.status).toBe(200);
    expect(mocks.inboundBodies).toEqual([expect.objectContaining({ body: "Is the apartment available?" })]);
    expect(mocks.handleInbound).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith("twilio inbound usage not recorded", "SM11111111111111111111111111111111", "Communication credit could not be reserved.", undefined);
    warn.mockRestore();
  });

  it("schedules nothing extra when the burst was queued normally", async () => {
    mocks.handleInbound.mockResolvedValue({ ok: true, intent: "unknown", replied: false, durablyAccepted: true });

    expect((await POST(inboundRequest())).status).toBe(200);
    expect(mocks.after).not.toHaveBeenCalled();
  });

  it("removes a fresh manager self-SMS transport row from Communication", async () => {
    mocks.detectSelfReply.mockResolvedValue({
      actorUserId: "co-manager",
      workNumberOwnerId: "11111111-1111-4111-8111-111111111111",
      access: { mode: "delegated" },
    });
    mocks.resolveManagerCtx.mockResolvedValue({
      ok: true,
      ctx: { userId: "co-manager", landlordId: "11111111-1111-4111-8111-111111111111" },
    });
    mocks.runManagerTurn.mockResolvedValue({
      reply: "Your assistant answer.",
      sessionId: "assistant-session",
      inboundMessageId: "inbound-agent-message",
      assistantMessageId: "assistant-agent-message",
    });
    mocks.runManagerTurn.mockImplementationOnce(async (_db, args: { onInboundPersisted?: () => Promise<boolean> }) => {
      expect(await args.onInboundPersisted?.()).toBe(true);
      return {
        reply: "Your assistant answer.",
        sessionId: "assistant-session",
        inboundMessageId: "inbound-agent-message",
        assistantMessageId: "assistant-agent-message",
      };
    });
    mocks.deliverManagerReply.mockResolvedValue({ ok: true, durablyAccepted: true });

    expect((await POST(inboundRequest())).status).toBe(200);
    expect(mocks.runManagerTurn).toHaveBeenCalledOnce();
    expect(mocks.resolveManagerCtx).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ workspaceId: null }));
    expect(mocks.inboundDeletes).toBe(1);
  });

  it("keeps the co-manager actor on a prepared reply retry without rerunning the agent", async () => {
    mocks.receipt = { status: "processing", route_kind: "manager_agent", reply_body: "Your assigned house has one request.", counterparty_user_id: "co-manager" };
    mocks.detectSelfReply.mockResolvedValue({ actorUserId: "co-manager", workNumberOwnerId: "11111111-1111-4111-8111-111111111111" });
    mocks.deliverManagerReply.mockResolvedValue({ ok: true, durablyAccepted: true });
    expect((await POST(inboundRequest())).status).toBe(200);
    expect(mocks.deliverManagerReply).toHaveBeenCalledWith(expect.objectContaining({ actorUserId: "co-manager" }));
    expect(mocks.runManagerTurn).not.toHaveBeenCalled();
  });

  it("retains retryability when identity lookup fails for a prepared manager reply", async () => {
    mocks.receipt = { status: "processing", route_kind: "manager_agent", reply_body: "Prepared reply", counterparty_user_id: "co-manager" };
    mocks.detectSelfReply.mockRejectedValueOnce(new Error("Database temporarily unavailable"));
    expect((await POST(inboundRequest())).status).toBe(503);
    expect(mocks.deliverManagerReply).not.toHaveBeenCalled();
    expect(mocks.receiptUpdates).toEqual(expect.arrayContaining([expect.objectContaining({ status: "retryable" })]));
  });

  it("does not send a saved reply after the co-manager's assignment is revoked", async () => {
    mocks.receipt = { status: "processing", route_kind: "manager_agent", reply_body: "Prepared reply", counterparty_user_id: "co-manager" };
    expect((await POST(inboundRequest())).status).toBe(200);
    expect(mocks.deliverManagerReply).not.toHaveBeenCalled();
    expect(mocks.handleInbound).not.toHaveBeenCalled();
  });


  it.each([
    ["legacy relay", "0", true],
    ["unknown work number", "1", false],
    ["new managed message", "1", true],
  ] as const)("preserves provider retries on limiter outage for %s", async (_, runtime, ownedNumber) => {
    vi.stubEnv("SMS_RUNTIME_ENABLED", runtime);
    mocks.ownedNumber = ownedNumber;
    mocks.receipt = null;
    mocks.rateLimit.mockReturnValue({ ok: false, unavailable: true });

    const response = await POST(inboundRequest());

    expect(response.status).toBe(503);
    expect(mocks.rateLimit).toHaveBeenCalledOnce();
    expect(mocks.handleInbound).not.toHaveBeenCalled();
    expect(mocks.relayInbound).not.toHaveBeenCalled();
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it.each([
    ["legacy relay", "0", true],
    ["unknown work number", "1", false],
    ["new managed message", "1", true],
  ] as const)("acknowledges confirmed exhaustion for %s", async (_, runtime, ownedNumber) => {
    vi.stubEnv("SMS_RUNTIME_ENABLED", runtime);
    mocks.ownedNumber = ownedNumber;
    mocks.receipt = null;
    mocks.rateLimit.mockReturnValue({ ok: false });

    const response = await POST(inboundRequest());

    expect(response.status).toBe(200);
    expect(mocks.rateLimit).toHaveBeenCalledOnce();
    expect(mocks.handleInbound).not.toHaveBeenCalled();
    expect(mocks.relayInbound).not.toHaveBeenCalled();
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

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
    expect(mocks.inboundBodies[0]).toMatchObject({ manager_user_id: "11111111-1111-4111-8111-111111111111", message_sid: "SM11111111111111111111111111111111" });
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

  it("logs the failing step timeline and error so a Twilio timeout can be traced", async () => {
    mocks.rpc.mockResolvedValue({ data: false, error: null });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await POST(inboundRequest());

    const call = warn.mock.calls.find(([label]) => label === "twilio inbound timing");
    expect(call?.[1]).toMatchObject({
      status: 503,
      error: expect.stringContaining("still pending"),
      marks: expect.stringMatching(/signed:\d+ .*rate-limit:\d+/),
    });
    expect(String(call?.[1]?.marks)).not.toContain("claimed");
    warn.mockRestore();
  });

  it("acknowledges a duplicate only after the receipt is completed", async () => {
    mocks.rpc.mockResolvedValue({ data: false, error: null });
    mocks.receipt = { status: "completed" };

    const response = await POST(inboundRequest());

    expect(response.status).toBe(200);
    expect(mocks.handleInbound).not.toHaveBeenCalled();
  });

  it("hands a manager's own verified cell to the manager agent and texts the reply back", async () => {
    mocks.detectSelfReply.mockResolvedValue({
      workNumberOwnerId: "11111111-1111-4111-8111-111111111111",
      actorUserId: "11111111-1111-4111-8111-111111111111",
      workNumber: "+12065559999",
      actorPhone: "+12065552222",
      access: {
        mode: "owner",
        workNumberOwnerId: "11111111-1111-4111-8111-111111111111",
        actorUserId: "11111111-1111-4111-8111-111111111111",
        dataOwnerIds: ["11111111-1111-4111-8111-111111111111"],
        assignedPropertyIds: [],
      },
    });
    mocks.resolveManagerCtx.mockResolvedValue({
      ok: true,
      ctx: { landlordId: "11111111-1111-4111-8111-111111111111", userId: "11111111-1111-4111-8111-111111111111" },
    });
    mocks.runManagerTurn.mockResolvedValue({
      reply: "3 charges are overdue, $4,150 total.",
      sessionId: "22222222-2222-4222-8222-222222222222",
    });
    mocks.deliverManagerReply.mockResolvedValue({ ok: true, durablyAccepted: true });

    const response = await POST(inboundRequest());

    expect(response.status).toBe(200);
    // The leasing/prospect path must never see a manager's own text.
    expect(mocks.handleInbound).not.toHaveBeenCalled();
    expect(mocks.runManagerTurn).toHaveBeenCalledTimes(1);
    expect(mocks.deliverManagerReply).toHaveBeenCalledWith(
      expect.objectContaining({
        managerUserId: "11111111-1111-4111-8111-111111111111",
        text: "3 charges are overdue, $4,150 total.",
      }),
    );
  });

  it("stays silent when the manager identity cannot be resolved, and never falls through to leasing", async () => {
    mocks.detectSelfReply.mockResolvedValue({
      workNumberOwnerId: "11111111-1111-4111-8111-111111111111",
      actorUserId: "11111111-1111-4111-8111-111111111111",
      workNumber: "+12065559999",
      actorPhone: "+12065552222",
      access: {
        mode: "owner",
        workNumberOwnerId: "11111111-1111-4111-8111-111111111111",
        actorUserId: "11111111-1111-4111-8111-111111111111",
        dataOwnerIds: ["11111111-1111-4111-8111-111111111111"],
        assignedPropertyIds: [],
      },
    });
    mocks.resolveManagerCtx.mockResolvedValue({ ok: false, reason: "not_a_manager" });

    const response = await POST(inboundRequest());
    const twiml = await response.text();

    expect(response.status).toBe(200);
    expect(twiml).toContain("<Response></Response>");
    expect(mocks.runManagerTurn).not.toHaveBeenCalled();
    expect(mocks.deliverManagerReply).not.toHaveBeenCalled();
    // Critically: it does NOT retry the text as a prospect/resident, which
    // would run the leasing agent AT the manager.
    expect(mocks.handleInbound).not.toHaveBeenCalled();
  });
});

vi.mock("@/lib/comms-billing/record-usage.server", () => ({recordManagerCommsUsage:vi.fn(async()=>({recorded:true,duplicate:false,totalCents:2}))}));
