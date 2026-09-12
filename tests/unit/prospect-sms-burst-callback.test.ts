import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  health: vi.fn(), claim: vi.fn(), complete: vi.fn(), handle: vi.fn(), from: vi.fn(), verify: vi.fn(),
}));

vi.mock("@upstash/qstash", () => ({ Receiver: class { verify = mocks.verify; } }));
vi.mock("@/lib/sms/prospect-sms-burst.server", () => ({
  durableProspectSmsHealth: mocks.health, claimProspectSmsBurst: mocks.claim, completeProspectSmsBurst: mocks.complete,
}));
vi.mock("@/lib/claw-leasing-bot.server", () => ({ handleClawLeasingInbound: mocks.handle }));
vi.mock("@/lib/supabase/service", () => ({ createSupabaseServiceRoleClient: () => ({ from: mocks.from }) }));

function request() {
  return new Request("https://prop-lane.test/api/internal/prospect-sms-burst", {
    method: "POST", body: JSON.stringify({ burstId: "burst-1", revision: 2 }),
    headers: { "upstash-signature": "signed", "x-prospect-sms-burst-secret": "secret" },
  });
}

function burstQuery(row: object | null, error: object | null = null) {
  return { select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: async () => ({ data: row, error }) }), maybeSingle: async () => ({ data: row, error }) }) }) };
}

