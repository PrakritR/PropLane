import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SharedLineConfig } from "@/lib/one-number/contracts";

const mocks = vi.hoisted(() => ({
  run: vi.fn(),
  claim: vi.fn(),
  seam: vi.fn(),
  moved: vi.fn(),
  config: { current: null as unknown },
}));

const WS = "ws-moved";
const SHARED = "+12065550100";
const OLD = "+12065550999";

vi.mock("twilio", () => ({ default: { validateRequest: vi.fn(() => true) } }));
vi.mock("next/server", async (importOriginal) => ({ ...(await importOriginal<typeof import("next/server")>()), after: vi.fn() }));
vi.mock("@/lib/twilio-client.server", () => ({ twilioWebhookAuthToken: () => "t", fetchTwilioMessageCreatedAt: vi.fn() }));
vi.mock("@/lib/rate-limit", () => ({ rateLimit: async () => ({ ok: true }) }));
vi.mock("@/lib/protected-accounts.server", () => ({ isShieldedRecipient: async () => false }));
vi.mock("@/lib/sms/inbound-replay.server", () => ({ loadInboundReplay: async () => ({ ok: true, receipt: null }) }));
vi.mock("@/lib/sms/inbound-pipeline.server", () => ({
  inboundMediaParams: () => ({}),
  inboundRuntime: () => "development",
  runClaimedInbound: mocks.run,
  twimlOk: (body?: string) => new Response(body ?? "<Response/>", { status: 200 }),
}));
vi.mock("@/lib/sms/resolve-owned-work-number.server", () => ({
  resolveOwnedWorkNumber: async (_db: unknown, to: string) => (to === OLD ? { managerId: "owner-1", workspaceId: WS, messagingServiceSid: "MG-old" } : null),
}));
vi.mock("@/lib/sms/manager-workspace-role.server", () => ({ resolveWorkspaceOwnerForWorkNumber: async () => ({ ownerUserId: "owner-1" }) }));
vi.mock("@/lib/vendor-work-identity-inbound.server", () => ({ ingestVendorWorkIdentitySms: async () => ({ handled: false }) }));
vi.mock("@/lib/resident-agent-number/inbound.server", () => ({ ingestResidentAgentNumberSms: async () => ({ handled: false }) }));
vi.mock("@/lib/vendor-work-identity.server", () => ({ resolveVendorNumberSenderPhone: async () => null }));
vi.mock("@/lib/manager-sms-messages.server", () => ({ inboundLogIdentityFields: () => ({}) }));
vi.mock("@/lib/one-number/config.server", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/one-number/config.server")>()), loadSharedLineConfig: async () => mocks.config.current }));
vi.mock("@/lib/one-number/inbound-seam.server", () => ({ handleSharedLineInbound: mocks.seam }));
vi.mock("@/lib/one-number/old-number.server", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/one-number/old-number.server")>()), sendMovedAutoReply: mocks.moved }));
vi.mock("@/lib/one-number/shadow.server", () => ({ recordShadowDecision: vi.fn() }));
vi.mock("@/lib/supabase/service", () => ({
  createSupabaseServiceRoleClient: () => ({ rpc: mocks.claim, from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { status: "completed" } }) }) }) }) }),
}));

import { POST } from "@/app/api/twilio/inbound/route";

const base: SharedLineConfig = { mode: "shared", sharedNumber: SHARED, messagingServiceSid: "MGs", pilotWorkspaceIds: [], dedicatedWorkspaceIds: [] };

function request(to: string) {
  const form = new URLSearchParams({ From: "+12065551234", To: to, Body: "is the room open", MessageSid: "SM" + "2".repeat(32) });
  return new Request("https://example.test/api/twilio/inbound", { method: "POST", body: form.toString(), headers: { "content-type": "application/x-www-form-urlencoded", "x-twilio-signature": "sig" } });
}
const continued = { kind: "continue", owned: { managerId: "owner-1", workspaceId: WS, messagingServiceSid: "MGs" } };

describe("a text to an old work number after the switch", () => {
  beforeEach(() => {
    mocks.run.mockReset().mockResolvedValue(new Response("<Response/>", { status: 200 }));
    mocks.claim.mockReset().mockResolvedValue({ data: true, error: null });
    mocks.seam.mockReset().mockResolvedValue(continued);
    mocks.moved.mockReset().mockResolvedValue("sent");
    mocks.config.current = base;
  });

  it("tells the sender once and routes the text as a shared-line text", async () => {
    await POST(request(OLD));
    expect(mocks.moved).toHaveBeenCalledTimes(1);
    expect(mocks.moved.mock.calls[0]![1]).toMatchObject({ workspaceId: WS, phoneKey: "2065551234", config: base });
    expect(mocks.seam).toHaveBeenCalledTimes(1);
    expect(mocks.run.mock.calls[0]![1]).toMatchObject({ toPhone: SHARED, sharedLine: true });
  });

  it("answers from the router when it handled the text (nothing is lost, the reply comes from the shared number)", async () => {
    mocks.seam.mockResolvedValue({ kind: "handled", twiml: "Which house?" });
    const res = await POST(request(OLD));
    expect(await res.text()).toBe("Which house?");
    expect(mocks.run).not.toHaveBeenCalled();
  });

  it("continues on the old number as before when the shared line takes nothing", async () => {
    mocks.seam.mockResolvedValue({ kind: "none" });
    await POST(request(OLD));
    expect(mocks.run.mock.calls[0]![1]).toMatchObject({ toPhone: OLD });
    expect(mocks.run.mock.calls[0]![1]).not.toHaveProperty("sharedLine");
  });

  it("a failing reply never stops the text from being routed", async () => {
    mocks.moved.mockRejectedValue(new Error("boom"));
    await POST(request(OLD));
    expect(mocks.run.mock.calls[0]![1]).toMatchObject({ toPhone: SHARED });
  });

  it("a dedicated workspace's number behaves exactly as today", async () => {
    mocks.config.current = { ...base, dedicatedWorkspaceIds: [WS] };
    await POST(request(OLD));
    expect(mocks.moved).not.toHaveBeenCalled();
    expect(mocks.seam).not.toHaveBeenCalled();
    expect(mocks.run.mock.calls[0]![1]).toMatchObject({ toPhone: OLD });
  });

  it("per-workspace mode is untouched", async () => {
    mocks.config.current = { mode: "per_workspace", sharedNumber: null, messagingServiceSid: null, pilotWorkspaceIds: [] };
    await POST(request(OLD));
    expect(mocks.moved).not.toHaveBeenCalled();
    expect(mocks.seam).not.toHaveBeenCalled();
    expect(mocks.run.mock.calls[0]![1]).toMatchObject({ toPhone: OLD });
  });
});
