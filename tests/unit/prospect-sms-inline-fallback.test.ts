import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * QStash-outage fallback. When the queue refuses a burst (daily quota, network),
 * the durable ingress row still exists, so the inbound request or the recovery
 * cron runs the burst itself behind the same revision claim the queue worker uses.
 */

const mocks = vi.hoisted(() => ({
  handleInbound: vi.fn(),
  after: vi.fn(),
  recover: vi.fn(),
}));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/claw-leasing-bot.server", () => ({ handleClawLeasingInbound: mocks.handleInbound }));
vi.mock("@/lib/prospect-tour-booking-recovery.server", () => ({
  loadConfirmedProspectTourBooking: vi.fn(async () => null),
  recoverProspectTourBookingForBurst: vi.fn(),
}));

function claimDb(state: { revision: number; status: string; handled_revision: number; due_at?: string }) {
  const chain: Record<string, unknown> = {};
  for (const m of ["from", "select", "eq"]) chain[m] = vi.fn(() => chain);
  chain.maybeSingle = vi.fn(async () => ({ data: state, error: null }));
  chain.rpc = vi.fn(async () => ({ data: [{ claimed: false }], error: null }));
  return chain as unknown as { rpc: ReturnType<typeof vi.fn> } & Record<string, unknown>;
}

describe("inline prospect burst", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("waits out the quiet window before claiming, so later texts still merge", async () => {
    vi.setSystemTime(new Date("2026-09-24T15:00:00.000Z"));
    const db = claimDb({ revision: 2, status: "dispatched", handled_revision: 2 });
    const { runInlineProspectBurst } = await import("@/lib/sms/prospect-sms-burst-job.server");

    const run = runInlineProspectBurst(db as never, { burstId: "burst-1", revision: 2, dueAt: "2026-09-24T15:00:10.000Z" });
    await vi.advanceTimersByTimeAsync(9_000);
    expect(db.rpc).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_000);
    await run;
    expect(db.rpc).toHaveBeenCalledWith("claim_prospect_sms_burst", expect.objectContaining({ p_burst_id: "burst-1", p_revision: 2 }));
  });

  it("stands down without replying when the queue or a newer text already owns the revision", async () => {
    const db = claimDb({ revision: 3, status: "queued", handled_revision: 0 });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { runInlineProspectBurst } = await import("@/lib/sms/prospect-sms-burst-job.server");

    await runInlineProspectBurst(db as never, { burstId: "burst-1", revision: 2, dueAt: null });

    expect(mocks.handleInbound).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("never waits longer than its bound even for a far-future due time", async () => {
    vi.setSystemTime(new Date("2026-09-24T15:00:00.000Z"));
    const db = claimDb({ revision: 2, status: "dispatched", handled_revision: 2 });
    const { runInlineProspectBurst } = await import("@/lib/sms/prospect-sms-burst-job.server");

    const run = runInlineProspectBurst(db as never, { burstId: "burst-1", revision: 2, dueAt: "2026-09-24T16:00:00.000Z" });
    await vi.advanceTimersByTimeAsync(30_000);
    await run;
    expect(db.rpc).toHaveBeenCalledTimes(1);
  });
});

describe("burst worker answers without inviting queue retries", () => {
  it("reports a revision that exhausted its retries as failed, not busy", async () => {
    const db = claimDb({ revision: 2, status: "failed", handled_revision: 1 });
    const { runProspectSmsBurstJob } = await import("@/lib/sms/prospect-sms-burst-job.server");
    const res = await runProspectSmsBurstJob(db as never, "burst-1", 2);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: false, failed: true });
  });

  it("defers a revision still backing off after a failure", async () => {
    const db = claimDb({ revision: 2, status: "queued", handled_revision: 1, due_at: new Date(Date.now() + 60_000).toISOString() });
    const { runProspectSmsBurstJob } = await import("@/lib/sms/prospect-sms-burst-job.server");
    const res = await runProspectSmsBurstJob(db as never, "burst-1", 2);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, deferred: true });
  });

  it("keeps real contention retryable", async () => {
    const db = claimDb({ revision: 2, status: "generating", handled_revision: 1, due_at: new Date(Date.now() - 1_000).toISOString() });
    const { runProspectSmsBurstJob } = await import("@/lib/sms/prospect-sms-burst-job.server");
    expect((await runProspectSmsBurstJob(db as never, "burst-1", 2)).status).toBe(503);
  });
});

