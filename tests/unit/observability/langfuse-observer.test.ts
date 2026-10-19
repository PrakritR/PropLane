import { describe, it, expect } from "vitest";
import { buildTraceObserver, recordFailedAgentGeneration, type TraceLike, type TraceActor } from "@/lib/observability/langfuse";

const ctx: TraceActor = {
  userId: "manager_a",
  metadata: { landlordId: "manager_a", role: "manager" },
};

function fakeTrace() {
  const calls = {
    update: [] as unknown[],
    generation: [] as unknown[],
    span: [] as unknown[],
    generationEnd: 0,
    spanEnd: 0,
  };
  const trace: TraceLike = {
    update: (a) => void calls.update.push(a),
    generation: (a) => {
      calls.generation.push(a);
      return { end: () => void (calls.generationEnd += 1) };
    },
    span: (a) => {
      calls.span.push(a);
      return { end: () => void (calls.spanEnd += 1) };
    },
  };
  return { trace, calls };
}

describe("buildTraceObserver", () => {
  it("records native failed-call usage and cost without charging earlier calls again", () => {
    const { trace, calls } = fakeTrace();
    const error = Object.assign(new Error("Incomplete response"), {
      responseModel: "gpt-6-luna", incompleteReason: "max_output_tokens",
      responseUsage: { inputTokens: 1000, outputTokens: 500, cachedInputTokens: 600, cacheCreationInputTokens: 100, reasoningOutputTokens: 400 },
    });
    recordFailedAgentGeneration(trace, error);
    expect(calls.generation).toHaveLength(1);
    expect(calls.generation[0]).toMatchObject({
      name: "axis-agent-llm-failed", model: "gpt-6-luna", level: "ERROR",
      usageDetails: { input: 300, input_cached: 600, input_cache_write: 100, output: 500 },
    });
    expect((calls.generation[0] as { costDetails: { total: number } }).costDetails.total).toBeCloseTo(0.0002985, 10);
    expect(calls.generationEnd).toBe(1);
  });

  it("does not invent native usage for failed calls without returned usage", () => {
    const { trace, calls } = fakeTrace();
    recordFailedAgentGeneration(trace, new Error("Network failed"));
    expect(calls.generation).toHaveLength(0);
  });

  it("sums per-call Luna costs without applying a long-context rate to the accumulated turn", () => {
    const { trace } = fakeTrace();
    const built = buildTraceObserver(trace, ctx);
    for (const iteration of [0, 1]) built.observer.onLlmCall!({
      iteration, model: "gpt-6-luna", usage: { inputTokens: 200_000, outputTokens: 1_000 },
      stopReason: "end_turn", toolsChosen: [], provider: "openai", route: "luna_primary",
      latencyMs: 1, input: [], assistantContent: [],
    });
    expect(built.getEstimatedCost()).toBeCloseTo(0.041);
  });

  it("keeps unknown-model cost unknown", () => {
    const { trace } = fakeTrace();
    const built = buildTraceObserver(trace, ctx);
    built.observer.onLlmCall!({
      iteration: 0, model: "unknown-price", usage: { inputTokens: 100, outputTokens: 10 },
      stopReason: "end_turn", toolsChosen: [], provider: "openai", route: "luna_primary",
      latencyMs: 1, input: [], assistantContent: [],
    });
    expect(built.getEstimatedCost()).toBeUndefined();
  });

  it("records tools-available, a costed per-call generation, and a tool span", () => {
    const { trace, calls } = fakeTrace();
    const { observer: obs, getEvidence } = buildTraceObserver(trace, ctx);

    obs.onStart!({
      system: "SYS",
      toolsAvailable: ["list_things"],
      model: "claude-haiku-4-5",
      tier: "simple",
      provider: "anthropic",
      route: "anthropic",
    });
    obs.onLlmCall!({
      iteration: 0,
      model: "claude-haiku-4-5",
      usage: { inputTokens: 1_000_000, outputTokens: 1_000_000 }, // $1 in + $5 out = $6
      stopReason: "tool_use",
      toolsChosen: ["list_things"],
      provider: "anthropic",
      route: "anthropic",
      latencyMs: 12,
      input: [{ role: "user", content: "hi" }],
      assistantContent: [],
    });
    obs.onToolCall!({ iteration: 0, name: "list_things", input: { limit: 2 }, ok: true, output: { things: ["a"] } });

    const start = calls.update[0] as { metadata: { toolsAvailable: string[]; systemPrompt: string } };
    expect(start.metadata.toolsAvailable).toEqual(["list_things"]);
    expect(start.metadata.systemPrompt).toBe("SYS");

    const gen = calls.generation[0] as {
      usage: { input: number; output: number };
      metadata: { estimatedCostUsd: number; landlordId: string };
    };
    expect(gen.usage).toEqual({ input: 1_000_000, output: 1_000_000, unit: "TOKENS" });
    expect(gen.metadata.estimatedCostUsd).toBeCloseTo(6, 5);
    expect(calls.generation[0]).toMatchObject({ costDetails: { input: 1, output: 5, total: 6 }, usageDetails: { input: 1_000_000, input_cached: 0, input_cache_write: 0, output: 1_000_000 } });
    expect(gen.metadata.landlordId).toBe("manager_a");

    const span = calls.span[0] as { name: string; input: unknown; output: unknown; metadata: { ok: boolean } };
    expect(span.name).toBe("tool:list_things");
    expect(span.input).toEqual({ limit: 2 });
    expect(span.output).toEqual({ things: ["a"] });
    expect(span.metadata.ok).toBe(true);
    expect(calls.generationEnd).toBe(1);
    expect(calls.spanEnd).toBe(1);
    expect(getEvidence()).toEqual([{ name: "list_things", ok: true, output: { things: ["a"] } }]);
  });

  it("stamps prompt metadata when provided", () => {
    const { trace, calls } = fakeTrace();
    const { observer: obs } = buildTraceObserver(trace, ctx, {
      promptId: "manager-assistant",
      promptHash: "abc",
      release: "deadbeef",
    });
    obs.onStart!({
      system: "SYS",
      toolsAvailable: [],
      model: "m",
      tier: "simple",
      provider: "anthropic",
      route: "anthropic",
    });
    const start = calls.update[0] as {
      metadata: { promptId: string; promptHash: string; release: string };
    };
    expect(start.metadata.promptId).toBe("manager-assistant");
    expect(start.metadata.promptHash).toBe("abc");
    expect(start.metadata.release).toBe("deadbeef");
  });

  it("swallows errors thrown by the trace so tracing never breaks a turn", () => {
    const trace: TraceLike = {
      update: () => {
        throw new Error("boom");
      },
      generation: () => {
        throw new Error("boom");
      },
      span: () => {
        throw new Error("boom");
      },
    };
    const { observer: obs } = buildTraceObserver(trace, ctx);
    expect(() => {
      obs.onStart!({
        system: "x",
        toolsAvailable: [],
        model: "m",
        tier: "standard",
        provider: "anthropic",
        route: "anthropic",
      });
      obs.onLlmCall!({
        iteration: 0,
        model: "m",
        usage: { inputTokens: 0, outputTokens: 0 },
        stopReason: null,
        toolsChosen: [],
        provider: "anthropic",
        route: "anthropic",
        latencyMs: 1,
        input: [],
        assistantContent: [],
      });
      obs.onToolCall!({ iteration: 0, name: "t", input: {}, ok: false, output: "err" });
    }).not.toThrow();
  });
});
