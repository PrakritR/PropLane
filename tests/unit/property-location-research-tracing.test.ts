import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  recordPropertyResearchGeneration,
  withPropertyResearchTraceContext,
  type TraceLike,
} from "@/lib/observability/langfuse";
import { __resetPropertyResearchCache, researchPropertyLocation } from "@/lib/property-location-research.server";

const priorKey = process.env.BRAVE_SEARCH_API_KEY;
const originalFetch = global.fetch;

function fakeTrace() {
  const generations: Array<Record<string, unknown>> = [];
  const trace: TraceLike = {
    update: () => undefined,
    span: (args) => { generations.push(args); return { end: () => undefined }; },
    generation: (args) => {
      generations.push(args);
      return { end: () => undefined };
    },
  };
  return { trace, generations };
}

beforeEach(() => {
  process.env.BRAVE_SEARCH_API_KEY = "test-key";
  __resetPropertyResearchCache();
});
afterEach(() => {
  global.fetch = originalFetch;
  if (priorKey === undefined) delete process.env.BRAVE_SEARCH_API_KEY;
  else process.env.BRAVE_SEARCH_API_KEY = priorKey;
});

describe("nested property research generation tracing", () => {
  it("records one attributed paid generation for concurrent uncached work, and none for coalesced/cache callers", async () => {
    const response = { grounding: { generic: [{ title: "District", url: "https://district.example/schools", snippets: ["Civic Center school facts."] }] } };
    const fetchMock = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      return new Response(JSON.stringify(response), { status: 200 });
    });
    global.fetch = fetchMock as typeof fetch;
    const { trace, generations } = fakeTrace();
    const actor = { userId: "manager_a", metadata: { landlordId: "manager_a", role: "manager" } };
    const input = {
      scopeKey: "manager:m1", propertyId: "property-1", topic: "schools" as const,
      location: { address: "100 Civic Center Plaza", city: "San Francisco", state: "CA", zip: "94102" },
    };

    const [first, coalesced] = await withPropertyResearchTraceContext(trace, actor, () => Promise.all([
      researchPropertyLocation(input),
      researchPropertyLocation(input),
    ]));
    const cached = await withPropertyResearchTraceContext(trace, actor, () => researchPropertyLocation(input));

    expect(first.currentRequestEstimatedUsd).toBeGreaterThan(0);
    expect(coalesced.coalesced).toBe(true);
    expect(cached.cacheHit).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(generations).toHaveLength(3);
    const generation = generations.find(item => (item.metadata as { attempt?: boolean })?.attempt) as {
      name: string; model: string; usage: { input: number; output: number; unit: string };
      input: { topic: string; propertyId: string };
      metadata: { landlordId: string; role: string; provider: string; searchCalls: number; estimatedCostUsd: number; latencyMs: number };
    };
    expect(generation.name).toBe("property-location-research");
    expect(generation).not.toHaveProperty("model");
    expect(generation).not.toHaveProperty("usage");
    expect(generation.input).toEqual({ topic: "schools", propertyId: "property-1" });
    expect(generation.metadata).toMatchObject({
      landlordId: "manager_a", role: "manager", provider: "brave_llm_context", attempt: true, billingOutcome: "confirmed_estimate",
    });
    expect(generation.metadata.estimatedCostUsd).toBeGreaterThan(0);
    expect(generation.metadata.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it("keeps tracing fail-soft and omits unknown cost when usage is absent", async () => {
    const { trace } = fakeTrace();
    const failingTrace: TraceLike = { ...trace, span: () => { throw new Error("trace unavailable"); } };
    await expect(withPropertyResearchTraceContext(failingTrace, { userId: "resident_a" }, async () => {
      recordPropertyResearchGeneration({ topic: "schools", propertyId: "p1", outcome: "unavailable", latencyMs: 17, attempt: true, billingOutcome: "unknown", estimatedCostUsd: null });
    })).resolves.toBeUndefined();

    const { trace: normalTrace, generations } = fakeTrace();
    await withPropertyResearchTraceContext(normalTrace, { userId: "resident_a" }, async () => {
      recordPropertyResearchGeneration({ topic: "schools", propertyId: "p1", outcome: "unavailable", latencyMs: 17, attempt: true, billingOutcome: "unknown", estimatedCostUsd: null });
    });
    expect(generations).toHaveLength(1);
    expect(generations[0].metadata).not.toHaveProperty("estimatedCostUsd");
    expect(generations[0]).not.toHaveProperty("usage");
  });
});
