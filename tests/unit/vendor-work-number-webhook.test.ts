import { beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeDb, type FakeDb, type Row } from "../helpers/fake-table-db";

/**
 * The Twilio webhook around the vendor work number: STOP wins over vendor
 * routing, a text to a vendor's number goes to the vendor branch (never the
 * manager pipeline), and a vendor texting a manager line FROM their PropLane
 * number lands in the manager's pipeline as the vendor on the manager's list.
 */
const mocks = vi.hoisted(() => ({
  rpc: vi.fn(),
  ingest: vi.fn(),
  runClaimed: vi.fn(),
  db: null as unknown as FakeDb,
}));

vi.mock("twilio", () => ({ default: { validateRequest: () => true } }));
vi.mock("@/lib/twilio-client.server", () => ({
  twilioWebhookAuthToken: () => "auth-token",
  fetchTwilioMessageCreatedAt: vi.fn(async () => "2026-10-06T18:00:00.000Z"),
}));
vi.mock("@/lib/rate-limit", () => ({ rateLimit: vi.fn(async () => ({ ok: true })) }));
vi.mock("@/lib/protected-accounts.server", () => ({ isShieldedRecipient: async () => false }));
vi.mock("@/lib/sms/inbound-replay.server", () => ({ loadInboundReplay: async () => ({ ok: true, receipt: null }) }));
vi.mock("@/lib/sms/manager-workspace-role.server", () => ({
  resolveWorkspaceOwnerForWorkNumber: async (_db: unknown, id: string) => ({ ownerUserId: id, sharedFromCoManager: false, workspaceId: "ws-alder" }),
}));
vi.mock("@/lib/vendor-work-identity-inbound.server", () => ({ ingestVendorWorkIdentitySms: mocks.ingest }));
vi.mock("@/lib/sms/inbound-pipeline.server", () => ({
  inboundMediaParams: () => [],
  inboundRuntime: () => ({}),
  runClaimedInbound: mocks.runClaimed,
  twimlOk: () => new Response("<Response/>", { status: 200 }) as never,
}));
vi.mock("@/lib/supabase/service", () => ({
  createSupabaseServiceRoleClient: () => ({ from: (t: string) => mocks.db.from(t), rpc: mocks.rpc }),
}));

import { POST } from "@/app/api/twilio/inbound/route";

const VENDOR_NUMBER = "+14255550177";
const VENDOR_PHONE = "+12065550142";
const ALDER_LINE = "+12065550101";

function request(from: string, to: string, body: string, sid: string) {
  return new Request("https://prop-lane.space/api/twilio/inbound", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", "X-Twilio-Signature": "valid" },
    body: new URLSearchParams({ From: from, To: to, Body: body, MessageSid: sid }),
  });
}

