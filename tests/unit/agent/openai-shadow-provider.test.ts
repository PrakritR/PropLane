import { afterEach, describe, expect, it, vi } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import { completeOpenAIResponses } from "@/lib/agent/provider";
import { runProspectGptShadow, scheduleProspectGptShadow } from "@/lib/agent/prospect-gpt-shadow";

const base = { model: "gpt-5.4-mini", system: "reply", tools: [], messages: [{ role: "user", content: "hello" }] as Anthropic.MessageParam[] };

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("OpenAI Responses provider", () => {
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
