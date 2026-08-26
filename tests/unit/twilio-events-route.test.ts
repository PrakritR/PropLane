import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  validate: vi.fn(() => true),
  appliedManagerId: "11111111-1111-4111-8111-111111111111" as string | null,
  ownedRow: null as null | { last_provider_event_at: string | null; attachment_state: string },
  inserted: [] as Record<string, unknown>[],
  updated: [] as Record<string, unknown>[],
  rpc: vi.fn(),
}));

vi.mock("twilio", () => ({ default: { validateRequestWithBody: mocks.validate } }));
vi.mock("@/lib/twilio-client.server", () => ({ twilioWebhookAuthToken: () => "auth-token" }));
vi.mock("@/lib/supabase/service", () => ({
  createSupabaseServiceRoleClient: () => ({
    from: (table: string) => {
      if (table === "sms_provider_events") {
        const builder = {
          select: () => builder,
          eq: () => builder,
          maybeSingle: async () => ({ data: null, error: null }),
          insert: async (row: Record<string, unknown>) => {
            mocks.inserted.push(row);
            return { data: null, error: null };
          },
          update: (row: Record<string, unknown>) => {
            mocks.updated.push(row);
            return builder;
          },
          then: (resolve: (value: { data: null; error: null }) => unknown) =>
            Promise.resolve(resolve({ data: null, error: null })),
        };
        return builder;
      }
      if (table === "manager_sms_numbers") {
        const builder = {
          select: () => builder,
          eq: () => builder,
          maybeSingle: async () => ({ data: mocks.ownedRow, error: null }),
        };
        return builder;
      }
      throw new Error(`Unexpected table ${table}`);
    },
    rpc: mocks.rpc,
  }),
}));

import { POST } from "@/app/api/twilio/events/route";

const EVENT = [{
  id: "EZ-event-1",
  type: "com.twilio.messaging.compliance.number-registration.successful",
  time: "2026-08-25T12:00:00.000Z",
  data: {
    accountsid: "AC11111111111111111111111111111111",
    messagingservicesid: "MG11111111111111111111111111111111",
    campaignsid: "QE11111111111111111111111111111111",
    phonenumbersid: "PN11111111111111111111111111111111",
    phonenumber: "+12065559999",
  },
}];

function eventRequest() {
  return new Request("https://prop-lane.space/api/twilio/events?source=twilio", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Twilio-Signature": "valid" },
    body: JSON.stringify(EVENT),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.inserted.length = 0;
  mocks.updated.length = 0;
  mocks.appliedManagerId = "11111111-1111-4111-8111-111111111111";
  mocks.ownedRow = null;
  mocks.rpc.mockImplementation(async () => ({ data: mocks.appliedManagerId, error: null }));
  vi.stubEnv("TWILIO_EVENT_STREAMS_SINK_URL", "https://prop-lane.space/api/twilio/events");
  vi.stubEnv("TWILIO_ACCOUNT_SID", "AC11111111111111111111111111111111");
  vi.stubEnv("TWILIO_MESSAGING_SERVICE_SID", "MG11111111111111111111111111111111");
  vi.stubEnv("TWILIO_CAMPAIGN_SID", "QE11111111111111111111111111111111");
});

describe("Twilio Event Streams number lifecycle", () => {
  it("records and atomically applies an allow-listed registration event", async () => {
    const response = await POST(eventRequest());

    expect(response.status).toBe(200);
    expect(mocks.inserted).toHaveLength(1);
    expect(mocks.rpc).toHaveBeenCalledWith("apply_manager_sms_number_event", expect.objectContaining({
      p_phone_number_sid: "PN11111111111111111111111111111111",
      p_registration_state: "registered",
    }));
    expect(mocks.updated).toContainEqual({ applied: true, rejection_reason: null });
  });

  it("asks Twilio to retry when registration beats provisioning persistence", async () => {
    mocks.appliedManagerId = null;
    mocks.ownedRow = null;

    const response = await POST(eventRequest());

    expect(response.status).toBe(503);
  });
});
