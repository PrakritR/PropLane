import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  validateRequest: vi.fn(() => true),
  timestamp: vi.fn(async () => "2026-08-25T11:59:59.000Z"),
  strictConfig: vi.fn(),
  rpc: vi.fn(),
  rateLimit: vi.fn(() => ({ ok: true })),
  suppression: vi.fn(async () => ({ ok: true as const, optedOut: true })),
}));

vi.mock("twilio", () => ({
  default: { validateRequest: mocks.validateRequest },
}));
vi.mock("@/lib/twilio-client.server", () => ({
  twilioWebhookAuthToken: () => "auth-token",
  fetchTwilioMessageCreatedAt: mocks.timestamp,
}));
vi.mock("@/lib/rate-limit", () => ({ rateLimit: mocks.rateLimit }));
vi.mock("@/lib/sms-consent", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/sms-consent")>();
  return {
    ...actual,
    readSmsSuppressionState: mocks.suppression,
  };
});
vi.mock("@/lib/supabase/service", () => ({
  createSupabaseServiceRoleClient: () => ({
    from: (table: string) => {
      if (table !== "manager_sms_numbers") throw new Error(`Unexpected table ${table}`);
      const builder = {
        select: () => builder,
        in: () => builder,
        eq: () => builder,
        order: () => builder,
        limit: async () => ({
          data: [{
            manager_user_id: "11111111-1111-4111-8111-111111111111",
            messaging_service_sid: "MG11111111111111111111111111111111",
            provision_state: "active",
            grace_expires_at: null,
            updated_at: "2026-08-25T00:00:00Z",
          }],
          error: null,
        }),
      };
      return builder;
    },
    rpc: mocks.rpc,
  }),
}));

vi.mock("@/lib/one-number/config.server", async (original) => ({
  ...await original<typeof import("@/lib/one-number/config.server")>(),
  loadSharedLineConfigStrict: mocks.strictConfig,
}));
import { MemoryDb } from "../helpers/sms-envelope-memory-db";
import { acceptInboundEnvelope, processInboundEnvelope, recoverInboundEnvelopes } from "@/lib/sms/inbound-envelope.server";
import { processAcceptedInbound } from "@/lib/sms/process-accepted-inbound.server";
import { runWithDurableSmsIngress, type SmsIngressCheckpoint } from "@/lib/sms/durable-ingress-context.server";
import { processInboundRequest as POST } from "../helpers/twilio-inbound-processor";

function controlRequest(body: string, messageSid = "SM-control-1") {
  return new Request("https://prop-lane.space/api/twilio/inbound", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "X-Twilio-Signature": "valid",
    },
    body: new URLSearchParams({
      From: "+12065552222",
      To: "+12065559999",
      Body: body,
      MessageSid: messageSid,
    }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.timestamp.mockResolvedValue("2026-08-25T11:59:59.000Z");
  mocks.strictConfig.mockResolvedValue({ ok: true, config: { mode: "per_workspace", sharedNumber: null } });
  mocks.suppression.mockResolvedValue({ ok: true, optedOut: true });
  vi.stubEnv("TWILIO_MESSAGING_SERVICE_SID", "MG11111111111111111111111111111111");
  mocks.rpc.mockResolvedValue({ data: true, error: null });
});

describe("Twilio inbound control receipts", () => {
  it("applies STOP through the MessageSid-unique transactional RPC before rate limiting", async () => {
    const response = await POST(controlRequest(" stop "));

    expect(response.status).toBe(200);
    expect(mocks.rpc).toHaveBeenCalledWith("apply_sms_control_keyword", {
      p_message_sid: "SM-control-1",
      p_recipient_phone_key: "2065552222",
      p_keyword: "STOP",
      p_provider_occurred_at: "2026-08-25T11:59:59.000Z",
      p_manager_user_id: "11111111-1111-4111-8111-111111111111",
      p_messaging_service_sid: "MG11111111111111111111111111111111",
    });
    expect(mocks.rateLimit).not.toHaveBeenCalled();
  });

  it("returns retryable non-2xx when the durable control mutation fails", async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: { message: "db unavailable" } });

    const response = await POST(controlRequest("START", "SM-control-2"));

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({ error: "Control receipt unavailable." });
  });
});


