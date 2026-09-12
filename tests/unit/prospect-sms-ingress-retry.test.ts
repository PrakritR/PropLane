import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

function durableDb() {
  let calls = 0;
  const update = vi.fn(() => {
    const chain: Record<string, unknown> = {};
    chain.eq = () => chain;
    return chain;
  });
  return {
    db: {
      rpc: vi.fn(async () => {
        calls += 1;
        return {
          data: [{
            burst_id: "burst-1",
            revision: 4,
            inserted: calls === 1,
            due_at: "2099-01-01T00:00:00.000Z",
          }],
          error: null,
        };
      }),
      from: vi.fn(() => ({ update })),
    } as never,
    update,
  };
}

describe("durable prospect ingress publication retry", () => {
  beforeEach(() => {
    vi.stubEnv("PROSPECT_SMS_BURSTS_ENABLED", "1");
    vi.stubEnv("QSTASH_URL", "https://qstash.test");
    vi.stubEnv("QSTASH_TOKEN", "token");
    vi.stubEnv("PROSPECT_SMS_BURST_CALLBACK_URL", "https://prop-lane.test/api/internal/prospect-sms-burst");
    vi.stubEnv("PROSPECT_SMS_BURST_CALLBACK_SECRET", "secret");
    vi.stubEnv("QSTASH_CURRENT_SIGNING_KEY", "current");
    vi.stubEnv("QSTASH_NEXT_SIGNING_KEY", "next");
  });

  it("rejects the retired Claw rail before health, database, or queue work", async () => {
    const publish = vi.fn();
    vi.stubGlobal("fetch", publish);
    const { db } = durableDb();
    const { enqueueProspectSmsBurst } = await import("@/lib/sms/prospect-sms-burst.server");
    await expect(enqueueProspectSmsBurst(db, {
      sourceMessageId: "claw-source-retired",
      managerUserId: "00000000-0000-0000-0000-000000000001",
      counterpartyPhoneE164: "+15550001111",
      channel: "claw",
      body: "Is JainHome available?",
    })).resolves.toEqual({ ok: false, error: "retired_transport_unsupported" });
    expect(db.rpc).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("republishes a duplicate durable receipt without creating a second ingress revision", async () => {
    const publish = vi.fn()
      .mockResolvedValueOnce(new Response("unavailable", { status: 503 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ messageId: "queue-1" }), { status: 200 }));
    vi.stubGlobal("fetch", publish);
    const { db, update } = durableDb();
    const { enqueueProspectSmsBurst } = await import("@/lib/sms/prospect-sms-burst.server");
    const input = {
      sourceMessageId: "claw-source-1",
      managerUserId: "00000000-0000-0000-0000-000000000001",
      counterpartyPhoneE164: "+15550001111",
      channel: "twilio" as const,
      body: "Is JainHome available?",
    };

    await expect(enqueueProspectSmsBurst(db, input)).resolves.toEqual({
      ok: false, error: "durable_queue_unavailable",
    });
    await expect(enqueueProspectSmsBurst(db, input)).resolves.toEqual({
      ok: true, burstId: "burst-1", revision: 4, duplicate: true,
    });
    expect(db.rpc).toHaveBeenCalledTimes(2);
    expect(db.rpc).toHaveBeenNthCalledWith(2, "record_prospect_sms_ingress", expect.objectContaining({
      p_source_message_id: "claw-source-1",
      p_channel: "twilio",
    }));
    expect(publish).toHaveBeenCalledTimes(2);
    expect(update).toHaveBeenCalledTimes(1);
  });
});
