import { afterEach, describe, expect, it, vi } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import { completeOpenAIResponses } from "@/lib/agent/provider";

const base = {
  model: "gpt-6-luna",
  system: "reply",
  tools: [],
  messages: [{ role: "user", content: "hello" }] as Anthropic.MessageParam[],
  timeoutMs: 1_000,
};

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("provider transient 429 retry", () => {
  it("retries the same failed model request once after Retry-After", async () => {
    vi.stubEnv("OPENAI_API_KEY", "test-key");
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: { message: "Rate limit reached" } }), { status: 429, headers: { "Retry-After": "0" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: "resp_ok", status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: "Done." }] }], usage: { input_tokens: 2, output_tokens: 1 } }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await completeOpenAIResponses(base);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1]![0]).toBe(fetchMock.mock.calls[0]![0]);
    expect(fetchMock.mock.calls[1]![1].body).toBe(fetchMock.mock.calls[0]![1].body);
    expect(result.content).toMatchObject([{ type: "text", text: "Done." }]);
  });

  it("does not retry insufficient quota", async () => {
    vi.stubEnv("OPENAI_API_KEY", "test-key");
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: { code: "insufficient_quota", message: "You exceeded your current quota" } }), { status: 429 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(completeOpenAIResponses(base)).rejects.toThrow(/request failed \(429\)/);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("does not wait or retry when Retry-After exceeds the remaining deadline", async () => {
    vi.stubEnv("OPENAI_API_KEY", "test-key");
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: { message: "Rate limit reached" } }), { status: 429, headers: { "Retry-After": "30" } }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(completeOpenAIResponses({ ...base, timeoutMs: 250 })).rejects.toThrow(/request failed \(429\)/);
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});
