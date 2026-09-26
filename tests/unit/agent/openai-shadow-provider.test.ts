import { afterEach, describe, expect, it, vi } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import { completeOpenAIResponses, OpenAIIncompleteResponseError } from "@/lib/agent/provider";
import {
  isProspectGptShadowEnabled,
  runProspectGptShadow,
  scheduleProspectGptShadow,
} from "@/lib/agent/prospect-gpt-shadow";

const base = { model: "gpt-5.4-mini", system: "reply", tools: [], messages: [{ role: "user", content: "hello" }] as Anthropic.MessageParam[] };

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("OpenAI Responses provider", () => {
  it("passes explicit reasoning only when selected and preserves cache and reasoning usage", async () => {
    vi.stubEnv("OPENAI_API_KEY", "test-key");
    const responseBody = JSON.stringify({
      id: "resp_usage", status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: "Done." }] }],
      usage: { input_tokens: 100, output_tokens: 25, input_tokens_details: { cached_tokens: 60, cache_write_tokens: 20 }, output_tokens_details: { reasoning_tokens: 15 } },
    });
    const fetchMock = vi.fn().mockImplementation(async () => new Response(responseBody, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const result = await completeOpenAIResponses({ ...base, model: "gpt-6-luna", reasoningEffort: "high", maxOutputTokens: 1024 });
    const body = JSON.parse(String(fetchMock.mock.calls[0]![1].body));
    expect(body.reasoning).toEqual({ effort: "high" });
    expect(body.max_output_tokens).toBe(1024);
    expect(result.usage).toMatchObject({ inputTokens: 100, cachedInputTokens: 60, cacheCreationInputTokens: 20, outputTokens: 25, reasoningOutputTokens: 15 });
    await completeOpenAIResponses(base);
    expect(JSON.parse(String(fetchMock.mock.calls[1]![1].body)).reasoning).toBeUndefined();
  });

  it("round trips text and function calls, preserving call ids and continuation", async () => {
    vi.stubEnv("OPENAI_API_KEY", "test-key");
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      id: "resp_1", status: "completed", output: [
        { type: "message", content: [{ type: "output_text", text: "Checking." }] },
        { type: "function_call", call_id: "call_1", name: "list_listings", arguments: '{"query":"Jain Home"}' },
      ], usage: { input_tokens: 12, output_tokens: 4 },
    }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const result = await completeOpenAIResponses({ ...base, tools: [{ name: "list_listings", description: "list", input_schema: { type: "object" } }] });
    expect(result.provider).toBe("openai");
    expect(result.content).toMatchObject([{ type: "text", text: "Checking." }, { type: "tool_use", id: "call_1", name: "list_listings", input: { query: "Jain Home" } }]);
    expect(result.continuationState).toMatchObject({ provider: "openai", responseId: "resp_1", outputItems: expect.any(Array) });
    const body = JSON.parse(String(fetchMock.mock.calls[0]![1].body));
    expect(body.store).toBe(false);
    expect(body.tools[0].name).toBe("list_listings");
  });

  it("rejects malformed function arguments and replays opaque continuation output", async () => {
    vi.stubEnv("OPENAI_API_KEY", "test-key");
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ id: "resp_2", output: [{ type: "function_call", id: "item_f", call_id: "call_f", name: "lookup", arguments: "not-json" }] }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(completeOpenAIResponses({ ...base, continuationState: { provider: "openai", responseId: "previous", inputItems: [{ role: "user", content: "prior" }], outputItems: [{ type: "reasoning", encrypted_content: "opaque" }], consumedMessageCount: 0 } })).rejects.toThrow("malformed");
    const request = JSON.parse(String(fetchMock.mock.calls[0]![1].body));
    expect(request.previous_response_id).toBeUndefined();
    expect(request.input[0]).toMatchObject({ role: "user", content: "prior" });
    expect(request.input[1]).toMatchObject({ type: "reasoning", encrypted_content: "opaque" });
    expect(request.include).toContain("reasoning.encrypted_content");
  });

  it("rejects a function call that lacks its distinct call_id", async () => {
    vi.stubEnv("OPENAI_API_KEY", "test-key");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      id: "resp_missing_call_id",
      output: [{ type: "function_call", id: "item_only", name: "lookup", arguments: "{}" }],
    }), { status: 200 })));
    await expect(completeOpenAIResponses(base)).rejects.toThrow(/without call_id/);
  });

  it("fails closed on failed responses and missing usage in primary mode", async () => {
    vi.stubEnv("OPENAI_API_KEY", "test-key");
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: "failed", status: "failed", output: [] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: "unmetered", status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: "ok" }] }] }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(completeOpenAIResponses(base)).rejects.toThrow(/failed response/);
    await expect(completeOpenAIResponses({ ...base, requireUsage: true })).rejects.toThrow(/without token usage/);
  });

  it("preserves the HTTP status on a provider rate limit", async () => {
    vi.stubEnv("OPENAI_API_KEY", "test-key");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: { message: "Rate limit reached" } }), { status: 429 })));
    await expect(completeOpenAIResponses(base)).rejects.toThrow(/request failed \(429\): Rate limit reached/);
  });

  it("preserves billable usage and the reason on an incomplete response", async () => {
    vi.stubEnv("OPENAI_API_KEY", "test-key");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      id: "incomplete", model: "gpt-6-luna", status: "incomplete", incomplete_details: { reason: "max_output_tokens" }, output: [],
      usage: { input_tokens: 120, output_tokens: 1024, input_tokens_details: { cached_tokens: 80, cache_write_tokens: 20 }, output_tokens_details: { reasoning_tokens: 990 } },
    }), { status: 200 })));
    await expect(completeOpenAIResponses({ ...base, model: "gpt-6-luna", requireUsage: true })).rejects.toMatchObject({
      name: "OpenAIIncompleteResponseError", incompleteReason: "max_output_tokens",
      responseUsage: { inputTokens: 120, cachedInputTokens: 80, cacheCreationInputTokens: 20, outputTokens: 1024, reasoningOutputTokens: 990 },
    } satisfies Partial<OpenAIIncompleteResponseError>);
  });

  it("fails closed on a completed response with no usable text or tool call", async () => {
    vi.stubEnv("OPENAI_API_KEY", "test-key");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      id: "empty", model: "gpt-6-luna", status: "completed", output: [{ type: "reasoning", summary: [] }],
      usage: { input_tokens: 100, output_tokens: 20 },
    }), { status: 200 })));
    await expect(completeOpenAIResponses({ ...base, model: "gpt-6-luna", requireUsage: true })).rejects.toMatchObject({
      name: "OpenAIUnusableResponseError", failureReason: "empty_output", responseUsage: { inputTokens: 100, outputTokens: 20 },
    });
  });

  it("fails closed on whitespace-only output text", async () => {
    vi.stubEnv("OPENAI_API_KEY", "test-key");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      id: "blank", model: "gpt-6-luna", status: "completed",
      output: [{ type: "message", content: [{ type: "output_text", text: "  \n " }] }],
      usage: { input_tokens: 100, output_tokens: 1 },
    }), { status: 200 })));
    await expect(completeOpenAIResponses({ ...base, model: "gpt-6-luna", requireUsage: true })).rejects.toMatchObject({
      name: "OpenAIUnusableResponseError", failureReason: "empty_output",
    });
  });

  it("fails closed without a key and propagates timeout failures", async () => {
    vi.stubEnv("OPENAI_API_KEY", "");
    await expect(completeOpenAIResponses(base)).rejects.toThrow("not configured");
    vi.stubEnv("OPENAI_API_KEY", "test-key");
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new DOMException("timed out", "TimeoutError")));
    await expect(completeOpenAIResponses({ ...base, timeoutMs: 250 })).rejects.toThrow("timed out");
  });
});

