import { beforeEach, describe, expect, it, vi } from "vitest";
import { classifyIntentHeuristic, coerceIntent, matchedIntents } from "@/lib/one-number/intent";
import { isSlowWorkTool, SLOW_WORK_TOOLS, WORK_ACK_TEXT } from "@/lib/one-number/slow-work";
import { isGsm7, smsSegmentCount } from "@/lib/one-number/segments";
import { withPromptCaching } from "@/lib/agent/provider";

describe("intent heuristic", () => {
  it.each([
    ["wifi password?", "faq"],
    ["what day is trash", "faq"],
    ["the sink is leaking", "maintenance"],
    ["wifi is down", "maintenance"],
    ["when is rent due", "rent"],
    ["can I tour room 3", "tour"],
    ["I want to apply", "application"],
    ["let me talk to a real person", "human_needed"],
    ["there is a fire", "human_needed"],
  ])("%s -> %s", (text, intent) => {
    expect(classifyIntentHeuristic(text)).toBe(intent);
  });

  it("is null when the rules cannot tell, and lists every match for a mixed text", () => {
    expect(classifyIntentHeuristic("ok thanks")).toBeNull();
    expect(classifyIntentHeuristic("")).toBeNull();
    expect(matchedIntents("wifi password? also my rent receipt")).toEqual(["faq", "rent"]);
  });

  it("coerces a model word onto the closed set", () => {
    expect(coerceIntent(" Maintenance. ")).toBe("maintenance");
    expect(coerceIntent("human_needed")).toBe("human_needed");
    expect(coerceIntent("banana")).toBe("other");
    expect(coerceIntent(null)).toBe("other");
  });
});

describe("slow work", () => {
  it("names dispatch, screening and payment tools, and nothing read-only", () => {
    for (const name of ["dispatch_vendor", "order_background_check", "start_rent_payment"]) expect(isSlowWorkTool(name)).toBe(true);
    for (const name of ["list_charges", "get_application_details", "", null, undefined]) expect(isSlowWorkTool(name as never)).toBe(false);
    expect(SLOW_WORK_TOOLS.size).toBeGreaterThan(5);
  });

  it("the ack is one GSM-7 segment, plain words", () => {
    expect(isGsm7(WORK_ACK_TEXT)).toBe(true);
    expect(smsSegmentCount(WORK_ACK_TEXT)).toBe(1);
    expect(WORK_ACK_TEXT).toBe("On it, I'll text you when it's done.");
  });
});

describe("prompt caching", () => {
  const tools = [
    { name: "a", description: "a", input_schema: { type: "object" } },
    { name: "b", description: "b", input_schema: { type: "object" } },
  ] as never;

  it("puts a cache breakpoint on the system block and the last tool only", () => {
    const out = withPromptCaching({ system: "You are PropLane.", tools });
    expect(out.system).toEqual([{ type: "text", text: "You are PropLane.", cache_control: { type: "ephemeral" } }]);
    expect(out.tools[0]).not.toHaveProperty("cache_control");
    expect(out.tools[1]).toMatchObject({ name: "b", cache_control: { type: "ephemeral" } });
  });

  it("copes with no tools or an empty system", () => {
    expect(withPromptCaching({ system: "", tools: [] })).toEqual({ system: [], tools: [] });
  });

  it("does not mutate the caller's tool objects", () => {
    withPromptCaching({ system: "s", tools });
    expect((tools as unknown as object[])[1]).not.toHaveProperty("cache_control");
  });
});

// --- turn metrics -------------------------------------------------------------------------------
const m = vi.hoisted(() => ({ track: vi.fn(), score: vi.fn(), update: vi.fn() }));
vi.mock("@/lib/analytics/posthog", () => ({ track: m.track }));
vi.mock("@/lib/observability/langfuse", () => ({ scoreSmsDelivery: m.score }));

import { elapsedSince, recordSmsTurnMetrics } from "@/lib/one-number/turn-metrics.server";

