import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  rateLimit: vi.fn(),
  resolveSession: vi.fn(),
  runTurn: vi.fn(),
}));
vi.mock("twilio", () => ({ default: { validateRequest: () => true } }));
vi.mock("@/lib/twilio-client.server", () => ({
  twilioWebhookAuthToken: () => "synthetic-token",
  fetchTwilioMessageCreatedAt: vi.fn(),
}));
vi.mock("@/lib/rate-limit", () => ({ rateLimit: mocks.rateLimit }));
vi.mock("@/lib/supabase/service", () => ({ createSupabaseServiceRoleClient: () => ({}) }));
vi.mock("@/lib/agent/vendor-agent.server", () => ({
  resolveVendorAgentSessionForInbound: mocks.resolveSession,
  runVendorAgentSessionTurn: mocks.runTurn,
}));

import { POST } from "@/app/api/webhooks/twilio/sms/route";

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("VERCEL", "1");
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

it.each([
  [{ ok: false, unavailable: true }, 503],
  [{ ok: false }, 200],
])("returns provider-safe status for limiter result %j", async (limit, expectedStatus) => {
  mocks.rateLimit.mockResolvedValue(limit);
  const response = await POST(new Request("https://prop-lane.space/api/webhooks/twilio/sms", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", "x-twilio-signature": "valid" },
    body: new URLSearchParams({ From: "+12065550123", Body: "I can attend tomorrow", MessageSid: "SMsynthetic" }),
  }));

  expect(response.status).toBe(expectedStatus);
  expect(mocks.rateLimit).toHaveBeenCalledOnce();
  expect(mocks.resolveSession).not.toHaveBeenCalled();
  expect(mocks.runTurn).not.toHaveBeenCalled();
});
