import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ shadowEnabled: vi.fn(), run: vi.fn(), trace: vi.fn() }));
vi.mock("@/lib/agent/prospect-gpt-shadow", () => ({ isProspectGptShadowEnabled: mocks.shadowEnabled, runProspectGptShadow: mocks.run }));
vi.mock("@/lib/observability/langfuse", () => ({ traceProspectShadowComparison: mocks.trace }));

type Job = { burst_id: string; burst_revision: number; manager_user_id: string; snapshot: object; status: "pending" | "running"; lease_expires_at: string | null };

function dbFor(jobs: Job[], claimLosers = new Set<string>()) {
  const updates: object[] = [];
  const db = {
    from: vi.fn((table: string) => {
      if (table !== "prospect_sms_shadow_jobs") throw new Error(`unexpected table ${table}`);
      return {
        select: () => ({ or: () => ({ order: () => ({ limit: async () => ({ data: jobs.slice(0, 2), error: null }) }) }) }),
        update: (patch: object) => {
          updates.push(patch);
          const chain: Record<string, unknown> = {}; const self = () => chain;
          chain.eq = self; chain.lt = self; chain.select = () => ({ maybeSingle: async () => ({
            data: claimLosers.has(String((patch as { lease_owner?: string }).lease_owner)) ? null : { burst_id: "claimed" }, error: null,
          }) });
          return chain;
        },
      };
    }),
  };
  return { db: db as never, updates };
}

describe("durable prospect shadow recovery", () => {
  beforeEach(() => { vi.resetModules(); mocks.shadowEnabled.mockReset(); mocks.run.mockReset(); mocks.trace.mockReset(); vi.stubEnv("OPENAI_API_KEY", "test"); });

  it("does not claim jobs while shadowing is disabled", async () => {
    mocks.shadowEnabled.mockReturnValue(false);
    const { db } = dbFor([{ burst_id: "b", burst_revision: 1, manager_user_id: "m", snapshot: {}, status: "pending", lease_expires_at: null }]);
    const { runPendingProspectShadows } = await import("@/lib/sms/prospect-sms-burst.server");
    await expect(runPendingProspectShadows(db)).resolves.toEqual({ shadowsCompleted: 0, shadowsUnknown: 0 });
    expect(db.from).not.toHaveBeenCalled();
  });

  it("claims pending work then completes it", async () => {
    mocks.shadowEnabled.mockReturnValue(true); mocks.run.mockResolvedValue({
      status: "completed", model: "gpt", comparison: {
        identity: { burstId: "b", burstRevision: 1, promptId: "leasing-sms-agent", promptHash: "prompt", release: "release", shadowProvider: "openai", shadowModel: "gpt" },
        grounding: "grounded", repetition: "new", toolCorrectness: "replayed",
      },
    });
    const { db, updates } = dbFor([{ burst_id: "b", burst_revision: 1, manager_user_id: "m", snapshot: { managerUserId: "m", promptId: "leasing-sms-agent", promptHash: "prompt", release: "release" }, status: "pending", lease_expires_at: null }]);
    const { runPendingProspectShadows } = await import("@/lib/sms/prospect-sms-burst.server");
    await expect(runPendingProspectShadows(db)).resolves.toEqual({ shadowsCompleted: 1, shadowsUnknown: 0 });
    expect(mocks.run).toHaveBeenCalledOnce(); expect(updates.map(x => (x as { status?: string }).status)).toEqual(["running", "completed"]);
    expect(updates[1]).toMatchObject({ result_metadata: { comparison: { identity: { burstRevision: 1, promptId: "leasing-sms-agent", promptHash: "prompt", release: "release" }, grounding: "grounded" } } });
    expect(mocks.trace).toHaveBeenCalledWith(expect.objectContaining({ metadata: expect.objectContaining({ burstRevision: 1, promptId: "leasing-sms-agent", promptHash: "prompt", release: "release", grounding: "grounded" }) }));
  });

  it("persists an explicit unknown comparison when recovery evidence is incomplete", async () => {
    mocks.shadowEnabled.mockReturnValue(true);
    mocks.run.mockResolvedValue({ status: "unknown", reason: "missing_tool_evidence", burstId: "b" });
    const { db, updates } = dbFor([{ burst_id: "b", burst_revision: 7, manager_user_id: "m", snapshot: {
      burstId: "b", burstRevision: 7, promptId: "leasing-sms-agent", promptHash: "prompt-7", release: "release-7",
      primaryProvider: "anthropic", primaryModel: "claude", managerUserId: "m",
    }, status: "pending", lease_expires_at: null }]);
    const { runPendingProspectShadows } = await import("@/lib/sms/prospect-sms-burst.server");
    await expect(runPendingProspectShadows(db)).resolves.toEqual({ shadowsCompleted: 0, shadowsUnknown: 1 });
    expect(updates[1]).toMatchObject({
      status: "unknown",
      result_metadata: {
        reason: "missing_tool_evidence",
        comparison: {
          identity: { burstId: "b", burstRevision: 7, promptId: "leasing-sms-agent", promptHash: "prompt-7", release: "release-7", primaryProvider: "anthropic", primaryModel: "claude" },
          grounding: "unknown", repetition: "unknown", toolCorrectness: "unknown",
        },
      },
    });
  });

  it("includes expired running work in recovery", async () => {
    mocks.shadowEnabled.mockReturnValue(true); mocks.run.mockResolvedValue({ status: "completed" });
    const { db } = dbFor([{ burst_id: "expired", burst_revision: 1, manager_user_id: "m", snapshot: {}, status: "running", lease_expires_at: "2000-01-01T00:00:00.000Z" }]);
    const { runPendingProspectShadows } = await import("@/lib/sms/prospect-sms-burst.server");
    await runPendingProspectShadows(db, new Date("2026-01-01T00:00:00.000Z"));
    expect(mocks.run).toHaveBeenCalledOnce();
  });

  it("does not call the provider when an atomic claim loses", async () => {
    mocks.shadowEnabled.mockReturnValue(true);
    const { db } = dbFor([{ burst_id: "b", burst_revision: 1, manager_user_id: "m", snapshot: {}, status: "pending", lease_expires_at: null }], new Set(["prospect-shadow"]));
    // Any generated worker id begins with this value; use a matcher via the mocked select below is unnecessary because a false claim is sufficient.
    (db.from as ReturnType<typeof vi.fn>).mockImplementation(() => ({ select: () => ({ or: () => ({ order: () => ({ limit: async () => ({ data: [{ burst_id: "b", burst_revision: 1, manager_user_id: "m", snapshot: {}, status: "pending" }], error: null }) }) }) }), update: () => ({ eq: () => ({ eq: () => ({ eq: () => ({ select: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }) }) }) }) }));
    const { runPendingProspectShadows } = await import("@/lib/sms/prospect-sms-burst.server"); await runPendingProspectShadows(db);
    expect(mocks.run).not.toHaveBeenCalled();
  });

  it("limits a recovery sweep to two shadow jobs", async () => {
    mocks.shadowEnabled.mockReturnValue(true); mocks.run.mockResolvedValue({ status: "completed" });
    const { db } = dbFor([1, 2, 3].map((n) => ({ burst_id: `b${n}`, burst_revision: 1, manager_user_id: "m", snapshot: {}, status: "pending" as const, lease_expires_at: null })));
    const { runPendingProspectShadows } = await import("@/lib/sms/prospect-sms-burst.server");
    await runPendingProspectShadows(db);
    expect(mocks.run).toHaveBeenCalledTimes(2);
  });
});
