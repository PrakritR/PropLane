import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  run: vi.fn(),
  claim: vi.fn(),
  vendorIngest: vi.fn(),
}));

vi.mock("twilio", () => ({ default: { validateRequest: vi.fn(() => true) } }));
vi.mock("next/server", async (importOriginal) => ({ ...(await importOriginal<typeof import("next/server")>()), after: vi.fn() }));
vi.mock("@/lib/twilio-client.server", () => ({ twilioWebhookAuthToken: () => "t", fetchTwilioMessageCreatedAt: vi.fn() }));
vi.mock("@/lib/rate-limit", () => ({ rateLimit: async () => ({ ok: true }) }));
vi.mock("@/lib/protected-accounts.server", () => ({ isShieldedRecipient: async () => false }));
vi.mock("@/lib/sms/inbound-replay.server", () => ({ loadInboundReplay: async () => ({ ok: true, receipt: null }) }));
vi.mock("@/lib/sms/inbound-pipeline.server", () => ({
  inboundMediaParams: (p: Record<string, string>) => Object.fromEntries(Object.entries(p).filter(([k]) => /^(NumMedia|MediaUrl\d+|MediaContentType\d+)$/.test(k))),
  inboundRuntime: () => "development",
  runClaimedInbound: mocks.run,
  twimlOk: () => new Response("<Response/>", { status: 200 }),
}));
vi.mock("@/lib/sms/resolve-owned-work-number.server", () => ({
  resolveOwnedWorkNumber: async () => ({ managerId: "owner-1", workspaceId: "ws-1", messagingServiceSid: "MG1" }),
}));
vi.mock("@/lib/sms/manager-workspace-role.server", () => ({
  resolveWorkspaceOwnerForWorkNumber: async () => ({ ownerUserId: "owner-1" }),
}));
vi.mock("@/lib/vendor-work-identity-inbound.server", () => ({ ingestVendorWorkIdentitySms: mocks.vendorIngest }));
vi.mock("@/lib/resident-agent-number/inbound.server", () => ({ ingestResidentAgentNumberSms: async () => ({ handled: false }) }));
vi.mock("@/lib/vendor-work-identity.server", () => ({ resolveVendorNumberSenderPhone: async () => null }));
vi.mock("@/lib/manager-sms-messages.server", () => ({ inboundLogIdentityFields: () => ({}) }));
vi.mock("@/lib/supabase/service", () => ({
  createSupabaseServiceRoleClient: () => ({ rpc: mocks.claim, from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { status: "completed" } }) }) }) }) }),
}));

import { POST } from "@/app/api/twilio/inbound/route";

function request(body: string) {
  const form = new URLSearchParams({ From: "+12065551234", To: "+12065550999", Body: body, MessageSid: "SM" + "1".repeat(32) });
  return new Request("https://example.test/api/twilio/inbound", { method: "POST", body: form.toString(), headers: { "content-type": "application/x-www-form-urlencoded", "x-twilio-signature": "sig" } });
}

describe("inbound webhook redaction", () => {
  beforeEach(() => {
    mocks.run.mockReset().mockResolvedValue(new Response("<Response/>", { status: 200 }));
    mocks.claim.mockReset().mockResolvedValue({ data: true, error: null });
    mocks.vendorIngest.mockReset().mockResolvedValue({ handled: false });
  });

  it("stores a texted card number redacted and flags the receipt for the secure-link reply", async () => {
    await POST(request("pay with 4242 4242 4242 4242 please"));
    const claimArgs = mocks.claim.mock.calls[0][1];
    expect(claimArgs.p_inbound_payload.body).toBe("pay with [redacted] please");
    expect(claimArgs.p_inbound_payload.redacted).toBe(true);
    expect(JSON.stringify(claimArgs)).not.toContain("4242");
    expect(mocks.run.mock.calls[0][1].body).toBe("pay with [redacted] please");
    expect(mocks.run.mock.calls[0][1].body).not.toContain("4242");
  });

  it("redacts before any other consumer of the body (vendor identity ingest sees the clean text)", async () => {
    await POST(request("acct number is 000123456789"));
    expect(mocks.vendorIngest.mock.calls[0][1].text).toBe("acct number is [redacted]");
  });

  it("leaves an ordinary text and its payload untouched", async () => {
    await POST(request("Is the room still available? Rent is 1250"));
    const payload = mocks.claim.mock.calls[0][1].p_inbound_payload;
    expect(payload.body).toBe("Is the room still available? Rent is 1250");
    expect(payload).not.toHaveProperty("redacted");
  });
});