describe("prospect GPT shadow isolation", () => {
  const listingTool = [{ name: "list_listings", description: "list", input_schema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } }];

  it("enables only before a valid configured UTC deadline", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-12T12:00:00.000Z"));
    vi.stubEnv("AXIS_PROSPECT_GPT_SHADOW_ENABLED", "true");

    vi.stubEnv("AXIS_PROSPECT_GPT_SHADOW_UNTIL", "2026-09-12T12:00:00.001Z");
    expect(isProspectGptShadowEnabled()).toBe(true);
    vi.stubEnv("AXIS_PROSPECT_GPT_SHADOW_UNTIL", "2026-09-12T12:00:00.000Z");
    expect(isProspectGptShadowEnabled()).toBe(false);
    vi.stubEnv("AXIS_PROSPECT_GPT_SHADOW_UNTIL", "not-a-deadline");
    expect(isProspectGptShadowEnabled()).toBe(false);
    vi.stubEnv("AXIS_PROSPECT_GPT_SHADOW_UNTIL", "2026-02-30T12:00:00Z");
    expect(isProspectGptShadowEnabled()).toBe(false);
    vi.stubEnv("AXIS_PROSPECT_GPT_SHADOW_UNTIL", "2026-09-13T12:00:00-04:00");
    expect(isProspectGptShadowEnabled()).toBe(false);
    vi.stubEnv("AXIS_PROSPECT_GPT_SHADOW_UNTIL", "2026-09-13T12:00:00.000Z");
    vi.stubEnv("AXIS_PROSPECT_GPT_SHADOW_ENABLED", "false");
    expect(isProspectGptShadowEnabled()).toBe(false);
    vi.useRealTimers();
  });

  it("keeps the existing enabled behavior when the deadline is unset", () => {
    vi.stubEnv("AXIS_PROSPECT_GPT_SHADOW_ENABLED", "true");
    vi.stubEnv("AXIS_PROSPECT_GPT_SHADOW_UNTIL", "");
    expect(isProspectGptShadowEnabled()).toBe(true);
  });

  it("does not call the provider after the shadow deadline expires", async () => {
    vi.stubEnv("AXIS_PROSPECT_GPT_SHADOW_ENABLED", "true");
    vi.stubEnv("AXIS_PROSPECT_GPT_SHADOW_UNTIL", "2026-09-12T11:59:59.999Z");
    vi.stubEnv("OPENAI_API_KEY", "test-key");
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-12T12:00:00.000Z"));
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(runProspectGptShadow({ conversation: [{ role: "user", content: "hello" }] }))
      .resolves.toMatchObject({ status: "disabled", reason: "shadow_not_enabled" });
    await expect(scheduleProspectGptShadow({ conversation: [{ role: "user", content: "hello" }] }))
      .resolves.toMatchObject({ status: "disabled", reason: "shadow_not_enabled" });
    expect(fetchMock).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("replays matching validated arguments, preserves item/call ids, and sums replay usage", async () => {
    vi.stubEnv("AXIS_PROSPECT_GPT_SHADOW_ENABLED", "true");
    vi.stubEnv("OPENAI_API_KEY", "test-key");
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: "resp_1", output: [{ type: "function_call", id: "fc_item_1", call_id: "call_1", name: "list_listings", arguments: '{"query":"Jain Home"}' }], usage: { input_tokens: 10, output_tokens: 2 } }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: "resp_2", output: [{ type: "message", content: [{ type: "output_text", text: "Jain Home is available." }] }], usage: { input_tokens: 8, output_tokens: 3 } }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const result = await runProspectGptShadow({
      conversation: [{ role: "user", content: "Is Jain Home available?" }], tools: listingTool,
      toolEvidence: [{ callId: "different_provider_id", name: "list_listings", arguments: { query: "Jain Home" }, output: { listingId: "canonical-1" } }],
    });
    expect(result).toMatchObject({ status: "completed", reply: "Jain Home is available.", usage: { inputTokens: 18, outputTokens: 5 } });
    const replay = JSON.parse(String(fetchMock.mock.calls[1]![1].body));
    expect(replay.input).toContainEqual(expect.objectContaining({ type: "function_call_output", call_id: "call_1" }));
    expect(replay.input).toContainEqual(expect.objectContaining({ type: "function_call", call_id: "call_1" }));
    expect(replay.input).toContainEqual(expect.objectContaining({ id: "fc_item_1", call_id: "call_1" }));
  });

  it("returns unknown when the GPT call targets another property", async () => {
    vi.stubEnv("AXIS_PROSPECT_GPT_SHADOW_ENABLED", "true"); vi.stubEnv("OPENAI_API_KEY", "test-key");
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ id: "resp", output: [{ type: "function_call", call_id: "call", name: "list_listings", arguments: '{"query":"Other Home"}' }] }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const result = await runProspectGptShadow({ conversation: [{ role: "user", content: "check" }], tools: listingTool, toolEvidence: [{ name: "list_listings", arguments: { query: "Jain Home" }, output: { listingId: "canonical-1" } }] });
    expect(result).toMatchObject({ status: "unknown", reason: "missing_tool_evidence" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("uses the explicit pre-turn snapshot so prior delivered history remains while incumbent text is absent", async () => {
    vi.stubEnv("AXIS_PROSPECT_GPT_SHADOW_ENABLED", "true"); vi.stubEnv("OPENAI_API_KEY", "test-key");
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ id: "resp", output: [{ type: "message", content: [{ type: "output_text", text: "ok" }] }] }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await runProspectGptShadow({ conversation: [{ role: "user", content: "new" }, { role: "assistant", content: "INCUMBENT ANSWER" }], preTurnConversation: [{ role: "user", content: "old" }, { role: "assistant", content: "DELIVERED HISTORY" }] });
    const request = JSON.stringify(JSON.parse(String(fetchMock.mock.calls[0]![1].body)).input);
    expect(request).toContain("DELIVERED HISTORY"); expect(request).not.toContain("INCUMBENT ANSWER");
  });

  it("keeps incumbent output/evidence in comparison metadata and outside GPT input", async () => {
    vi.stubEnv("AXIS_PROSPECT_GPT_SHADOW_ENABLED", "true"); vi.stubEnv("OPENAI_API_KEY", "test-key");
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ id: "paired", output: [{ type: "message", content: [{ type: "output_text", text: "Jain Home is available." }] }] }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const result = await runProspectGptShadow({
      burstId: "burst-1", burstRevision: 4, release: "leasing-v2", primaryOutput: "INCUMBENT ANSWER",
      primaryEvidence: { supportedFacts: ["Jain Home"] }, conversation: [{ role: "user", content: "check Jain Home" }],
    });
    expect(result).toMatchObject({ status: "completed", comparison: { identity: { burstId: "burst-1", burstRevision: 4, release: "leasing-v2" }, grounding: "unknown" } });
    expect(JSON.stringify(JSON.parse(String(fetchMock.mock.calls[0]![1].body)).input)).not.toContain("INCUMBENT ANSWER");
  });

  it("does not complete or ground incomplete and refusal responses", async () => {
    vi.stubEnv("AXIS_PROSPECT_GPT_SHADOW_ENABLED", "true"); vi.stubEnv("OPENAI_API_KEY", "test-key");
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: "inc", status: "incomplete", output: [] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: "ref", output: [{ type: "message", content: [{ type: "refusal", text: "no" }] }] }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const first = await runProspectGptShadow({ conversation: [{ role: "user", content: "x" }] });
    const second = await runProspectGptShadow({ conversation: [{ role: "user", content: "x" }] });
    expect(first).toMatchObject({ status: "unknown" }); expect(second).toMatchObject({ status: "unknown" });
  });

  it("treats an empty text response as unknown and never reports schema-only replay", async () => {
    vi.stubEnv("AXIS_PROSPECT_GPT_SHADOW_ENABLED", "true"); vi.stubEnv("OPENAI_API_KEY", "test-key");
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ id: "empty", output: [{ type: "message", content: [] }] }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const result = await runProspectGptShadow({ conversation: [{ role: "user", content: "x" }], tools: listingTool });
    expect(result).toMatchObject({ status: "unknown", reason: "shadow_empty_output" });
  });

  it("rejects capacity overflow without queueing API work", async () => {
    vi.stubEnv("AXIS_PROSPECT_GPT_SHADOW_ENABLED", "true"); vi.stubEnv("OPENAI_API_KEY", "test-key"); vi.stubEnv("AXIS_PROSPECT_GPT_SHADOW_MAX_CONCURRENCY", "1");
    let release!: (response: Response) => void;
    const fetchMock = vi.fn().mockReturnValue(new Promise<Response>((resolve) => { release = resolve; })); vi.stubGlobal("fetch", fetchMock);
    const first = runProspectGptShadow({ conversation: [{ role: "user", content: "first" }] });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const second = await runProspectGptShadow({ conversation: [{ role: "user", content: "second" }] });
    expect(second).toMatchObject({ status: "unknown", reason: "shadow_concurrency_limit" });
    release(new Response(JSON.stringify({ id: "r", output: [{ type: "message", content: [{ type: "output_text", text: "ok" }] }] }), { status: 200 }));
    await first;
  });

  it("keeps missing fixture evidence unknown without calling OpenAI", async () => {
    vi.stubEnv("AXIS_PROSPECT_GPT_SHADOW_ENABLED", "true");
    vi.stubEnv("OPENAI_API_KEY", "test-key");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const result = await runProspectGptShadow({
      conversation: [{ role: "assistant", content: [{ type: "tool_use", id: "call_1", name: "list_listings", input: {} }] } as Anthropic.MessageParam],
      burstId: "b1",
    });
    expect(result).toMatchObject({ status: "unknown", reason: "missing_tool_evidence" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("is fire-and-forget for the primary path and sends no tools", async () => {
    vi.stubEnv("AXIS_PROSPECT_GPT_SHADOW_ENABLED", "true");
    vi.stubEnv("OPENAI_API_KEY", "test-key");
    let resolveFetch!: (response: Response) => void;
    const fetchMock = vi.fn().mockReturnValue(new Promise<Response>((resolve) => { resolveFetch = resolve; }));
    vi.stubGlobal("fetch", fetchMock);
    const started = performance.now();
    scheduleProspectGptShadow({ conversation: [{ role: "user", content: "hello" }] });
    expect(performance.now() - started).toBeLessThan(50);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(JSON.parse(String(fetchMock.mock.calls[0]![1].body)).tools).toEqual([]);
    resolveFetch(new Response(JSON.stringify({ id: "r", output: [{ type: "message", content: [{ type: "output_text", text: "hi" }] }] }), { status: 200 }));
  });
});