describe("recovery cron fallback", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doMock("next/server", async (importOriginal) => ({ ...(await importOriginal<typeof import("next/server")>()), after: mocks.after }));
    vi.doMock("@/lib/supabase/service", () => ({ createSupabaseServiceRoleClient: () => ({}) }));
    vi.doMock("@/lib/sms/prospect-sms-burst.server", () => ({ recoverProspectSmsBursts: mocks.recover }));
    vi.stubEnv("CRON_SECRET", "cron-secret");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.doUnmock("next/server");
    vi.doUnmock("@/lib/supabase/service");
    vi.doUnmock("@/lib/sms/prospect-sms-burst.server");
    vi.clearAllMocks();
  });

  const cronRequest = () => new Request("https://proplane.ai/api/cron/prospect-sms-bursts", { headers: { authorization: "Bearer cron-secret" } });

  it("runs at most three bursts the queue refused, after responding", async () => {
    const unpublished = [1, 2, 3, 4].map((n) => ({ burstId: `burst-${n}`, revision: 1, dueAt: null }));
    mocks.recover.mockResolvedValue({ scanned: 4, published: 0, failed: 4, unpublished, shadowsCompleted: 0, shadowsUnknown: 0 });
    const { GET } = await import("@/app/api/cron/prospect-sms-bursts/route");

    const response = await GET(cronRequest());

    expect(await response.json()).toMatchObject({ failed: 4, inline: 3 });
    expect(mocks.after).toHaveBeenCalledTimes(1);
  });

  it("skips bursts still backing off and runs the most overdue first", async () => {
    const future = new Date(Date.now() + 5 * 60_000).toISOString();
    const unpublished = [
      { burstId: "later", revision: 1, dueAt: future },
      { burstId: "newer", revision: 1, dueAt: new Date(Date.now() - 1_000).toISOString() },
      { burstId: "oldest", revision: 1, dueAt: new Date(Date.now() - 60_000).toISOString() },
    ];
    mocks.recover.mockResolvedValue({ scanned: 3, published: 0, failed: 3, unpublished, shadowsCompleted: 0, shadowsUnknown: 0 });
    const run = vi.fn(async () => undefined);
    vi.doMock("@/lib/sms/prospect-sms-burst-job.server", () => ({ runInlineProspectBurst: run }));
    const { GET } = await import("@/app/api/cron/prospect-sms-bursts/route");

    expect(await (await GET(cronRequest())).json()).toMatchObject({ inline: 2 });
    await mocks.after.mock.calls[0]![0]();
    expect(run.mock.calls.map((call) => (call as unknown as [unknown, { burstId: string }])[1].burstId)).toEqual(["oldest", "newer"]);
    vi.doUnmock("@/lib/sms/prospect-sms-burst-job.server");
  });

  it("schedules nothing when every burst was queued", async () => {
    mocks.recover.mockResolvedValue({ scanned: 1, published: 1, failed: 0, unpublished: [], shadowsCompleted: 0, shadowsUnknown: 0 });
    const { GET } = await import("@/app/api/cron/prospect-sms-bursts/route");

    const response = await GET(cronRequest());

    expect(response.status).toBe(200);
    expect(mocks.after).not.toHaveBeenCalled();
  });

  it("still rejects an unauthenticated sweep", async () => {
    const { GET } = await import("@/app/api/cron/prospect-sms-bursts/route");
    const response = await GET(new Request("https://proplane.ai/api/cron/prospect-sms-bursts"));
    expect(response.status).toBe(401);
    expect(mocks.recover).not.toHaveBeenCalled();
  });
});