function metricsDb(error: { code?: string; message?: string } | null = null) {
  const calls: { values: Record<string, unknown>; filters: [string, unknown][] }[] = [];
  const db = {
    from: (table: string) => ({
      update: (values: Record<string, unknown>) => {
        const call = { values, filters: [] as [string, unknown][], table };
        calls.push(call);
        const chain: Record<string, unknown> = {
          eq: (column: string, value: unknown) => { call.filters.push([column, value]); return chain; },
          then: (resolve: (v: unknown) => void) => resolve({ error }),
        };
        return chain;
      },
    }),
  };
  return { db: db as never, calls };
}

const metrics = { intent: "faq", lane: "fast_path", modelUsed: null, bubbleCount: 1, firstBubbleMs: 1800, totalLatencyMs: 2100, replyStatus: "sent" } as const;

describe("recordSmsTurnMetrics", () => {
  beforeEach(() => vi.clearAllMocks());

  it("stores the fields on the answered text's inbound projection turn", async () => {
    const { db, calls } = metricsDb();
    await recordSmsTurnMetrics(db, { ownerUserId: "o", messageSid: "SM1", role: "resident", traceId: null, metrics });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.values).toMatchObject({
      intent: "faq", reply_lane: "fast_path", model_used: null, fast_path: true, bubble_count: 1,
      first_bubble_ms: 1800, total_latency_ms: 2100, reply_status: "sent",
    });
    expect(calls[0]!.filters).toEqual([["owner_manager_user_id", "o"], ["source_event_id", "SM1"], ["direction", "inbound"]]);
  });

  it("sends sms_reply_sent with numbers and ids only", async () => {
    const { db } = metricsDb();
    await recordSmsTurnMetrics(db, { ownerUserId: "o", messageSid: "SM1", role: "resident", metrics });
    expect(m.track).toHaveBeenCalledWith("sms_reply_sent", "o", {
      role: "resident", intent: "faq", lane: "fast_path", model: "none", fast_path: true, bubble_count: 1, first_bubble_ms: 1800, total_latency_ms: 2100,
    });
    for (const value of Object.values(m.track.mock.calls[0]![2] as Record<string, unknown>)) expect(typeof value).not.toBe("object");
  });

  it("a held draft is logged but is not a sent reply", async () => {
    const { db, calls } = metricsDb();
    await recordSmsTurnMetrics(db, { ownerUserId: "o", messageSid: "SM1", role: "resident", metrics: { ...metrics, lane: "agent", modelUsed: "claude-sonnet-4-6", replyStatus: "draft", firstBubbleMs: null } });
    expect(calls[0]!.values).toMatchObject({ reply_status: "draft", fast_path: false, model_used: "claude-sonnet-4-6", first_bubble_ms: null });
    expect(m.track).not.toHaveBeenCalled();
  });

  it("attaches the same fields to the Langfuse trace", async () => {
    const { db } = metricsDb();
    await recordSmsTurnMetrics(db, { ownerUserId: "o", messageSid: "SM1", role: "manager", traceId: "trace-1", metrics });
    expect(m.score).toHaveBeenCalledWith({ traceId: "trace-1", intent: "faq", lane: "fast_path", firstBubbleMs: 1800, totalLatencyMs: 2100, bubbleCount: 1 });
  });

  it("never throws, whether the columns are missing or the write blows up", async () => {
    await expect(recordSmsTurnMetrics(metricsDb({ code: "42703" }).db, { ownerUserId: "o", messageSid: "SM1", role: "resident", metrics })).resolves.toBeUndefined();
    await expect(recordSmsTurnMetrics({ from: () => { throw new Error("down"); } } as never, { ownerUserId: "o", messageSid: "SM1", role: "resident", metrics })).resolves.toBeUndefined();
  });
});

describe("elapsedSince", () => {
  it("is milliseconds since the receipt, and null for garbage or absurd values", () => {
    const now = Date.parse("2026-10-18T12:00:02.500Z");
    expect(elapsedSince("2026-10-18T12:00:00.000Z", now)).toBe(2500);
    expect(elapsedSince("nope", now)).toBeNull();
    expect(elapsedSince(null, now)).toBeNull();
    expect(elapsedSince("2026-10-18T12:00:05.000Z", now)).toBeNull();
    expect(elapsedSince("2026-10-17T12:00:00.000Z", now)).toBeNull();
  });
});
