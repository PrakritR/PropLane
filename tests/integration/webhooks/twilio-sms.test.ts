import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  fetchCreatedAt: vi.fn(async () => "2026-08-25T11:59:59.000Z"),
  rateLimit: vi.fn(() => ({ ok: true })),
}));

vi.mock("twilio", () => ({ default: { validateRequest: vi.fn().mockReturnValue(true) } }));
vi.mock("@/lib/supabase/service", () => ({ createSupabaseServiceRoleClient: vi.fn() }));
vi.mock("@/lib/rate-limit", () => ({ rateLimit: mocks.rateLimit }));
vi.mock("@/lib/twilio-client.server", () => ({
  twilioWebhookAuthToken: () => "test-token",
  fetchTwilioMessageCreatedAt: mocks.fetchCreatedAt,
}));
vi.mock("@/lib/agent/vendor-agent.server", () => ({
  findVendorAgentSessionByPhone: vi.fn(),
  runVendorAgentSessionTurn: vi.fn().mockResolvedValue("ok"),
}));

import twilio from "twilio";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { findVendorAgentSessionByPhone, runVendorAgentSessionTurn } from "@/lib/agent/vendor-agent.server";
import { POST } from "@/app/api/webhooks/twilio/sms/route";

const SESSION = {
  id: "sess-1",
  landlord_id: "mgr-a",
  kind: "vendor_work_order",
  vendor_user_id: "vendor-user-1",
  vendor_directory_id: "v-plumb",
  work_order_id: "REQ-1",
  vendor_phone_e164: "+12065550001",
  status: "active",
  inbox_thread_id: null,
};

function smsRequest(params: Record<string, string>, signature: string | null = "sig"): Request {
  const body = new URLSearchParams(params).toString();
  const headers: Record<string, string> = { "content-type": "application/x-www-form-urlencoded" };
  if (signature) headers["x-twilio-signature"] = signature;
  return new Request("http://localhost/api/webhooks/twilio/sms", { method: "POST", body, headers });
}

function mockDb(options?: {
  controlError?: { message: string } | null;
  applyControl?: boolean;
  consent?: { opted_in_at: string | null; opted_out_at: string | null };
}) {
  const profileUpdates: Array<{ patch: Record<string, unknown>; ids: string[] }> = [];
  const sessionUpdates: Array<Record<string, unknown>> = [];
  const consent = options?.consent ?? { opted_in_at: null, opted_out_at: null };
  const rpc = vi.fn(async (_name: string, args: Record<string, unknown>) => {
    if (options?.controlError) return { data: null, error: options.controlError };
    if (options?.applyControl !== false) {
      if (args.p_keyword === "STOP") consent.opted_out_at = String(args.p_provider_occurred_at);
      if (args.p_keyword === "START") consent.opted_in_at = String(args.p_provider_occurred_at);
    }
    return { data: options?.applyControl !== false, error: null };
  });
  const client = {
    rpc,
    from(table: string) {
      if (table === "sms_consent") {
        const chain = {
          select: () => chain,
          eq: () => chain,
          maybeSingle: async () => ({ data: consent, error: null }),
        };
        return chain;
      }
      if (table === "agent_sessions") {
        const chain = {
          select: () => chain,
          eq: () => chain,
          update: (patch: Record<string, unknown>) => ({
            eq: () => ({
              eq: async () => {
                sessionUpdates.push(patch);
                return { error: null };
              },
            }),
          }),
          then: (resolve: (v: { data: unknown[]; error: null }) => void) =>
            resolve({ data: [{ vendor_user_id: "vendor-user-1" }], error: null }),
        };
        return chain;
      }
      if (table === "profiles") {
        const selectChain = {
          eq: async () => ({ data: [{ id: "vendor-user-1" }], error: null }),
          in: async () => ({ data: [{ id: "vendor-user-1" }], error: null }),
        };
        return {
          select: () => selectChain,
          update: (patch: Record<string, unknown>) => ({
            in: async (_c: string, ids: string[]) => {
              profileUpdates.push({ patch, ids });
              return { error: null };
            },
          }),
        };
      }
      throw new Error(`unexpected table ${table}`);
    },
  };
  return { client: client as never, profileUpdates, sessionUpdates, consent, rpc };
}

