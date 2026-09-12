/**
 * Isolated GPT comparison for completed prospect bursts.
 *
 * This module deliberately imports only the provider boundary. A shadow run
 * receives a frozen transcript and recorded tool evidence, so it cannot reach
 * a registry, database, Twilio, notification sender, or a write handler.
 */
import type Anthropic from "@anthropic-ai/sdk";
import type { AnthropicToolSchema } from "@/lib/tools/registry";
import { completeOpenAIResponses } from "./provider";
import { compareProspectShadow, type ProspectShadowComparison, type ShadowToolCall } from "./prospect-shadow-comparison";

export type ProspectShadowToolEvidence = {
  callId?: string;
  name: string;
  /** Canonical, schema-validated arguments captured with the tool result. */
  arguments: unknown;
  output: unknown;
};

export type ProspectShadowBurst = {
  conversation: readonly Anthropic.MessageParam[];
  /** Pre-turn snapshot. The caller must append the incumbent answer after this snapshot. */
  preTurnConversation?: readonly Anthropic.MessageParam[];
  toolEvidence?: readonly ProspectShadowToolEvidence[];
  /** Same typed read-only schemas as leasing, with no handlers attached. */
  tools?: readonly AnthropicToolSchema[];
  system?: string;
  burstId?: string;
  burstRevision?: number;
  promptId?: string;
  promptHash?: string;
  release?: string;
  primaryProvider?: string;
  primaryModel?: string;
  /** Incumbent output/evidence is persisted beside the snapshot, never sent to GPT. */
  primaryOutput?: string | null;
  primaryEvidence?: {
    supportedFacts?: readonly string[];
    supportedFactGroups?: readonly (readonly string[])[];
    unsupportedClaims?: readonly string[];
    toolCalls?: readonly ShadowToolCall[];
  };
  repetitionEvidence?: { priorOutputs?: readonly string[]; explicitRepeat?: boolean; correction?: boolean; newDetail?: boolean };
  onResult?: (metadata: ProspectShadowTraceMetadata) => void;
};

export type ProspectShadowTraceMetadata = {
  burstId?: string;
  burstRevision?: number;
  promptId?: string;
  promptHash?: string;
  release?: string;
  provider: "openai";
  model: string;
  shadowRole: "prospect_gpt_shadow";
  grounding: ProspectShadowComparison["grounding"];
  repetition: ProspectShadowComparison["repetition"];
  toolCorrectness: "replayed" | "mismatch" | "unknown";
  comparison?: ProspectShadowComparison;
  latencyMs?: number;
  usage?: { inputTokens: number; outputTokens: number };
};

export type ProspectShadowResult =
  | { status: "disabled" | "missing_key" | "unknown"; reason: string; burstId?: string }
  | { status: "completed"; reply: string; model: string; burstId?: string; usage: { inputTokens: number; outputTokens: number }; latencyMs: number; comparison: ProspectShadowComparison };

const DEFAULT_MODEL = "gpt-5.4-mini";
const DEFAULT_SYSTEM = "You are a silent evaluation shadow for a prospect SMS reply. Answer only from the frozen conversation and recorded tool evidence. Never invent missing facts. Do not propose actions or claim that anything was sent.";
let activeRuns = 0;

function enabled(): boolean {
  return process.env.AXIS_PROSPECT_GPT_SHADOW_ENABLED?.trim().toLowerCase() === "true";
}