describe("durable control checkpoints", () => {
  const params = { From: "+12065552222", To: "+12065559999", Body: "YES", MessageSid: "SM-control-durable" };
  function context() {
    return { current: { stage: "safe" } as SmsIngressCheckpoint, save: vi.fn(async () => undefined) };
  }
  it("persists START before an RPC response is lost and never reinterprets the retry as agent confirmation", async () => {
    const execution = context();
    mocks.rpc.mockRejectedValueOnce(new Error("response lost"));
    await expect(runWithDurableSmsIngress(execution, () => processAcceptedInbound(params))).rejects.toThrow("control_receipt_unavailable");
    expect(execution.current).toEqual({ stage: "control", controlKeyword: "START" });
    mocks.suppression.mockResolvedValue({ ok: true, optedOut: false });
    await expect(runWithDurableSmsIngress(execution, () => processAcceptedInbound(params))).resolves.toEqual({ bubbles: [] });
    expect(mocks.rpc).toHaveBeenCalledTimes(2);
    expect(mocks.rpc.mock.calls.every(call => call[0] === "apply_sms_control_keyword" && call[1].p_keyword === "START")).toBe(true);
    expect(mocks.rateLimit).not.toHaveBeenCalled();
  });
  it("retries STOP provider timestamps without executing agent work", async () => {
    const execution = context();
    mocks.timestamp.mockRejectedValueOnce(new Error("temporary provider outage"));
    await expect(runWithDurableSmsIngress(execution, () => processAcceptedInbound({ ...params, Body: "STOP" }))).rejects.toThrow("control_timestamp_unavailable");
    expect(execution.current).toEqual({ stage: "control", controlKeyword: "STOP" });
    await expect(runWithDurableSmsIngress(execution, () => processAcceptedInbound({ ...params, Body: "STOP" }))).resolves.toEqual({ bubbles: [] });
    expect(mocks.rpc).toHaveBeenCalledTimes(1);
    expect(mocks.rateLimit).not.toHaveBeenCalled();
  });
  it("refuses unreadable shared configuration before any routing or owner receipt", async () => {
    mocks.strictConfig.mockResolvedValue({ ok: false });
    await expect(runWithDurableSmsIngress(context(), () => processAcceptedInbound({ ...params, Body: "hello" }))).rejects.toThrow("routing_dependency_unavailable");
    expect(mocks.rpc).not.toHaveBeenCalled();
    expect(mocks.rateLimit).not.toHaveBeenCalled();
  });
});


it("durably accepts STOP, recovers one timestamp outage through cron, and applies suppression once", async () => {
  vi.stubEnv("TWILIO_ACCOUNT_SID", "ACtest");
  vi.stubEnv("VERCEL_ENV", "development");
  const store = new MemoryDb();
  const params = { From: "+12065552222", To: "+12065559999", Body: "STOP", MessageSid: "SM-control-cron" };
  expect(await acceptInboundEnvelope(store.asClient(), { sid: params.MessageSid, wireFrom: params.From, wireTo: params.To, params, payloadDigest: "a".repeat(64), runtime: "development" })).toEqual({ kind: "accepted", id: "envelope" });
  mocks.timestamp.mockRejectedValueOnce(new Error("temporary provider outage"));
  await processInboundEnvelope(store.asClient(), "envelope", { process: processAcceptedInbound });
  expect(store.tables.sms_ingress_envelopes[0].status).toBe("accepted");
  expect(mocks.rpc).not.toHaveBeenCalled();
  store.tables.sms_ingress_envelopes[0].next_attempt_at = new Date(Date.now() - 1000).toISOString();
  expect(await recoverInboundEnvelopes(store.asClient(), { process: processAcceptedInbound })).toEqual({ processed: 1, needsReview: 0 });
  expect(store.tables.sms_ingress_envelopes[0].status).toBe("completed");
  expect(mocks.rpc).toHaveBeenCalledTimes(1);
  expect(mocks.rpc.mock.calls[0][1].p_keyword).toBe("STOP");
  expect(mocks.rateLimit).not.toHaveBeenCalled();
  vi.unstubAllEnvs();
});
