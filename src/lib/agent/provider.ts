/**
 * Provider-neutral completion boundary for the tool-calling loop. Anthropic
 * remains the authoritative implementation; OpenRouter is deliberately used
 * only for the narrow, read-only fast lane selected in model.ts.
 */
import Anthropic from "@anthropic-ai/sdk";
import type { AnthropicToolSchema } from "@/lib/tools/registry";
import { isAssistantBillingFailure } from "@/lib/agent/assistant-turn-error";
import type { AgentModelSelection } from "./model";

export type ProviderCompletion = {
  content: Anthropic.ContentBlock[];
  stopReason: string | null;
  usage: { inputTokens: number; outputTokens: number };
  provider: "anthropic" | "openrouter" | "openai";
  fallbackReason?: string;
  latencyMs: number;
  continuationState?: OpenAIResponsesContinuation;
};

export type OpenAIResponsesOutputItem = Record<string, unknown>;
export type OpenAIResponsesContinuation = {
  provider: "openai";
  responseId: string;
  /** Complete stateless input submitted for the prior response. */
  inputItems: OpenAIResponsesOutputItem[];
  /** Opaque output items, including reasoning.encrypted_content, for store:false replay. */
  outputItems: OpenAIResponsesOutputItem[];
  /** Number of provider-neutral messages already represented in inputItems. */
  consumedMessageCount: number;
};

function textFromContent(content: Anthropic.MessageParam["content"]): string {
  if (typeof content === "string") return content;
  return content
    .filter((block): block is Anthropic.TextBlock => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}

/** Convert the loop's Anthropic-native history into OpenAI-compatible messages. */
function openRouterMessages(messages: Anthropic.MessageParam[]) {
  const out: Record<string, unknown>[] = [];
  for (const message of messages) {
    if (message.role === "assistant" && Array.isArray(message.content)) {
      const text = message.content
        .filter((block): block is Anthropic.TextBlock => block.type === "text")
        .map((block) => block.text)
        .join("");
      const toolCalls = message.content
        .filter((block): block is Anthropic.ToolUseBlock => block.type === "tool_use")
        .map((block) => ({
          id: block.id,
          type: "function",
          function: { name: block.name, arguments: JSON.stringify(block.input ?? {}) },
        }));
      out.push({ role: "assistant", content: text || null, ...(toolCalls.length ? { tool_calls: toolCalls } : {}) });
      continue;
    }
    if (message.role === "user" && Array.isArray(message.content)) {
      const results = message.content.filter(
        (block): block is Anthropic.ToolResultBlockParam => block.type === "tool_result",
      );
      if (results.length) {
        for (const result of results) {
          out.push({ role: "tool", tool_call_id: result.tool_use_id, content: String(result.content ?? "") });
        }
        continue;
      }
    }
    out.push({ role: message.role, content: textFromContent(message.content) });
  }
  return out;
}

async function completeAnthropic(args: {
  model: string;
  system: string;
  tools: AnthropicToolSchema[];
  messages: Anthropic.MessageParam[];
}): Promise<ProviderCompletion> {
  const started = performance.now();
  const client = new Anthropic();
  const response = await client.messages.create({
    model: args.model,
    max_tokens: 4096,
    system: args.system,
    tools: args.tools as unknown as Anthropic.Tool[],
    messages: args.messages,
  });
  return {
    content: response.content,
    stopReason: response.stop_reason ?? null,
    usage: {
      inputTokens: response.usage?.input_tokens ?? 0,
      outputTokens: response.usage?.output_tokens ?? 0,
    },
    provider: "anthropic",
    latencyMs: Math.round(performance.now() - started),
  };
}

function parseToolArguments(raw: unknown): unknown {
  if (typeof raw !== "string") return raw ?? {};
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return {};
  }
}