function limit(name: string, fallback: number, min: number, max: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) ? Math.min(max, Math.max(min, Math.floor(value))) : fallback;
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value as Record<string, unknown>).sort().map((key) => `${JSON.stringify(key)}:${stable((value as Record<string, unknown>)[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

function frozenInputHash(burst: ProspectShadowBurst, conversation: readonly Anthropic.MessageParam[]): string | undefined {
  if (burst.system === undefined && !conversation.length) return undefined;
  // Stable, provider-independent identity. Avoid importing crypto so this remains edge-safe.
  const text = `${burst.system ?? DEFAULT_SYSTEM}\n${conversation.map((message) => `${message.role}:${stable(message.content)}`).join("\n")}`;
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) hash = Math.imul(hash ^ text.charCodeAt(index), 16777619);
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function hasUnrecordedToolEvidence(burst: ProspectShadowBurst, conversation: readonly Anthropic.MessageParam[]): boolean {
  const calls = conversation.flatMap((message) => {
    if (message.role !== "assistant" || !Array.isArray(message.content)) return [];
    return message.content.filter((block): block is Anthropic.ToolUseBlock => block.type === "tool_use");
  });
  if (!calls.length) return false;
  const evidence = burst.toolEvidence ?? [];
  return calls.some((call) => !evidence.some((item) => item.name === call.name && stable(item.arguments) === stable(call.input)));
}

function acquire(): (() => void) | null {
  const max = limit("AXIS_PROSPECT_GPT_SHADOW_MAX_CONCURRENCY", 2, 1, 8);
  if (activeRuns >= max) return null;
  activeRuns += 1;
  return () => { activeRuns -= 1; };
}

function shadowConversation(messages: readonly Anthropic.MessageParam[]): Anthropic.MessageParam[] { return [...messages]; }

/** Run one hermetic, read-only GPT comparison. Never throws for configuration or provider failures. */
export async function runProspectGptShadow(burst: ProspectShadowBurst): Promise<ProspectShadowResult> {
  if (!enabled()) return { status: "disabled", reason: "shadow_not_enabled", burstId: burst.burstId };
  if (!process.env.OPENAI_API_KEY?.trim()) return { status: "missing_key", reason: "openai_not_configured", burstId: burst.burstId };
  const sourceConversation = burst.preTurnConversation ?? burst.conversation;
  if (hasUnrecordedToolEvidence(burst, sourceConversation)) return { status: "unknown", reason: "missing_tool_evidence", burstId: burst.burstId };
  const release = acquire();
  if (!release) return { status: "unknown", reason: "shadow_concurrency_limit", burstId: burst.burstId };
  try {
    let conversation = shadowConversation(sourceConversation);
    const model = process.env.AXIS_PROSPECT_GPT_SHADOW_MODEL?.trim() || DEFAULT_MODEL;
    const deadline = Date.now() + limit("AXIS_PROSPECT_GPT_SHADOW_TOTAL_TIMEOUT_MS", 10000, 250, 30000);
    const totalUsage = { inputTokens: 0, outputTokens: 0 };
    let continuationState;
    const shadowToolCalls: ShadowToolCall[] = [];
    const remaining = () => Math.max(250, deadline - Date.now());
    let result = await completeOpenAIResponses({ model, system: burst.system?.trim() || DEFAULT_SYSTEM, tools: [...(burst.tools ?? [])], messages: conversation, maxOutputTokens: limit("AXIS_PROSPECT_GPT_SHADOW_MAX_OUTPUT_TOKENS", 512, 32, 2048), timeoutMs: remaining() });
    totalUsage.inputTokens += result.usage.inputTokens; totalUsage.outputTokens += result.usage.outputTokens;
    for (let iteration = 0; result.stopReason === "tool_use" && iteration < 4; iteration += 1) {
      const calls = result.content.filter((block): block is Anthropic.ToolUseBlock => block.type === "tool_use");
      shadowToolCalls.push(...calls.map((call) => ({ name: call.name, arguments: call.input })));
      const outputs = calls.map((call) => burst.toolEvidence?.find((e) => e.name === call.name && stable(e.arguments) === stable(call.input)));
      if (outputs.some((output) => !output)) return { status: "unknown", reason: "missing_tool_evidence", burstId: burst.burstId };
      conversation = [{ role: "user", content: calls.map((call, index) => ({ type: "tool_result", tool_use_id: call.id, content: JSON.stringify(outputs[index]!.output) })) as Anthropic.ToolResultBlockParam[] }];
      continuationState = result.continuationState && {
        ...result.continuationState,
        outputItems: [...result.continuationState.outputItems, ...calls.map((call, index) => ({ type: "function_call_output", call_id: call.id, output: JSON.stringify(outputs[index]!.output) }))],
      };
      if (Date.now() >= deadline) return { status: "unknown", reason: "shadow_timeout", burstId: burst.burstId };
      result = await completeOpenAIResponses({ model, system: burst.system?.trim() || DEFAULT_SYSTEM, tools: [...(burst.tools ?? [])], messages: conversation, continuationState, maxOutputTokens: limit("AXIS_PROSPECT_GPT_SHADOW_MAX_OUTPUT_TOKENS", 512, 32, 2048), timeoutMs: remaining() });
      totalUsage.inputTokens += result.usage.inputTokens; totalUsage.outputTokens += result.usage.outputTokens;
    }
    if (result.stopReason === "tool_use") return { status: "unknown", reason: "shadow_tool_loop_limit", burstId: burst.burstId };
    const reply = result.content.filter((block): block is Anthropic.TextBlock => block.type === "text").map((block) => block.text).join("").trim();
    if (!reply) return { status: "unknown", reason: "shadow_empty_output", burstId: burst.burstId };
    const latencyMs = Date.now() - (deadline - limit("AXIS_PROSPECT_GPT_SHADOW_TOTAL_TIMEOUT_MS", 10000, 250, 30000));
    const comparison = compareProspectShadow({
      identity: { burstId: burst.burstId, burstRevision: burst.burstRevision, promptId: burst.promptId, promptHash: burst.promptHash ?? frozenInputHash(burst, sourceConversation), release: burst.release, primaryProvider: burst.primaryProvider, primaryModel: burst.primaryModel, shadowProvider: "openai", shadowModel: model },
      primary: {
        output: burst.primaryOutput,
        evidence: {
          ...burst.primaryEvidence,
          toolCalls: burst.primaryEvidence?.toolCalls ?? burst.toolEvidence?.map((item) => ({ name: item.name, arguments: item.arguments })),
        },
      },
      shadow: { output: reply, toolCalls: shadowToolCalls },
      repetitionEvidence: burst.repetitionEvidence,
    });
    burst.onResult?.({ burstId: burst.burstId, burstRevision: burst.burstRevision, promptId: burst.promptId, promptHash: comparison.identity.promptHash, release: burst.release, provider: "openai", model, shadowRole: "prospect_gpt_shadow", grounding: comparison.grounding, repetition: comparison.repetition, toolCorrectness: comparison.toolCorrectness, comparison, latencyMs, usage: totalUsage });
    return { status: "completed", reply, model, burstId: burst.burstId, usage: totalUsage, latencyMs, comparison };
  } catch (error) {
    return { status: "unknown", reason: error instanceof Error ? error.message.slice(0, 160) : "shadow_failed", burstId: burst.burstId };
  } finally {
    release();
  }
}

/** Fire-and-forget scheduling hook. The caller's primary reply is never awaited. */
export function scheduleProspectGptShadow(burst: ProspectShadowBurst): Promise<ProspectShadowResult> {
  if (!enabled()) return Promise.resolve({ status: "disabled", reason: "shadow_not_enabled", burstId: burst.burstId });
  return runProspectGptShadow(burst);
}

export const isProspectGptShadowEnabled = enabled;
