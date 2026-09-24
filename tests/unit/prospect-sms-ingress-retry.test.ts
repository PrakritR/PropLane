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
    vi.stubEnv("AXIS_PROSPECT_GPT_SHADOW_ENABLED", "false");
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
    expect(publish.mock.calls[0]![0]).toBe("https://qstash.test/v2/publish/https://prop-lane.test/api/internal/prospect-sms-burst");
    const firstHeaders = publish.mock.calls[0]![1].headers as Record<string, string>;
    const secondHeaders = publish.mock.calls[1]![1].headers as Record<string, string>;
    expect(firstHeaders["Upstash-Deduplication-Id"]).toMatch(/^[a-f0-9]{64}$/);
    expect(secondHeaders["Upstash-Deduplication-Id"]).toBe(firstHeaders["Upstash-Deduplication-Id"]);
    expect(firstHeaders["Upstash-Deduplication-Id"]).not.toContain(":");
    expect(update).toHaveBeenCalledTimes(1);
  });

  it.each(["/api/internal/prospect-sms-burst", "ftp://prop-lane.test/callback", "not a url"])(
    "fails closed before database or queue work for invalid callback %s",
    async (callback) => {
      vi.stubEnv("PROSPECT_SMS_BURST_CALLBACK_URL", callback);
      const publish = vi.fn();
      vi.stubGlobal("fetch", publish);
      const { db } = durableDb();
      const { enqueueProspectSmsBurst } = await import("@/lib/sms/prospect-sms-burst.server");

      await expect(enqueueProspectSmsBurst(db, {
        sourceMessageId: "source-invalid-callback",
        managerUserId: "00000000-0000-0000-0000-000000000001",
        counterpartyPhoneE164: "+15550001111",
        channel: "twilio",
        body: "Is Jain Home available?",
      })).resolves.toEqual({ ok: false, error: "durable_bursts_misconfigured" });
      expect(db.rpc).not.toHaveBeenCalled();
      expect(publish).not.toHaveBeenCalled();
    },
  );

  it.each([
    "https://prop-lane.space/api/internal/prospect-sms-burst",
    "https://proplane.ai/api/internal/wrong-worker",
  ])(
    "fails closed before database or queue work when production uses a non-canonical callback %s",
    async (callback) => {
      vi.stubEnv("VERCEL_ENV", "production");
      vi.stubEnv("PROSPECT_SMS_BURST_CALLBACK_URL", callback);
      const publish = vi.fn();
      vi.stubGlobal("fetch", publish);
      const { db } = durableDb();
      const { enqueueProspectSmsBurst } = await import("@/lib/sms/prospect-sms-burst.server");

      await expect(enqueueProspectSmsBurst(db, {
        sourceMessageId: "source-production-wrong-callback",
        managerUserId: "00000000-0000-0000-0000-000000000001",
        counterpartyPhoneE164: "+15550001111",
        channel: "twilio",
        body: "Is Jain Home available?",
      })).resolves.toEqual({ ok: false, error: "durable_bursts_misconfigured" });
      expect(db.rpc).not.toHaveBeenCalled();
      expect(publish).not.toHaveBeenCalled();
    },
  );

  it("allows the exact canonical callback path in production", async () => {
    vi.stubEnv("VERCEL_ENV", "production");
    vi.stubEnv("PROSPECT_SMS_BURST_CALLBACK_URL", "https://proplane.ai/api/internal/prospect-sms-burst");
    const publish = vi.fn().mockResolvedValue(new Response(JSON.stringify({ messageId: "queue-production" }), { status: 200 }));
    vi.stubGlobal("fetch", publish);
    const { db, update } = durableDb();
    const { enqueueProspectSmsBurst } = await import("@/lib/sms/prospect-sms-burst.server");

    await expect(enqueueProspectSmsBurst(db, {
      sourceMessageId: "source-production-canonical",
      managerUserId: "00000000-0000-0000-0000-000000000001",
      counterpartyPhoneE164: "+15550001111",
      channel: "twilio",
      body: "Is Jain Home available?",
    })).resolves.toEqual({ ok: true, burstId: "burst-1", revision: 4, duplicate: false });
    expect(db.rpc).toHaveBeenCalledTimes(1);
    expect(db.rpc).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ p_quiet_seconds: 10 }));
    expect(publish).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledTimes(1);
  });

  it("allows a valid non-production callback destination", async () => {
    vi.stubEnv("VERCEL_ENV", "preview");
    vi.stubEnv("PROSPECT_SMS_BURST_CALLBACK_URL", "https://preview.example.test/api/internal/prospect-sms-burst");
    const publish = vi.fn().mockResolvedValue(new Response(JSON.stringify({ messageId: "queue-preview" }), { status: 200 }));
    vi.stubGlobal("fetch", publish);
    const { db } = durableDb();
    const { enqueueProspectSmsBurst } = await import("@/lib/sms/prospect-sms-burst.server");

    await expect(enqueueProspectSmsBurst(db, {
      sourceMessageId: "source-preview-callback",
      managerUserId: "00000000-0000-0000-0000-000000000001",
      counterpartyPhoneE164: "+15550001111",
      channel: "twilio",
      body: "Is Jain Home available?",
    })).resolves.toMatchObject({ ok: true, burstId: "burst-1", revision: 4 });
    expect(publish).toHaveBeenCalledTimes(1);
  });

  it("uses a fresh colon-free deduplication id for each recovery publication", async () => {
    const publish = vi.fn().mockResolvedValue(new Response(JSON.stringify({ messageId: "queue-recovery" }), { status: 200 }));
    vi.stubGlobal("fetch", publish);
    const chain = {
      or: () => ({ limit: async () => ({
        data: [
          { id: "burst-1", revision: 1, due_at: "2026-09-12T12:00:00.000Z" },
          { id: "burst-2", revision: 2, due_at: "2026-09-12T12:00:00.000Z" },
        ],
        error: null,
      }) }),
    };
    const updateChain: Record<string, unknown> = {};
    updateChain.eq = () => updateChain;
    const db = {
      from: vi.fn((table: string) => {
        if (table !== "prospect_sms_bursts") throw new Error(`unexpected table ${table}`);
        return { select: () => chain, update: () => updateChain };
      }),
    } as never;
    const { recoverProspectSmsBursts } = await import("@/lib/sms/prospect-sms-burst.server");

    await expect(recoverProspectSmsBursts(db, new Date("2026-09-12T12:00:00.000Z")))
      .resolves.toMatchObject({ scanned: 2, published: 2, failed: 0 });
    const deduplicationIds = publish.mock.calls.map((call) => (call[1].headers as Record<string, string>)["Upstash-Deduplication-Id"]);
    expect(new Set(deduplicationIds).size).toBe(2);
    expect(deduplicationIds).toEqual(deduplicationIds.map(() => expect.stringMatching(/^[a-f0-9]{64}$/)));
    expect(deduplicationIds.every((id) => !id.includes(":"))).toBe(true);
  });
});