async function completeOpenRouter(args: {
  model: string;
  system: string;
  tools: AnthropicToolSchema[];
  messages: Anthropic.MessageParam[];
}): Promise<ProviderCompletion> {
  const key = process.env.OPENROUTER_API_KEY?.trim();
  if (!key) throw new Error("OpenRouter is not configured.");
  const timeoutMs = Number(process.env.AXIS_AGENT_FAST_TIMEOUT_MS || 2500);
  const started = performance.now();
  const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    signal: AbortSignal.timeout(Number.isFinite(timeoutMs) ? Math.max(250, timeoutMs) : 2500),
    body: JSON.stringify({
      model: args.model,
      messages: [{ role: "system", content: args.system }, ...openRouterMessages(args.messages)],
      tools: args.tools.map((tool) => ({
        type: "function",
        function: { name: tool.name, description: tool.description, parameters: tool.input_schema },
      })),
      tool_choice: "auto",
      parallel_tool_calls: true,
      max_tokens: 4096,
      provider: { data_collection: "deny", require_parameters: true },
    }),
  });
  const body = (await response.json()) as {
    error?: { message?: string };
    choices?: { finish_reason?: string | null; message?: { content?: string | null; tool_calls?: { id?: string; function?: { name?: string; arguments?: unknown } }[] } }[];
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };
  if (!response.ok) throw new Error(body.error?.message || `OpenRouter request failed (${response.status}).`);
  const choice = body.choices?.[0];
  if (!choice?.message) throw new Error("OpenRouter returned no completion.");
  const content: Anthropic.ContentBlock[] = [];
  if (choice.message.content) content.push({ type: "text", text: choice.message.content } as Anthropic.TextBlock);
  for (const call of choice.message.tool_calls ?? []) {
    const name = call.function?.name;
    if (!name) continue;
    content.push({
      type: "tool_use",
      id: call.id || `or_${crypto.randomUUID()}`,
      name,
      input: parseToolArguments(call.function?.arguments),
    } as Anthropic.ToolUseBlock);
  }
  return {
    content,
    stopReason: choice.finish_reason === "tool_calls" ? "tool_use" : "end_turn",
    usage: { inputTokens: body.usage?.prompt_tokens ?? 0, outputTokens: body.usage?.completion_tokens ?? 0 },
    provider: "openrouter",
    latencyMs: Math.round(performance.now() - started),
  };
}

function openRouterBillingRescueModel(): string {
  return process.env.AXIS_AGENT_FAST_MODEL?.trim() || "google/gemini-3.5-flash-lite";
}

/**
 * When Anthropic refuses the account (spent credits / billing), one OpenRouter
 * attempt keeps SMS and chat alive. If OpenRouter is missing or also fails,
 * rethrow the original Anthropic error so the surface can tell the user.
 */
async function completeAnthropicWithBillingFallback(args: {
  selection: AgentModelSelection;
  system: string;
  tools: AnthropicToolSchema[];
  messages: Anthropic.MessageParam[];
  model: string;
}): Promise<ProviderCompletion> {
  try {
    return await completeAnthropic({ ...args, model: args.model });
  } catch (error) {
    if (!isAssistantBillingFailure(error) || !process.env.OPENROUTER_API_KEY?.trim()) {
      throw error;
    }
    try {
      const fallback = await completeOpenRouter({
        ...args,
        model: openRouterBillingRescueModel(),
      });
      return {
        ...fallback,
        fallbackReason:
          error instanceof Error ? error.message.slice(0, 240) : "Anthropic billing failed",
      };
    } catch {
      throw error;
    }
  }
}

type OpenAIResponseBody = {
  id?: string;
  status?: string;
  output?: Array<{
    type?: string;
    id?: string;
    call_id?: string;
    name?: string;
    arguments?: unknown;
    content?: Array<{ type?: string; text?: string }>;
  }>;
  usage?: { input_tokens?: number; output_tokens?: number };
  error?: { message?: string };
};

function openAIInput(messages: Anthropic.MessageParam[]): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const message of messages) {
    if (message.role === "assistant" && Array.isArray(message.content)) {
      const text = message.content.filter((b): b is Anthropic.TextBlock => b.type === "text").map((b) => b.text).join("");
      if (text) out.push({ role: "assistant", content: text });
      for (const call of message.content.filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use")) {
        // Responses has distinct opaque item `id` and tool correlation `call_id`.
        // The Anthropic tool-use id is only the latter; never invent an item id.
        out.push({ type: "function_call", call_id: call.id, name: call.name, arguments: JSON.stringify(call.input ?? {}) });
      }
      continue;
    }
    if (message.role === "user" && Array.isArray(message.content)) {
      const results = message.content.filter((b): b is Anthropic.ToolResultBlockParam => b.type === "tool_result");
      if (results.length) {
        for (const result of results) out.push({ type: "function_call_output", call_id: result.tool_use_id, output: typeof result.content === "string" ? result.content : JSON.stringify(result.content ?? "") });
        continue;
      }
    }
    out.push({ role: message.role, content: typeof message.content === "string" ? message.content : textFromContent(message.content) });
  }
  return out;
}

function parseOpenAIArguments(raw: unknown): unknown {
  if (typeof raw !== "string") throw new Error("OpenAI returned malformed function arguments.");
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("OpenAI returned malformed function arguments.");
    }
    return parsed;
  } catch {
    throw new Error("OpenAI returned malformed function arguments.");
  }
}

