/**
 * Thin custom agent loop on the Anthropic SDK with native tool-calling. The
 * model orchestrates and explains, the system computes. Read tools run
 * directly; a write tool call runs its READ-ONLY preview phase and halts the
 * turn with a pendingAction — nothing executes until the user confirms
 * through the gated endpoint. Reliability guards: a max-iteration cap and
 * pause_turn handling. Tool results are returned to the model as data, never
 * as instructions.
 */
import Anthropic from "@anthropic-ai/sdk";
import type { AgentContext } from "@/lib/tools/context";
import {
  type ToolRegistry,
  type ActionPreview,
  toAnthropicTools,
  runReadTool,
  previewWriteTool,
} from "@/lib/tools/registry";
import { MANAGER_SYSTEM_PROMPT } from "./system-prompts";
import { selectModel, type ModelTier, type AgentProvider, type AgentRoute, type AgentModelSelection } from "./model";
import { completeAgentModel } from "./provider";

const MAX_ITERATIONS = 8;

/** Public so health reports / tests can assert against the same cap. */
export { MAX_ITERATIONS };

export type ToolTraceEntry = { tool: string; ok: boolean };
export type TurnUsage = { inputTokens: number; outputTokens: number };

/** A write tool the model proposed; the turn halted awaiting user confirmation. */
export type PendingActionProposal = {
  toolName: string;
  /** Zod-validated. Persisted server-side, never sent to the client. */
  input: unknown;
  preview: ActionPreview;
  destructive: boolean;
};

export type AgentTurnResult = {
  reply: string;
  toolTrace: ToolTraceEntry[];
  model: string;
  tier: ModelTier;
  provider: AgentProvider;
  route: AgentRoute;
  fallbackReason?: string;
  latencyMs: number;
  usage: TurnUsage;
  /** Present => the turn halted on a write-tool proposal awaiting confirmation. */
  pendingAction?: PendingActionProposal;
  /** 1-based count of LLM calls made this turn (capped at MAX_ITERATIONS). */
  iterationCount: number;
  /** Why the loop stopped — used by Langfuse turn-summary / health reports. */
  terminationReason: "end_turn" | "pending_action" | "max_iterations";
  /** Anthropic stop_reason of the last LLM call, when one ran. */
  finalStopReason: string | null;
};

/**
 * Per-call/per-tool events the loop emits as work happens. Kept Langfuse-agnostic
 * so the loop has no observability coupling; the observability layer implements
 * this to nest the trace. Every observer call is guarded — a throwing observer
 * must never break a turn.
 */
export type LlmCallEvent = {
  iteration: number;
  model: string;
  usage: TurnUsage; // THIS call only, not the turn accumulator
  stopReason: string | null;
  toolsChosen: string[];
  provider: AgentProvider;
  route: AgentRoute;
  latencyMs: number;
  fallbackReason?: string;
  input: Anthropic.MessageParam[]; // messages sent for this call
  assistantContent: Anthropic.ContentBlock[]; // the response blocks
};
export type ToolCallEvent = {
  iteration: number;
  name: string;
  input: unknown; // raw model-supplied args
  ok: boolean;
  output: unknown; // result.data on success, error string on failure
};
export type PendingActionEvent = {
  iteration: number;
  toolName: string;
  ok: boolean;
  preview?: ActionPreview;
  error?: string;
};
export type AgentObserver = {
  onStart?(info: { system: string; toolsAvailable: string[]; model: string; tier: ModelTier; provider: AgentProvider; route: AgentRoute }): void;
  onLlmCall?(e: LlmCallEvent): void;
  onToolCall?(e: ToolCallEvent): void;
  onPendingAction?(e: PendingActionEvent): void;
};

/** Invoke an observer hook, swallowing any error so tracing can't break a turn. */
function notify(fn: (() => void) | undefined) {
  if (!fn) return;
  try {
    fn();
  } catch {
    /* ignore */
  }
}

