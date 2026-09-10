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
  provider: "anthropic" | "openrouter";
  fallbackReason?: string;
  latencyMs: number;
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
}): Promise<ProviderCompletion> {
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