function seed(extra: Record<string, Row[]> = {}): FakeDb {
  return createFakeDb({
    manager_sms_numbers: [{
      manager_user_id: "mgr-alder", workspace_id: "ws-alder", phone_number: ALDER_LINE, messaging_service_sid: "MG1",
      provision_state: "active", grace_expires_at: null, updated_at: "2026-10-01T00:00:00Z",
    }],
    vendor_work_identities: [{ id: "identity-1", vendor_user_id: "vendor-1", phone_number: VENDOR_NUMBER, sms_state: "ready" }],
    manager_vendor_records: [{ id: "rec-1", manager_user_id: "mgr-alder", vendor_user_id: "vendor-1", row_data: { phone: "(206) 555-0142", active: true } }],
    profiles: [{ id: "vendor-1", phone: VENDOR_PHONE, phone_verified_at: "2026-10-01T00:00:00Z" }],
    ...extra,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("TWILIO_MESSAGING_SERVICE_SID", "MG1");
  mocks.db = seed();
  mocks.rpc.mockResolvedValue({ data: true, error: null });
  mocks.ingest.mockResolvedValue({ handled: false });
  mocks.runClaimed.mockResolvedValue(new Response("<Response/>", { status: 200 }));
});

describe("STOP on a vendor's number", () => {
  it("is applied by the control receipt and never reaches vendor routing or a forward", async () => {
    const response = await POST(request(VENDOR_PHONE, VENDOR_NUMBER, "STOP", "SM-stop-1"));
    expect(response.status).toBe(200);
    expect(mocks.rpc).toHaveBeenCalledWith("apply_sms_control_keyword", expect.objectContaining({ p_keyword: "STOP", p_recipient_phone_key: "2065550142", p_manager_user_id: null }));
    expect(mocks.ingest).not.toHaveBeenCalled();
    expect(mocks.runClaimed).not.toHaveBeenCalled();
  });
});

describe("a text to a vendor's number", () => {
  it("goes to the vendor branch and never starts the manager pipeline", async () => {
    mocks.ingest.mockResolvedValue({ handled: true });
    const response = await POST(request(ALDER_LINE, VENDOR_NUMBER, "Can you look at the sink?", "SM-fwd-1"));
    expect(response.status).toBe(200);
    expect(mocks.ingest).toHaveBeenCalledWith(expect.anything(), { toPhone: VENDOR_NUMBER, fromPhone: ALDER_LINE, text: "Can you look at the sink?", messageSid: "SM-fwd-1" });
    expect(mocks.rpc).not.toHaveBeenCalledWith("claim_sms_inbound", expect.anything());
    expect(mocks.runClaimed).not.toHaveBeenCalled();
  });

  it("an unavailable vendor inbox is a retryable 503, never silent loss", async () => {
    mocks.ingest.mockRejectedValue(new Error("down"));
    const response = await POST(request(ALDER_LINE, VENDOR_NUMBER, "hello", "SM-fwd-2"));
    expect(response.status).toBe(503);
  });
});

describe("a vendor texting a manager's line from their PropLane number", () => {
  it("is processed as the vendor on the manager's list: the roster phone, not the PropLane number", async () => {
    const response = await POST(request(VENDOR_NUMBER, ALDER_LINE, "Yes, Thursday 10am", "SM-reply-1"));
    expect(response.status).toBe(200);
    expect(mocks.rpc).toHaveBeenCalledWith("claim_sms_inbound", expect.objectContaining({
      p_message_sid: "SM-reply-1", p_manager_user_id: "mgr-alder", p_recipient_phone_key: "2065550142",
      p_inbound_payload: expect.objectContaining({ fromPhone: "+12065550142", toPhone: ALDER_LINE }),
    }));
    expect(mocks.runClaimed).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ fromPhone: "+12065550142", managerId: "mgr-alder" }));
  });

  it("falls back to the vendor's verified phone when this manager has no roster row", async () => {
    mocks.db = seed({ manager_vendor_records: [] });
    await POST(request(VENDOR_NUMBER, ALDER_LINE, "hi", "SM-reply-2"));
    expect(mocks.rpc).toHaveBeenCalledWith("claim_sms_inbound", expect.objectContaining({ p_recipient_phone_key: "2065550142" }));
  });

  it("leaves every other sender untouched", async () => {
    await POST(request("+13605550000", ALDER_LINE, "hi", "SM-other-1"));
    expect(mocks.rpc).toHaveBeenCalledWith("claim_sms_inbound", expect.objectContaining({ p_recipient_phone_key: "3605550000" }));
  });

  it("does not map a number whose vendor identity is no longer ready", async () => {
    mocks.db = seed({ vendor_work_identities: [{ id: "identity-1", vendor_user_id: "vendor-1", phone_number: VENDOR_NUMBER, sms_state: "disabled" }] });
    await POST(request(VENDOR_NUMBER, ALDER_LINE, "hi", "SM-reply-3"));
    expect(mocks.rpc).toHaveBeenCalledWith("claim_sms_inbound", expect.objectContaining({ p_recipient_phone_key: "4255550177" }));
  });
});