/** Direct OpenAI Responses API adapter. It is intentionally fetch-based so tests never need an SDK or a paid call. */
export async function completeOpenAIResponses(args: {
  model: string;
  system: string;
  tools: AnthropicToolSchema[];
  messages: Anthropic.MessageParam[];
  continuationState?: OpenAIResponsesContinuation;
  maxOutputTokens?: number;
  timeoutMs?: number;
}): Promise<ProviderCompletion> {
  const key = process.env.OPENAI_API_KEY?.trim();
  if (!key) throw new Error("OpenAI is not configured.");
  const timeout = Number.isFinite(args.timeoutMs) ? Math.max(250, args.timeoutMs ?? 0) : 10_000;
  const started = performance.now();
  const newMessages = args.continuationState
    ? args.messages.slice(args.continuationState.consumedMessageCount)
    : args.messages;
  const inputItems = args.continuationState
    ? [
        ...args.continuationState.inputItems,
        ...args.continuationState.outputItems,
        ...openAIInput(newMessages),
      ]
    : openAIInput(newMessages);
  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    signal: AbortSignal.timeout(timeout),
    body: JSON.stringify({
      model: args.model,
      instructions: args.system,
      input: inputItems,
      tools: args.tools.map((tool) => ({ type: "function", name: tool.name, description: tool.description, parameters: tool.input_schema, strict: false })),
      store: false,
      include: ["reasoning.encrypted_content"],
      max_output_tokens: args.maxOutputTokens ?? 4096,
    }),
  });
  const body = (await response.json()) as OpenAIResponseBody;
  if (!response.ok) throw new Error(body.error?.message || `OpenAI request failed (${response.status}).`);
  if (!body.id || !Array.isArray(body.output)) throw new Error("OpenAI returned an invalid response.");
  if (body.status === "incomplete") throw new Error("OpenAI returned an incomplete response.");
  const content: Anthropic.ContentBlock[] = [];
  for (const item of body.output) {
    if (item.type === "message") {
      for (const part of item.content ?? []) if (part.type === "output_text" && part.text) content.push({ type: "text", text: part.text } as Anthropic.TextBlock);
      if ((item.content ?? []).some((part) => part.type === "refusal")) throw new Error("OpenAI refused the shadow response.");
    } else if (item.type === "function_call" && item.name) {
      if (!item.call_id) throw new Error("OpenAI returned a function call without call_id.");
      content.push({ type: "tool_use", id: item.call_id, name: item.name, input: parseOpenAIArguments(item.arguments) } as Anthropic.ToolUseBlock);
    }
  }
  const hasCalls = content.some((item) => item.type === "tool_use");
  return {
    content,
    stopReason: hasCalls ? "tool_use" : "end_turn",
    usage: { inputTokens: body.usage?.input_tokens ?? 0, outputTokens: body.usage?.output_tokens ?? 0 },
    provider: "openai",
    latencyMs: Math.round(performance.now() - started),
    continuationState: {
      provider: "openai",
      responseId: body.id,
      inputItems,
      outputItems: body.output as OpenAIResponsesOutputItem[],
      // runAgentTurn appends this response as one assistant message before the
      // next provider call. The opaque outputItems already represent it.
      consumedMessageCount: args.messages.length + 1,
    },
  };
}

/**
 * OpenRouter failures never surface to the user for an eligible turn: retry the
 * same read-only/no-tool history through Anthropic once. Nothing has mutated at
 * this point, so the retry cannot duplicate a side effect. If that Anthropic
 * retry is a billing refusal, try a different OpenRouter model before giving up.
 */
export async function completeAgentModel(args: {
  selection: AgentModelSelection;
  system: string;
  tools: AnthropicToolSchema[];
  messages: Anthropic.MessageParam[];
  continuationState?: OpenAIResponsesContinuation;
}): Promise<ProviderCompletion> {
  if (args.selection.provider === "openai") {
    return completeOpenAIResponses({ ...args, model: args.selection.model });
  }
  if (args.selection.provider !== "openrouter") {
    return completeAnthropicWithBillingFallback({ ...args, model: args.selection.model });
  }
  try {
    return await completeOpenRouter({ ...args, model: args.selection.model });
  } catch (error) {
    const fallback = await completeAnthropicWithBillingFallback({
      ...args,
      model: args.selection.fallbackModel || "claude-sonnet-4-6",
    });
    return {
      ...fallback,
      fallbackReason: error instanceof Error ? error.message.slice(0, 240) : "OpenRouter failed",
    };
  }
}