describe("/api/webhooks/twilio/sms", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(twilio.validateRequest).mockReturnValue(true);
    vi.stubEnv("TWILIO_WEBHOOK_URL", "https://axis.example/api/webhooks/twilio/sms");
    const { client } = mockDb();
    vi.mocked(createSupabaseServiceRoleClient).mockReturnValue(client);
    vi.mocked(findVendorAgentSessionByPhone).mockResolvedValue(SESSION as never);
  });

  afterEach(() => vi.unstubAllEnvs());

  it("rejects a forged signature with 403 and runs nothing", async () => {
    vi.mocked(twilio.validateRequest).mockReturnValue(false);
    const res = await POST(smsRequest({ From: "+12065550001", Body: "hola" }));
    expect(res.status).toBe(403);
    expect(runVendorAgentSessionTurn).not.toHaveBeenCalled();
  });

  it("fails closed on Vercel when the signature is missing", async () => {
    vi.stubEnv("VERCEL", "1");
    const res = await POST(smsRequest({ From: "+12065550001", Body: "hola" }, null));
    expect(res.status).toBe(403);
    expect(runVendorAgentSessionTurn).not.toHaveBeenCalled();
  });

  it("silently drops unknown numbers with an empty TwiML 200", async () => {
    vi.mocked(findVendorAgentSessionByPhone).mockResolvedValue(null);
    const res = await POST(smsRequest({ From: "+19998887777", Body: "who dis" }));
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("<Response></Response>");
    expect(runVendorAgentSessionTurn).not.toHaveBeenCalled();
  });

  it("binds the newest active session for the sender and runs a turn", async () => {
    const res = await POST(smsRequest({ From: "+1 (206) 555-0001", Body: "cual es el codigo del porton?" }));
    expect(res.status).toBe(200);
    expect(findVendorAgentSessionByPhone).toHaveBeenCalledWith(expect.anything(), "+12065550001");
    expect(runVendorAgentSessionTurn).toHaveBeenCalledWith(
      expect.anything(),
      SESSION,
      "cual es el codigo del porton?",
      "sms",
    );
  });

  it("durably applies STOP before rate limiting, then updates the vendor profile and session", async () => {
    mocks.rateLimit.mockReturnValue({ ok: false });
    const { client, profileUpdates, sessionUpdates, consent, rpc } = mockDb();
    vi.mocked(createSupabaseServiceRoleClient).mockReturnValue(client);

    const res = await POST(smsRequest({
      From: "+12065550001",
      Body: "STOP",
      MessageSid: "SM11111111111111111111111111111111",
    }));
    expect(res.status).toBe(200);
    expect(rpc).toHaveBeenCalledWith("apply_sms_control_keyword", {
      p_message_sid: "SM11111111111111111111111111111111",
      p_recipient_phone_key: "2065550001",
      p_keyword: "STOP",
      p_provider_occurred_at: "2026-08-25T11:59:59.000Z",
      p_manager_user_id: null,
      p_messaging_service_sid: null,
    });
    expect(consent.opted_out_at).toBe("2026-08-25T11:59:59.000Z");
    expect(mocks.rateLimit).not.toHaveBeenCalled();
    expect(profileUpdates[0]!.ids).toEqual(["vendor-user-1"]);
    expect(profileUpdates[0]!.patch.sms_opt_out_at).toBe("2026-08-25T11:59:59.000Z");
    expect(sessionUpdates[0]!.vendor_phone_e164).toBeNull();
    expect(runVendorAgentSessionTurn).not.toHaveBeenCalled();
  });

  it("returns retryable failure and leaves vendor state untouched when the control RPC fails", async () => {
    const { client, profileUpdates, sessionUpdates } = mockDb({ controlError: { message: "db unavailable" } });
    vi.mocked(createSupabaseServiceRoleClient).mockReturnValue(client);

    const res = await POST(smsRequest({
      From: "+12065550001",
      Body: "START",
      MessageSid: "SM22222222222222222222222222222222",
    }));

    expect(res.status).toBe(503);
    expect(profileUpdates).toHaveLength(0);
    expect(sessionUpdates).toHaveLength(0);
  });

  it("does not let a stale START clear a newer provider-ordered STOP", async () => {
    const { client, profileUpdates } = mockDb({
      applyControl: false,
      consent: {
        opted_in_at: "2026-08-25T11:59:59.000Z",
        opted_out_at: "2026-08-25T12:00:01.000Z",
      },
    });
    vi.mocked(createSupabaseServiceRoleClient).mockReturnValue(client);

    const res = await POST(smsRequest({
      From: "+12065550001",
      Body: "START",
      MessageSid: "SM33333333333333333333333333333333",
    }));

    expect(res.status).toBe(200);
    expect(profileUpdates).toHaveLength(0);
  });

  it("finishes START profile updates on a replay when that provider event is still current", async () => {
    const { client, profileUpdates } = mockDb({
      applyControl: false,
      consent: {
        opted_in_at: "2026-08-25T11:59:59.000Z",
        opted_out_at: "2026-08-25T11:00:00.000Z",
      },
    });
    vi.mocked(createSupabaseServiceRoleClient).mockReturnValue(client);

    const res = await POST(smsRequest({
      From: "+12065550001",
      Body: "START",
      MessageSid: "SM44444444444444444444444444444444",
    }));

    expect(res.status).toBe(200);
    expect(profileUpdates).toEqual([{
      ids: ["vendor-user-1"],
      patch: {
        sms_opt_out_at: null,
        sms_consent_at: "2026-08-25T11:59:59.000Z",
      },
    }]);
  });

  it("rate-limits ordinary traffic while still returning 200", async () => {
    mocks.rateLimit.mockReturnValue({ ok: false });
    const res = await POST(smsRequest({ From: "+12065559999", Body: "ordinary message" }));
    expect(res.status).toBe(200);
    expect(runVendorAgentSessionTurn).not.toHaveBeenCalled();
  });
});
