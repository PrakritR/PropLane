import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  validateRequest: vi.fn(() => true),
  rpc: vi.fn(),
  rateLimit: vi.fn(() => ({ ok: true })),
  suppression: vi.fn(async () => ({ ok: true as const, optedOut: true })),
}));

vi.mock("twilio", () => ({
  default: { validateRequest: mocks.validateRequest },
}));
vi.mock("@/lib/twilio-client.server", () => ({
  twilioWebhookAuthToken: () => "auth-token",
  fetchTwilioMessageCreatedAt: vi.fn(async () => "2026-08-25T11:59:59.000Z"),
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

import { POST } from "@/app/api/twilio/inbound/route";

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
