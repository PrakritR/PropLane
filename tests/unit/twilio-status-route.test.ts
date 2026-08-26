import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  validateRequest: vi.fn(() => true),
  eventError: null as null | { message: string; code?: string },
  rpcError: null as null | { message: string },
  rpc: vi.fn(),
}));

vi.mock("twilio", () => ({ default: { validateRequest: mocks.validateRequest } }));
vi.mock("@/lib/twilio-client.server", () => ({ twilioWebhookAuthToken: () => "auth-token" }));
vi.mock("@/lib/supabase/service", () => ({
  createSupabaseServiceRoleClient: () => ({
    from: (table: string) => {
      if (table === "sms_delivery_events") {
        return { insert: async () => ({ data: null, error: mocks.eventError }) };
      }
      if (table === "sms_delivery_log") {
        const builder = {
          select: () => builder,
          eq: () => builder,
          limit: async () => ({ data: [], error: null }),
          insert: async () => ({ data: null, error: null }),
          update: () => builder,
          then: (resolve: (value: { data: null; error: null }) => unknown) =>
            Promise.resolve(resolve({ data: null, error: null })),
        };
        return builder;
      }
      throw new Error(`Unexpected table ${table}`);
    },
    rpc: mocks.rpc,
  }),
}));

import { POST } from "@/app/api/twilio/status/route";

function statusRequest() {
  return new Request("https://prop-lane.space/api/twilio/status", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "X-Twilio-Signature": "valid",
    },
    body: new URLSearchParams({
      MessageSid: "SM-status-1",
      MessageStatus: "delivered",
      To: "+12065552222",
    }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.eventError = null;
  mocks.rpcError = null;
  mocks.rpc.mockImplementation(async () => ({ data: null, error: mocks.rpcError }));
});

describe("Twilio delivery status durability", () => {
  it("persists the event and applies the monotonic outbox transition before acknowledging", async () => {
    const response = await POST(statusRequest());

    expect(response.status).toBe(200);
    expect(mocks.rpc).toHaveBeenCalledWith("apply_sms_delivery_status", expect.objectContaining({
      p_message_sid: "SM-status-1",
      p_status: "delivered",
      p_status_rank: 40,
    }));
  });

  it("returns 503 so Twilio retries when the append-only event cannot be written", async () => {
    mocks.eventError = { message: "db unavailable" };

    const response = await POST(statusRequest());

    expect(response.status).toBe(503);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("treats a duplicate callback event as already durable and reapplies the idempotent transition", async () => {
    mocks.eventError = { message: "duplicate", code: "23505" };

    const response = await POST(statusRequest());

    expect(response.status).toBe(200);
    expect(mocks.rpc).toHaveBeenCalledTimes(1);
  });

  it("returns 503 when the atomic outbox transition is unavailable", async () => {
    mocks.rpcError = { message: "rpc unavailable" };

    const response = await POST(statusRequest());

    expect(response.status).toBe(503);
  });
});