export async function runAgentTurn<Ctx = AgentContext>(opts: {
  ctx: Ctx;
  registry: ToolRegistry<Ctx>;
  messages: Anthropic.MessageParam[];
  /** Portal-specific system prompt; defaults to the manager prompt. */
  system?: string;
  observer?: AgentObserver;
  /** Pin the model instead of routing by complexity (the SMS agents do this). */
  model?: Partial<AgentModelSelection> & { model: string; tier: ModelTier };
  /** Explicit tool shortlist for a read-only fast lane. */
  toolNames?: readonly string[];
  /**
   * Write tools this surface lets the model call WITHOUT a confirmation card.
   * An explicit per-surface allowlist (e.g. the vendor SMS agent's
   * escalate_to_manager, where no human is present on a webhook turn) so a
   * write tool added to a registry later can never become autonomously
   * callable by accident.
   */
  allowWriteTools?: readonly string[];
  /**
   * Hide every write tool the surface has not allow-listed. Set by surfaces with
   * NO confirmation UI (the SMS agents): a proposal there could never be shown
   * or confirmed, so the model must not be able to make one.
   */
  readOnly?: boolean;
}): Promise<AgentTurnResult> {
  const system = opts.system ?? MANAGER_SYSTEM_PROMPT;
  const allowWrite = opts.allowWriteTools ?? [];
  const allTools = toAnthropicTools(opts.registry, { allowWrite, readOnly: opts.readOnly });
  const tools = opts.toolNames ? allTools.filter((tool) => opts.toolNames!.includes(tool.name)) : allTools;
  const messages: Anthropic.MessageParam[] = [...opts.messages];
  const toolTrace: ToolTraceEntry[] = [];

  // Route the turn once, up front, based on its complexity, and use that model
  // for every iteration of the loop (switching models mid-turn would thrash the
  // prompt cache). Token usage accumulates across iterations for cost tracing.
  const selected = opts.model ?? ({ ...selectModel(opts.messages), provider: "anthropic", route: "anthropic" } as AgentModelSelection);
  const selection: AgentModelSelection = {
    model: selected.model,
    tier: selected.tier,
    provider: selected.provider ?? "anthropic",
    route: selected.route ?? "anthropic",
    ...(selected.fallbackModel ? { fallbackModel: selected.fallbackModel } : {}),
  };
  const { model, tier } = selection;
  let effectiveModel = model;
  let actualProvider: AgentProvider = selection.provider;
  let fallbackReason: string | undefined;
  let totalLatencyMs = 0;
  const usage: TurnUsage = { inputTokens: 0, outputTokens: 0 };

  const observer = opts.observer;
  let lastStopReason: string | null = null;
  notify(
    observer?.onStart &&
      (() => observer.onStart!({ system, toolsAvailable: tools.map((t) => t.name), model, tier, provider: selection.provider, route: selection.route })),
  );

  for (let i = 0; i < MAX_ITERATIONS; i++) {
    // Snapshot the messages sent for this call before we mutate the array, so the
    // trace records the exact prompt for replay.
    const callInput = [...messages];
    const response = await completeAgentModel({ selection, system, tools, messages });
    actualProvider = response.provider;
    if (response.fallbackReason) effectiveModel = selection.fallbackModel || model;
    fallbackReason ??= response.fallbackReason;
    totalLatencyMs += response.latencyMs;

    const callUsage: TurnUsage = {
      inputTokens: response.usage.inputTokens,
      outputTokens: response.usage.outputTokens,
    };
    usage.inputTokens += callUsage.inputTokens;
    usage.outputTokens += callUsage.outputTokens;

    const toolUses = response.content.filter(
      (b): b is Anthropic.ToolUseBlock => b.type === "tool_use",
    );
    lastStopReason = response.stopReason ?? null;

    notify(
      observer?.onLlmCall &&
        (() =>
          observer.onLlmCall!({
            iteration: i,
            model: response.fallbackReason ? selection.fallbackModel || model : model,
            usage: callUsage,
            stopReason: response.stopReason,
            toolsChosen: toolUses.map((u) => u.name),
            input: callInput,
            assistantContent: response.content,
            provider: response.provider,
            route: selection.route,
            latencyMs: response.latencyMs,
            fallbackReason: response.fallbackReason,
          })),
    );

    if (response.stopReason === "pause_turn") {
      messages.push({ role: "assistant", content: response.content });
      continue;
    }

    if (response.stopReason !== "tool_use" || toolUses.length === 0) {
      const reply = response.content
        .filter((b): b is Anthropic.TextBlock => b.type === "text")
        .map((b) => b.text)
        .join("")
        .trim();
      return {
        reply: reply || "I couldn't find an answer to that.",
        toolTrace,
        model: effectiveModel,
        tier,
        usage,
        provider: actualProvider,
        route: selection.route,
        fallbackReason,
        latencyMs: totalLatencyMs,
        iterationCount: i + 1,
        terminationReason: "end_turn",
        finalStopReason: lastStopReason,
      };
    }

    // A confirm-gated write proposal halts the turn. Only the FIRST such call
    // is honored (the system prompt tells the model to propose one action at a
    // time; batches go inside one tool call's array input). If its preview
    // succeeds we return immediately — sibling tool calls are dropped, which is
    // safe because the client conversation history is text-only, so the
    // abandoned tool_use blocks never reach a future API call.
    const gatedWrite = toolUses.find((u) => {
      const t = opts.registry.get(u.name);
      return t?.kind === "write" && !allowWrite.includes(u.name);
    });
    if (gatedWrite) {
      const prepared = await previewWriteTool(opts.registry, opts.ctx, gatedWrite.name, gatedWrite.input);
      notify(
        observer?.onPendingAction &&
          (() =>
            observer.onPendingAction!({
              iteration: i,
              toolName: gatedWrite.name,
              ok: prepared.ok,
              preview: prepared.ok ? prepared.preview : undefined,
              error: prepared.ok ? undefined : prepared.error,
            })),
      );
      if (prepared.ok) {
        toolTrace.push({ tool: gatedWrite.name, ok: true });
        const reply = response.content
          .filter((b): b is Anthropic.TextBlock => b.type === "text")
          .map((b) => b.text)
          .join("")
          .trim();
        return {
          reply,
          toolTrace,
          model: effectiveModel,
          tier,
          usage,
          provider: actualProvider,
          route: selection.route,
          fallbackReason,
          latencyMs: totalLatencyMs,
          iterationCount: i + 1,
          terminationReason: "pending_action",
          finalStopReason: lastStopReason,
          pendingAction: {
            toolName: gatedWrite.name,
            input: prepared.input,
            preview: prepared.preview,
            destructive: prepared.destructive,
          },
        };
      }
      // Preview failed: feed the error back so the model can self-correct.
      // Every tool_use in this response still needs a tool_result; sibling
      // reads run normally, extra gated writes are refused.
      toolTrace.push({ tool: gatedWrite.name, ok: false });
      messages.push({ role: "assistant", content: response.content });
      const results: Anthropic.ToolResultBlockParam[] = [];
      for (const use of toolUses) {
        if (use.id === gatedWrite.id) {
          results.push({
            type: "tool_result",
            tool_use_id: use.id,
            content: prepared.error,
            is_error: true,
          });
          continue;
        }
        const tool = opts.registry.get(use.name);
        if (tool?.kind === "write" && !allowWrite.includes(use.name)) {
          toolTrace.push({ tool: use.name, ok: false });
          results.push({
            type: "tool_result",
            tool_use_id: use.id,
            content: "Propose one action at a time. This call was not processed.",
            is_error: true,
          });
          continue;
        }
        const result = await runInlineTool(opts.registry, opts.ctx, use, i, toolTrace, allowWrite, observer);
        results.push(result);
      }
      messages.push({ role: "user", content: results });
      continue;
    }

    messages.push({ role: "assistant", content: response.content });

    const results = await Promise.all(
      toolUses.map((use) => runInlineTool(opts.registry, opts.ctx, use, i, toolTrace, allowWrite, observer)),
    );
    messages.push({ role: "user", content: results });
  }

  return {
    reply: "I reached the maximum number of steps without finishing. Please try a more specific question.",
    toolTrace,
    model: effectiveModel,
    tier,
    usage,
    provider: actualProvider,
    route: selection.route,
    fallbackReason,
    latencyMs: totalLatencyMs,
    iterationCount: MAX_ITERATIONS,
    terminationReason: "max_iterations",
    finalStopReason: lastStopReason,
  };
}

/**
 * Run a tool the loop may execute inline: read tools, plus any write tool this
 * surface allow-listed (still audit-logged inside its own handler). Everything
 * else is refused here — a gated write only ever executes from the confirm gate.
 */
async function runInlineTool<Ctx>(
  registry: ToolRegistry<Ctx>,
  ctx: Ctx,
  use: Anthropic.ToolUseBlock,
  iteration: number,
  toolTrace: ToolTraceEntry[],
  allowWrite: readonly string[],
  observer?: AgentObserver,
): Promise<Anthropic.ToolResultBlockParam> {
  const result = await runReadTool(registry, ctx, use.name, use.input, { allowWrite });
  const ok = result.ok;
  const output = result.ok ? result.data : result.error;

  toolTrace.push({ tool: use.name, ok });
  notify(
    observer?.onToolCall &&
      (() =>
        observer.onToolCall!({
          iteration,
          name: use.name,
          input: use.input,
          ok,
          output,
        })),
  );
  return {
    type: "tool_result",
    tool_use_id: use.id,
    content: ok ? JSON.stringify(output) : String(output),
    is_error: !ok,
  };
}
