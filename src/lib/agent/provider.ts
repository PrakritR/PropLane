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
  usage: { inputTokens: number; outputTokens: number; cachedInputTokens?: number; cacheCreationInputTokens?: number; reasoningOutputTokens?: number; raw?: unknown };
  provider: "anthropic" | "openrouter" | "openai";
  fallbackReason?: string;
  latencyMs: number;
  continuationState?: OpenAIResponsesContinuation;
  responseModel?: string;
  responseId?: string;
  rawOutput?: unknown;
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
export type ProviderToolChoice = { type: "tool"; name: string };

function textFromContent(content: Anthropic.MessageParam["content"]): string {
  if (typeof content === "string") return content;
  return content
    .filter((block): block is Anthropic.TextBlock => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}

const DEFAULT_PROVIDER_TIMEOUT_MS = 10_000;
const MAX_PROVIDER_429_RETRIES = 1;

function retryAfterMs(value: string | null): number | null {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : null;
}

function isInsufficientQuota(response: Response): Promise<boolean> {
  return response.clone().json().then((body: unknown) => {
    const message = body && typeof body === "object" && "error" in body
      ? (body as { error?: { code?: unknown; type?: unknown; message?: unknown } }).error
      : undefined;
    const details = [message?.code, message?.type, message?.message].filter((part): part is string => typeof part === "string").join(" ");
    return /insufficient[_\s-]?quota|quota.{0,30}(exceeded|insufficient)|billing.{0,30}limit/i.test(details);
  }).catch(() => false);
}

/** Retry one transient 429 inside the original model-request deadline. */
async function fetchWithTransient429Retry(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const timeout = Number.isFinite(timeoutMs) ? Math.max(250, timeoutMs) : DEFAULT_PROVIDER_TIMEOUT_MS;
  const deadline = performance.now() + timeout;
  for (let attempt = 0; ; attempt += 1) {
    const remaining = deadline - performance.now();
    if (remaining <= 0) throw new DOMException("The operation timed out", "TimeoutError");
    const deadlineSignal = AbortSignal.timeout(Math.max(1, Math.ceil(remaining)));
    const signal = init.signal ? AbortSignal.any([init.signal, deadlineSignal]) : deadlineSignal;
    const response = await fetch(url, { ...init, signal });
    if (response.status !== 429 || attempt >= MAX_PROVIDER_429_RETRIES || await isInsufficientQuota(response)) return response;
    const delayMs = retryAfterMs(response.headers.get("retry-after")) ?? 250;
    if (delayMs >= deadline - performance.now()) return response;
    if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
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
  maxOutputTokens?: number;
  timeoutMs?: number;
  toolChoice?: ProviderToolChoice;
}): Promise<ProviderCompletion> {
  const started = performance.now();
  const client = new Anthropic(args.timeoutMs ? { timeout: args.timeoutMs } : undefined);
  const response = await client.messages.create({
    model: args.model,
    max_tokens: args.maxOutputTokens ?? 4096,
    system: args.system,
    tools: args.tools as unknown as Anthropic.Tool[],
    ...(args.toolChoice ? { tool_choice: { type: "tool" as const, name: args.toolChoice.name } } : {}),
    messages: args.messages,
  });
  return {
    content: response.content,
    stopReason: response.stop_reason ?? null,
    usage: {
      inputTokens: response.usage?.input_tokens ?? 0,
      outputTokens: response.usage?.output_tokens ?? 0,
      cachedInputTokens: response.usage?.cache_read_input_tokens ?? 0,
      cacheCreationInputTokens: response.usage?.cache_creation_input_tokens ?? 0,
      raw: response.usage,
    },
    provider: "anthropic",
    responseModel: response.model,
    responseId: response.id,
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
  toolChoice?: ProviderToolChoice;
}): Promise<ProviderCompletion> {
  const key = process.env.OPENROUTER_API_KEY?.trim();
  if (!key) throw new Error("OpenRouter is not configured.");
  const timeoutMs = Number(process.env.AXIS_AGENT_FAST_TIMEOUT_MS || 2500);
  const started = performance.now();
  const response = await fetchWithTransient429Retry("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: args.model,
      messages: [{ role: "system", content: args.system }, ...openRouterMessages(args.messages)],
      tools: args.tools.map((tool) => ({
        type: "function",
        function: { name: tool.name, description: tool.description, parameters: tool.input_schema },
      })),
      tool_choice: args.toolChoice ? { type: "function", function: { name: args.toolChoice.name } } : "auto",
      parallel_tool_calls: true,
      max_tokens: 4096,
      provider: { data_collection: "deny", require_parameters: true },
    }),
  }, Number.isFinite(timeoutMs) ? Math.max(250, timeoutMs) : 2500);
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
  toolChoice?: ProviderToolChoice;
}): Promise<ProviderCompletion> {
  try {
    return await completeAnthropic({ ...args, model: args.model, maxOutputTokens: args.selection.maxOutputTokens, timeoutMs: args.selection.timeoutMs });
  } catch (error) {
    if (args.selection.disableBillingFallback || !isAssistantBillingFailure(error) || !process.env.OPENROUTER_API_KEY?.trim()) {
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
  model?: string;
  status?: string;
  incomplete_details?: { reason?: string };
  output?: Array<{
    type?: string;
    id?: string;
    call_id?: string;
    name?: string;
    arguments?: unknown;
    content?: Array<{ type?: string; text?: string }>;
  }>;
  usage?: { input_tokens?: number; output_tokens?: number; input_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number }; output_tokens_details?: { reasoning_tokens?: number } };
  error?: { message?: string };
};

function validOpenAIUsage(body: OpenAIResponseBody): ProviderCompletion["usage"] | undefined {
  const input = body.usage?.input_tokens;
  const output = body.usage?.output_tokens;
  if (!Number.isFinite(input) || !Number.isFinite(output) || input! < 0 || output! < 0) return undefined;
  return {
    inputTokens: input!, outputTokens: output!,
    cachedInputTokens: body.usage?.input_tokens_details?.cached_tokens ?? 0,
    cacheCreationInputTokens: body.usage?.input_tokens_details?.cache_write_tokens ?? 0,
    reasoningOutputTokens: body.usage?.output_tokens_details?.reasoning_tokens ?? 0,
    raw: body.usage,
  };
}

export class OpenAIProviderResponseError extends Error {
  readonly responseModel?: string;
  readonly responseUsage?: ProviderCompletion["usage"];
  constructor(body: OpenAIResponseBody, message: string) {
    super(message);
    this.name = "OpenAIProviderResponseError";
    this.responseModel = body.model;
    this.responseUsage = validOpenAIUsage(body);
  }
}

export class OpenAIIncompleteResponseError extends Error {
  readonly responseModel?: string;
  readonly responseUsage?: ProviderCompletion["usage"];
  readonly incompleteReason?: string;

  constructor(body: OpenAIResponseBody) {
    super(`OpenAI returned an incomplete response${body.incomplete_details?.reason ? ` (${body.incomplete_details.reason})` : ""}.`);
    this.name = "OpenAIIncompleteResponseError";
    this.responseModel = body.model;
    this.incompleteReason = body.incomplete_details?.reason;
    this.responseUsage = validOpenAIUsage(body);
  }
}

export class OpenAIUnusableResponseError extends Error {
  readonly responseModel?: string;
  readonly responseUsage?: ProviderCompletion["usage"];
  readonly failureReason: string;

  constructor(body: OpenAIResponseBody, failureReason: string) {
    super(`OpenAI returned a completed response without a usable answer (${failureReason}).`);
    this.name = "OpenAIUnusableResponseError";
    this.responseModel = body.model;
    this.failureReason = failureReason;
    this.responseUsage = validOpenAIUsage(body);
  }
}

function openAIContent(blocks: Anthropic.MessageParam["content"]): Record<string, unknown>[] {
  if (typeof blocks === "string") return [{ type: "input_text", text: blocks }];
  const content: Record<string, unknown>[] = [];
  for (const block of blocks) {
    if (block.type === "text") {
      content.push({ type: "input_text", text: block.text });
    } else if (block.type === "image") {
      const source = block.source;
      if (source.type !== "base64" || !["image/png", "image/jpeg", "image/gif", "image/webp"].includes(source.media_type) || !/^[A-Za-z0-9+/]+={0,2}$/.test(source.data)) {
        throw new Error("OpenAI received an unsupported image block.");
      }
      content.push({ type: "input_image", image_url: `data:${source.media_type};base64,${source.data}`, detail: "auto" });
    } else if (block.type === "document") {
      const source = block.source;
      if (source.type !== "base64" || source.media_type !== "application/pdf" || !/^[A-Za-z0-9+/]+={0,2}$/.test(source.data)) {
        throw new Error("OpenAI received an unsupported document block.");
      }
      content.push({ type: "input_file", filename: "document.pdf", file_data: `data:application/pdf;base64,${source.data}` });
    } else {
      throw new Error(`OpenAI received an unsupported content block (${block.type}).`);
    }
  }
  return content;
}

function openAIInput(messages: Anthropic.MessageParam[]): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const message of messages) {
    if (message.role === "assistant") {
      const blocks = typeof message.content === "string"
        ? [{ type: "text" as const, text: message.content }]
        : message.content;
      const unsupported = blocks.find((block) => block.type !== "text" && block.type !== "tool_use");
      if (unsupported) throw new Error(`OpenAI received an unsupported assistant content block (${unsupported.type}).`);
      const text = blocks.filter((b): b is Anthropic.TextBlock => b.type === "text").map((b) => b.text).join("");
      // Replayed assistant text is output content, including string chat history.
      if (text) out.push({ role: "assistant", content: [{ type: "output_text", text, annotations: [] }] });
      for (const call of blocks.filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use")) {
        // Responses has distinct opaque item `id` and tool correlation `call_id`.
        // The Anthropic tool-use id is only the latter; never invent an item id.
        out.push({ type: "function_call", call_id: call.id, name: call.name, arguments: JSON.stringify(call.input ?? {}) });
      }
      continue;
    }
    if (message.role === "user" && Array.isArray(message.content) && message.content.some((b) => b.type === "tool_result")) {
      for (const block of message.content) {
        if (block.type === "tool_result") {
          if (typeof block.content === "string" || block.content === undefined) {
            out.push({ type: "function_call_output", call_id: block.tool_use_id, output: block.content ?? "" });
          } else {
            out.push({ type: "function_call_output", call_id: block.tool_use_id, output: openAIContent(block.content) });
          }
        } else {
          out.push({ role: "user", content: openAIContent([block]) });
        }
      }
      continue;
    }
    out.push({ role: message.role, content: openAIContent(message.content) });
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
  reasoningEffort?: "low" | "medium" | "high";
  requireUsage?: boolean;
  toolChoice?: ProviderToolChoice;
}): Promise<ProviderCompletion> {
  const key = process.env.OPENAI_API_KEY?.trim();
  if (!key) throw new Error("OpenAI is not configured.");
  if (args.toolChoice && !args.tools.some((tool) => tool.name === args.toolChoice!.name)) {
    throw new Error(`The selected tool ${args.toolChoice.name} is unavailable.`);
  }
  const timeout = Number.isFinite(args.timeoutMs) ? Math.max(250, args.timeoutMs ?? 0) : DEFAULT_PROVIDER_TIMEOUT_MS;
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
    : [
        { role: "developer", content: [{ type: "input_text", text: args.system,
          ...(/^gpt-6-luna(?:-\d{4}-\d{2}-\d{2})?$/.test(args.model) ? { prompt_cache_breakpoint: { mode: "explicit" } } : {}),
        }] },
        ...openAIInput(newMessages),
      ];
  const response = await fetchWithTransient429Retry("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: args.model,
      input: inputItems,
      tools: args.tools.map((tool) => ({ type: "function", name: tool.name, description: tool.description, parameters: tool.input_schema, strict: false })),
      ...(args.toolChoice ? { tool_choice: { type: "function", name: args.toolChoice.name } } : {}),
      store: false,
      include: ["reasoning.encrypted_content"],
      max_output_tokens: args.maxOutputTokens ?? 4096,
      ...(/^gpt-6-luna(?:-\d{4}-\d{2}-\d{2})?$/.test(args.model) ? { prompt_cache_options: { mode: "implicit", ttl: "30m" } } : {}),
      ...(args.reasoningEffort ? { reasoning: { effort: args.reasoningEffort } } : {}),
    }),
  }, timeout);
  const body = (await response.json()) as OpenAIResponseBody;
  if (!response.ok) throw new OpenAIProviderResponseError(body, `OpenAI request failed (${response.status}): ${body.error?.message || response.statusText}`);
  if (!body.id || !Array.isArray(body.output)) throw new OpenAIProviderResponseError(body, "OpenAI returned an invalid response.");
  if (body.status === "incomplete") throw new OpenAIIncompleteResponseError(body);
  if (body.status && body.status !== "completed") throw new OpenAIProviderResponseError(body, `OpenAI returned a ${body.status} response.`);
  if (args.requireUsage && !validOpenAIUsage(body)) {
    throw new OpenAIProviderResponseError(body, "OpenAI returned a response without token usage.");
  }
  const content: Anthropic.ContentBlock[] = [];
  for (const item of body.output) {
    if (item.type === "message") {
      for (const part of item.content ?? []) if (part.type === "output_text" && part.text?.trim()) content.push({ type: "text", text: part.text } as Anthropic.TextBlock);
      if ((item.content ?? []).some((part) => part.type === "refusal")) throw new OpenAIUnusableResponseError(body, "refusal");
    } else if (item.type === "function_call" && item.name) {
      if (!item.call_id) throw new OpenAIProviderResponseError(body, "OpenAI returned a function call without call_id.");
      try {
        content.push({ type: "tool_use", id: item.call_id, name: item.name, input: parseOpenAIArguments(item.arguments) } as Anthropic.ToolUseBlock);
      } catch {
        throw new OpenAIProviderResponseError(body, "OpenAI returned malformed function arguments.");
      }
    }
  }
  if (content.length === 0) throw new OpenAIUnusableResponseError(body, "empty_output");
  const hasCalls = content.some((item) => item.type === "tool_use");
  return {
    content,
    stopReason: hasCalls ? "tool_use" : "end_turn",
    usage: validOpenAIUsage(body) ?? { inputTokens: 0, outputTokens: 0, raw: body.usage },
    provider: "openai",
    responseModel: body.model,
    responseId: body.id,
    rawOutput: body.output,
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
  toolChoice?: ProviderToolChoice;
}): Promise<ProviderCompletion> {
  if (args.selection.provider === "openai") {
    return completeOpenAIResponses({ ...args, model: args.selection.model, maxOutputTokens: args.selection.maxOutputTokens, timeoutMs: args.selection.timeoutMs, reasoningEffort: args.selection.reasoningEffort, requireUsage: args.selection.route === "luna_primary" });
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