describe("prospect burst callback", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv("PROSPECT_SMS_BURSTS_ENABLED", "1"); vi.stubEnv("QSTASH_URL", "https://qstash.test"); vi.stubEnv("QSTASH_TOKEN", "token");
    vi.stubEnv("PROSPECT_SMS_BURST_CALLBACK_URL", "https://prop-lane.test/api/internal/prospect-sms-burst"); vi.stubEnv("PROSPECT_SMS_BURST_CALLBACK_SECRET", "secret");
    vi.stubEnv("QSTASH_CURRENT_SIGNING_KEY", "current"); vi.stubEnv("QSTASH_NEXT_SIGNING_KEY", "next");
    mocks.health.mockReturnValue({ ok: true }); mocks.verify.mockResolvedValue(true); mocks.claim.mockReset(); mocks.complete.mockReset(); mocks.handle.mockReset(); mocks.from.mockReset();
  });

  it("fails closed with 503 when durable queue configuration is unavailable", async () => {
    mocks.health.mockReturnValue({ ok: false, error: "durable_bursts_misconfigured" });
    const { POST } = await import("@/app/api/internal/prospect-sms-burst/route");
    expect((await POST(request())).status).toBe(503);
    expect(mocks.claim).not.toHaveBeenCalled();
  });

  it("retries a busy claim but acknowledges a stale revision", async () => {
    mocks.claim.mockResolvedValue({ ok: false, workerId: "w", sourceIds: [] });
    mocks.from.mockReturnValue(burstQuery({ revision: 2, handled_revision: 1, status: "generating" }));
    const { POST } = await import("@/app/api/internal/prospect-sms-burst/route");
    expect((await POST(request())).status).toBe(503);
    mocks.from.mockReturnValue(burstQuery({ revision: 3, handled_revision: 1, status: "queued" }));
    expect((await POST(request())).status).toBe(200);
  });

  it("loads exactly the claimed source ids and completes explicit suppression", async () => {
    mocks.claim.mockResolvedValue({ ok: true, workerId: "w", sourceIds: ["sid-b"] });
    mocks.from.mockImplementation((table: string) => {
      if (table === "prospect_sms_bursts") return burstQuery({ manager_user_id: "manager", counterparty_phone_e164: "+15550001111", reply_from_number: null });
      if (table === "prospect_sms_ingress") return { select: () => ({ eq: () => ({ in: (column: string, ids: string[]) => ({ order: async () => ({ data: [{ source_message_id: "sid-b", body: "latest" }], error: null, column, ids }) }) }) }) };
      throw new Error(`unexpected ${table}`);
    });
    mocks.handle.mockResolvedValue({ ok: true, replied: false, suppressed: true }); mocks.complete.mockResolvedValue(true);
    const { POST } = await import("@/app/api/internal/prospect-sms-burst/route");
    expect((await POST(request())).status).toBe(200);
    expect(mocks.handle).toHaveBeenCalledWith(expect.objectContaining({ text: "latest", mergedMessageIds: ["sid-b"] }));
    expect(mocks.complete).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ status: "suppressed" }));
  });

  it("completes a quiet manager handoff as a terminal no-reply burst", async () => {
    mocks.claim.mockResolvedValue({ ok: true, workerId: "w", sourceIds: ["sid-quiet"] });
    mocks.from.mockImplementation((table: string) => {
      if (table === "prospect_sms_bursts") return burstQuery({
        manager_user_id: "manager", counterparty_phone_e164: "+15550001111",
        reply_from_number: "+15550009999", reply_transport: "twilio", shared_catalog: false,
      });
      if (table === "prospect_sms_ingress") return {
        select: () => ({ eq: () => ({ in: () => ({ order: async () => ({
          data: [{ source_message_id: "sid-quiet", body: "Please ask the manager.", received_at: "2026-09-12T00:00:00Z" }],
          error: null,
        }) }) }) }),
      };
      throw new Error(`unexpected ${table}`);
    });
    mocks.handle.mockResolvedValue({ ok: true, replied: false, completedWithoutReply: "quiet_handoff" });
    mocks.complete.mockResolvedValue(true);
    const { POST } = await import("@/app/api/internal/prospect-sms-burst/route");

    const response = await POST(request());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true, replied: false, completedWithoutReply: "quiet_handoff",
    });
    expect(mocks.complete).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      status: "suppressed", burstId: "burst-1", revision: 2, workerId: "w",
    }));
  });

  it("rejects a persisted Claw rail before invoking the handler", async () => {
    mocks.claim.mockResolvedValue({ ok: true, workerId: "w", sourceIds: ["claw-source"] });
    mocks.from.mockImplementation((table: string) => {
      if (table === "prospect_sms_bursts") {
        return burstQuery({
          manager_user_id: "manager", counterparty_phone_e164: "+15550001111",
          reply_from_number: null, reply_transport: "claw", shared_catalog: true,
        });
      }
      if (table === "prospect_sms_ingress") {
        return { select: () => ({ eq: () => ({ in: () => ({ order: async () => ({
          data: [{ source_message_id: "claw-source", body: "what about another manager's listing?", received_at: "2026-09-12T00:00:00Z" }], error: null,
        }) }) }) }) };
      }
      if (table === "sms_outbox") return burstQuery({ status: "submitted" });
      throw new Error(`unexpected ${table}`);
    });
    mocks.handle.mockResolvedValue({ ok: true, replied: true, outboxId: "outbox-claw" });
    const { POST } = await import("@/app/api/internal/prospect-sms-burst/route");
    const response = await POST(request());
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ ok: false, unsupported: true, error: "retired_transport_unsupported" });
    expect(mocks.handle).not.toHaveBeenCalled();
    expect(mocks.complete).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ status: "failed" }));
  });

  it("rejects a two-fragment persisted Claw burst before provider execution", async () => {
    mocks.claim.mockResolvedValue({ ok: true, workerId: "worker-jain", sourceIds: ["jain-1", "jain-2"] });
    mocks.from.mockImplementation((table: string) => {
      if (table === "prospect_sms_bursts") return burstQuery({
        manager_user_id: "manager-a", counterparty_phone_e164: "+15550001111",
        reply_from_number: null, reply_transport: "claw", shared_catalog: true,
      });
      if (table === "prospect_sms_ingress") return {
        select: () => ({ eq: () => ({ in: () => ({ order: async () => ({ data: [
          { source_message_id: "jain-1", body: "Is JainHome available?", received_at: "2026-09-12T00:00:00Z" },
          { source_message_id: "jain-2", body: "Actually Jain Home - can I tour it?", received_at: "2026-09-12T00:00:03Z" },
        ], error: null }) }) }) }),
      };
      if (table === "sms_outbox") return burstQuery({ status: "submitted" });
      throw new Error(`unexpected ${table}`);
    });
    mocks.handle.mockResolvedValue({ ok: true, replied: true, outboxId: "one-jain-reply" });
    const { POST } = await import("@/app/api/internal/prospect-sms-burst/route");
    const response = await POST(request());
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ ok: false, unsupported: true, error: "retired_transport_unsupported" });
    expect(mocks.handle).not.toHaveBeenCalled();
  });

  it("keeps redundant silence distinct from explicit repeat and correction replies", async () => {
    mocks.claim.mockResolvedValue({ ok: true, workerId: "worker-repeat", sourceIds: ["repeat-1"] });
    let inboundBody = "Thanks";
    mocks.from.mockImplementation((table: string) => {
      if (table === "prospect_sms_bursts") return burstQuery({
        manager_user_id: "manager-a", counterparty_phone_e164: "+15550001111",
        reply_from_number: "+15550009999", reply_transport: "twilio", shared_catalog: false,
      });
      if (table === "prospect_sms_ingress") return {
        select: () => ({ eq: () => ({ in: () => ({ order: async () => ({ data: [
          { source_message_id: "repeat-1", body: inboundBody, received_at: "2026-09-12T00:00:00Z" },
        ], error: null }) }) }) }),
      };
      if (table === "sms_outbox") return burstQuery({ status: "submitted" });
      throw new Error(`unexpected ${table}`);
    });
    mocks.handle.mockResolvedValueOnce({ ok: true, replied: false, suppressed: true });
    const { POST } = await import("@/app/api/internal/prospect-sms-burst/route");
    expect((await POST(request())).status).toBe(200);
    expect(mocks.complete).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({ status: "suppressed" }));

    inboundBody = "Please send that again";
    mocks.handle.mockResolvedValueOnce({ ok: true, replied: true, outboxId: "repeat-reply" });
    expect((await POST(request())).status).toBe(200);
    inboundBody = "Actually, I meant Jain Home";
    mocks.handle.mockResolvedValueOnce({ ok: true, replied: true, outboxId: "correction-reply" });
    expect((await POST(request())).status).toBe(200);
    expect(mocks.handle.mock.calls.slice(-2).map(([input]) => input.text)).toEqual([
      "Please send that again", "Actually, I meant Jain Home",
    ]);
  });
});
