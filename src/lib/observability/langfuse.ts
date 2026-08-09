/**
 * Langfuse agent tracing. One trace per agent turn, carrying the actor's
 * attribution metadata (landlordId / role / managerIds) and the user id so
 * sessions are replayable and attributable across all three portals. The loop
 * emits per-LLM-call, per-tool-call, and pending-action events through an
 * observer; we record them as nested generations/spans so the prompt, tools
 * available, tool args, tool results, per-call token counts, and cost are all
 * first-class. Degrades to a no-op when Langfuse env is unset or the SDK
 * misbehaves — tracing must never break a turn.
 */
import { Langfuse } from "langfuse";
import { startObservation } from "@langfuse/tracing";
import type { AgentObserver } from "@/lib/agent/loop";
import { estimateCostUsd } from "@/lib/agent/model";
import type { AgentPromptMeta } from "@/lib/agent/prompt-metadata";

let client: Langfuse | null = null;
let initialized = false;

function resolveEnvironment(): string {
  const raw =
    process.env.LANGFUSE_TRACING_ENVIRONMENT?.trim() ||
    process.env.VERCEL_ENV?.trim() ||
    process.env.NODE_ENV?.trim() ||
    "development";
  // Langfuse requires lowercase alphanumeric / hyphen / underscore, not starting with "langfuse".
  const cleaned = raw.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  if (!cleaned || cleaned.startsWith("langfuse")) return "development";
  return cleaned.slice(0, 40);
}

function getClient(): Langfuse | null {
  if (initialized) return client;
  initialized = true;
  // Tests share the same keys that production uses when someone points a
  // harness at them. Refuse to initialize under NODE_ENV=test so synthetic
  // traffic (`user_a`, `manager_a`) never pollutes the production project.
  if (process.env.NODE_ENV === "test") return (client = null);
  const secretKey = process.env.LANGFUSE_SECRET_KEY?.trim();
  const publicKey = process.env.LANGFUSE_PUBLIC_KEY?.trim();
  if (!secretKey || !publicKey) return (client = null);
  try {
    client = new Langfuse({
      secretKey,
      publicKey,
      baseUrl: process.env.LANGFUSE_BASE_URL?.trim() || "https://us.cloud.langfuse.com",
      environment: resolveEnvironment(),
    });
  } catch {
    client = null;
  }
  return client;
}

/**
 * Who a trace is attributed to. The manager route passes
 * `{ userId, metadata: { landlordId, role: "manager" } }`; resident/vendor
 * routes pass their own role + linked-manager ids. `sessionId` groups turns
 * of one conversation (falls back to userId).
 */
export type TraceActor = {
  userId: string;
  sessionId?: string;
  metadata?: Record<string, unknown>;
};

/** The subset of a Langfuse trace the observer uses; lets us unit-test the mapping. */
export type TraceLike = {
  update(args: Record<string, unknown>): void;
  generation(args: Record<string, unknown>): void | { end(): unknown };
  span(args: Record<string, unknown>): void | { end(): unknown };
};

/** Successful tool output captured for the grounding judge observation. */
export type ToolEvidence = {
  name: string;
  ok: boolean;
  output: unknown;
};

/** Run a trace call, swallowing errors so tracing never breaks a turn. */
function safe(fn: () => void) {
  try {
    fn();
  } catch {
    /* ignore */
  }
}

/** Completed observations are required before managed evaluators will run. */
function endObservation(observation: void | { end(): unknown }): void {
  observation?.end();
}

/**
 * Map loop events onto a Langfuse trace: tools-available + system size up front,
 * one generation per LLM call (with that call's tokens and cost), one span per
 * tool call carrying the full arguments and result, and one span per write-tool
 * proposal (pending action). Pure over `trace` so it is testable with a fake.
 *
 * Also accumulates tool evidence so the turn-summary observation can put the
 * reply and same-turn tool outputs on ONE observation — Langfuse observation
 * evaluators cannot read sibling spans.
 */
export function buildTraceObserver(
  trace: TraceLike,
  actor: TraceActor,
  promptMeta?: AgentPromptMeta,
): { observer: AgentObserver; getEvidence: () => ToolEvidence[] } {
  const actorMeta = actor.metadata ?? {};
  const promptFields = promptMeta
    ? { promptId: promptMeta.promptId, promptHash: promptMeta.promptHash, release: promptMeta.release }
    : {};
  const evidence: ToolEvidence[] = [];
  const observer: AgentObserver = {
    onStart: (info) =>
      safe(() =>
        trace.update({
          metadata: {
            ...actorMeta,
            ...promptFields,
            toolsAvailable: info.toolsAvailable,
            systemPrompt: info.system,
          },
        }),
      ),
    onLlmCall: (e) =>
      safe(() => {
        endObservation(trace.generation({
          name: "axis-agent-llm",
          model: e.model,
          usage: { input: e.usage.inputTokens, output: e.usage.outputTokens, unit: "TOKENS" },
          input: e.input,
          output: e.assistantContent,
          metadata: {
            iteration: e.iteration,
            stopReason: e.stopReason,
            toolsChosen: e.toolsChosen,
            provider: e.provider,
            route: e.route,
            latencyMs: e.latencyMs,
            fallbackReason: e.fallbackReason,
            estimatedCostUsd: estimateCostUsd(e.model, e.usage),
            ...promptFields,
            ...actorMeta,
          },
        }));
      }),
    onToolCall: (e) => {
      evidence.push({ name: e.name, ok: e.ok, output: e.output });
      // ponytail: tool args + results are sent to Langfuse uncapped (debug source
      // of truth, per AGENTS.md). Add a size cap here if payloads get unwieldy.
      safe(() => {
        endObservation(trace.span({
          name: `tool:${e.name}`,
          input: e.input,
          output: e.output,
          metadata: { ok: e.ok, iteration: e.iteration, ...actorMeta },
        }));
      });
    },
    onPendingAction: (e) =>
      safe(() => {
        endObservation(trace.span({
          name: `pending:${e.toolName}`,
          input: { toolName: e.toolName },
          output: e.ok ? e.preview : e.error,
          metadata: { ok: e.ok, iteration: e.iteration, ...actorMeta },
        }));
      }),
  };
  return { observer, getEvidence: () => evidence };
}

/**
 * Trace a single-shot LLM extraction + tool call from an ANONYMOUS public
 * surface (no authenticated user, so no landlordId/userId to carry — e.g. the
 * resident marketing housing-search chat). Carries a client-supplied sessionId
 * so one visitor's turns group together for replay. Degrades to a no-op the
 * same way `traceAgentTurn` does when Langfuse env is unset.
 */
export async function tracePublicToolTurn<T>(opts: {
  name: string;
  sessionId: string;
  input: string;
  run: (record: {
    llmCall: (e: {
      model: string;
      usage: { inputTokens: number; outputTokens: number };
      input: unknown;
      output: unknown;
      metadata?: Record<string, unknown>;
    }) => void;
    toolCall: (e: { name: string; input: unknown; output: unknown }) => void;
  }) => Promise<T>;
}): Promise<T> {
  const lf = getClient();
  if (!lf) return opts.run({ llmCall: () => {}, toolCall: () => {} });

  let trace: ReturnType<Langfuse["trace"]> | null = null;
  try {
    trace = lf.trace({
      name: opts.name,
      sessionId: opts.sessionId,
      input: opts.input,
      metadata: { public: true },
    });
  } catch {
    trace = null;
  }

  const record = {
    llmCall: (e: {
      model: string;
      usage: { inputTokens: number; outputTokens: number };
      input: unknown;
      output: unknown;
      metadata?: Record<string, unknown>;
    }) =>
      safe(() => {
        if (!trace) return;
        endObservation(trace.generation({
          name: "housing-search-extract",
          model: e.model,
          usage: { input: e.usage.inputTokens, output: e.usage.outputTokens, unit: "TOKENS" },
          input: e.input,
          output: e.output,
          metadata: { ...e.metadata, estimatedCostUsd: estimateCostUsd(e.model, e.usage) },
        }));
      }),
    toolCall: (e: { name: string; input: unknown; output: unknown }) =>
      safe(() => {
        if (!trace) return;
        endObservation(trace.span({ name: `tool:${e.name}`, input: e.input, output: e.output }));
      }),
  };

  try {
    const result = await opts.run(record);
    safe(() => trace?.update({ output: result as unknown as Record<string, unknown> }));
    return result;
  } catch (e) {
    safe(() => trace?.update({ output: e instanceof Error ? e.message : "error" }));
    throw e;
  } finally {
    try {
      await lf.flushAsync();
    } catch {
      /* ignore */
    }
  }
}

/**
 * The name every user-rating score is filed under. ONE name, so Langfuse can
 * chart it as a single series and the eval set is a single filter
 * (`user-rating = 0`) rather than a union of ad-hoc names. Add a NEW name only
 * for a genuinely different question — never a per-surface variant of this one.
 */
export const USER_RATING_SCORE = "user-rating";

/**
 * Dense, unbiased human label on every gated write: the user explicitly
 * approved or denied the proposal. Scored on the PROPOSAL turn's trace so the
 * prompt, tools, and arguments that produced it are in the same place.
 */
export const ACTION_APPROVED_SCORE = "action-approved";

/**
 * Managed LLM-as-judge score for "every numeric claim in the reply is grounded
 * in same-turn tool evidence." Written by the Langfuse evaluator against the
 * `axis-agent-turn-summary` observation — not by the app.
 */
export const NUMERIC_GROUNDING_SCORE = "numeric-grounding";

/** Observation name the grounding evaluator filters on. */
export const TURN_SUMMARY_OBSERVATION = "axis-agent-turn-summary";

/** Dataset populated from denied write proposals for regression replay. */
export const REJECTED_ACTIONS_DATASET = "agent-rejected-actions";

/**
 * Attach a user's thumbs rating to the trace that produced the reply. This is
 * the quality signal the agent otherwise has none of: traces record what the
 * agent DID, scores record whether it was any good, and a thumbs-down trace is
 * a ready-made eval case (it already carries the prompt, tools, arguments, and
 * results needed to replay it).
 *
 * Numeric 1/0 rather than a categorical: Langfuse averages numeric scores, so
 * the series reads directly as a satisfaction rate over time.
 *
 * Best-effort like the rest of this module — a failed score must never fail the
 * request. Returns whether the score reached Langfuse so the caller can decide
 * what to tell the user.
 */
export async function scoreAgentTrace(opts: {
  traceId: string;
  rating: "up" | "down";
  userId: string;
  comment?: string;
}): Promise<boolean> {
  return scoreTraceNumeric({
    traceId: opts.traceId,
    name: USER_RATING_SCORE,
    value: opts.rating === "up" ? 1 : 0,
    // Stable id so a double-click cannot double-count.
    id: `${USER_RATING_SCORE}-${opts.traceId}`,
    comment: opts.comment?.trim() ? opts.comment.trim().slice(0, 2000) : undefined,
  });
}

/**
 * Score a gated write's human decision onto its proposal trace. Stable score
 * id keyed by actionId so a replayed confirm/deny cannot double-score.
 */
export async function scoreActionApproval(opts: {
  traceId: string;
  approved: boolean;
  actionId: string;
  toolName?: string;
}): Promise<boolean> {
  return scoreTraceNumeric({
    traceId: opts.traceId,
    name: ACTION_APPROVED_SCORE,
    value: opts.approved ? 1 : 0,
    id: `${ACTION_APPROVED_SCORE}-${opts.actionId}`,
    comment: opts.toolName
      ? `${opts.approved ? "approved" : "denied"}:${opts.toolName}`.slice(0, 2000)
      : undefined,
  });
}

async function scoreTraceNumeric(opts: {
  traceId: string;
  name: string;
  value: number;
  id?: string;
  comment?: string;
}): Promise<boolean> {
  const lf = getClient();
  if (!lf) return false;
  try {
    lf.score({
      traceId: opts.traceId,
      name: opts.name,
      value: opts.value,
      dataType: "NUMERIC",
      id: opts.id,
      comment: opts.comment,
    });
    await lf.flushAsync();
    return true;
  } catch {
    return false;
  }
}

type TurnInput = { role: string; content: string }[];

type TurnUsage = { inputTokens: number; outputTokens: number };
type TracedResult = {
  reply: string;
  toolTrace: { tool: string; ok: boolean }[];
  model?: string;
  tier?: string;
  usage?: TurnUsage;
  pendingAction?: { toolName: string };
  provider?: string;
  route?: string;
  fallbackReason?: string;
  latencyMs?: number;
  iterationCount?: number;
  terminationReason?: "end_turn" | "pending_action" | "max_iterations";
  finalStopReason?: string | null;
};

/**
 * Flush before the server invocation returns.
 *
 * Do not import Next's `after()` here. This shared module is also reachable
 * from non-App-Router server entry points (SMS agents and one-shot jobs), and
 * merely importing `after` makes those bundles fail with a Pages Router error.
 * Awaiting the flush costs a small amount of tail latency, but guarantees
 * serverless invocations do not terminate before telemetry is delivered.
 */
async function flushTelemetry(lf: Langfuse): Promise<void> {
  try {
    await lf.flushAsync();
  } catch {
    /* observability must never fail a turn */
  }
}

async function emitManagedEvaluatorSummary(args: {
  input: unknown;
  output: unknown;
  metadata: Record<string, unknown>;
}): Promise<void> {
  const { getLangfuseSpanProcessor } = await import(
    "@/lib/observability/langfuse-otel.server"
  );
  const processor = getLangfuseSpanProcessor();
  if (!processor) return;
  try {
    startObservation(
      TURN_SUMMARY_OBSERVATION,
      {
        input: args.input,
        output: args.output,
        metadata: args.metadata,
        environment: resolveEnvironment(),
      },
      { asType: "span" },
    ).end();
    await processor.forceFlush();
  } catch {
    /* observability must never fail a turn */
  }
}

/**
 * Wrap an agent turn in a Langfuse trace. The trace records the input, the final
 * reply, the tools that ran, any pending write proposal, and — when the loop
 * reports them — the chosen model, complexity tier, token counts, and estimated
 * cost, all attributed to the actor. Failures in tracing are swallowed; the
 * wrapped function's result is always returned.
 */
export async function traceAgentTurn<T extends TracedResult>(
  actor: TraceActor,
  messages: TurnInput,
  run: (observer?: AgentObserver) => Promise<T>,
  /** Non-chat surfaces (the SMS agents, inbox draft replies) name their trace
   * and bind it to their own session id. `onTraceId` hands the caller the id of
   * the trace this turn produced, so the surface can persist it and later attach
   * a user rating to THIS turn (see `scoreAgentTrace`). Not called when Langfuse
   * is unconfigured — a surface with no trace id simply offers no rating.
   * `promptMeta` stamps promptId/hash/release onto the trace for attribution. */
  opts?: {
    name?: string;
    sessionId?: string;
    onTraceId?: (traceId: string) => void;
    promptMeta?: AgentPromptMeta;
    /** When false, skip the turn-summary observation (non-tool surfaces). */
    emitTurnSummary?: boolean;
  },
): Promise<T> {
  const lf = getClient();
  if (!lf) return run();

  const lastUser = [...messages].reverse().find((m) => m.role === "user")?.content ?? "";
  let trace: ReturnType<Langfuse["trace"]> | null = null;
  try {
    trace = lf.trace({
      name: opts?.name ?? "axis-agent-turn",
      userId: actor.userId,
      sessionId: opts?.sessionId ?? actor.sessionId ?? actor.userId,
      metadata: {
        ...(actor.metadata ?? {}),
        ...(opts?.promptMeta
          ? {
              promptId: opts.promptMeta.promptId,
              promptHash: opts.promptMeta.promptHash,
              release: opts.promptMeta.release,
            }
          : {}),
      },
      input: lastUser,
    });
    if (trace?.id) safe(() => opts?.onTraceId?.(trace!.id));
  } catch {
    trace = null;
  }

  const built = trace ? buildTraceObserver(trace, actor, opts?.promptMeta) : undefined;

  try {
    const result = await run(built?.observer);
    try {
      // Per-call generations and per-tool spans are recorded live via the
      // observer; here we only stamp the turn-level summary for quick scanning.
      const costUsd =
        result.model && result.usage ? estimateCostUsd(result.model, result.usage) : undefined;
      const toolOk = result.toolTrace.filter((t) => t.ok).length;
      const toolFail = result.toolTrace.filter((t) => !t.ok).length;
      const evidence = built?.getEvidence() ?? [];
      const successfulEvidence = evidence.filter((e) => e.ok);
      trace?.update({
        output: result.reply,
        metadata: {
          ...(actor.metadata ?? {}),
          ...(opts?.promptMeta
            ? {
                promptId: opts.promptMeta.promptId,
                promptHash: opts.promptMeta.promptHash,
                release: opts.promptMeta.release,
              }
            : {}),
          tools: result.toolTrace.map((t) => t.tool),
          model: result.model,
          tier: result.tier,
          provider: result.provider,
          route: result.route,
          fallbackReason: result.fallbackReason,
          latencyMs: result.latencyMs,
          inputTokens: result.usage?.inputTokens,
          outputTokens: result.usage?.outputTokens,
          estimatedCostUsd: costUsd,
          pendingAction: result.pendingAction?.toolName,
          iterationCount: result.iterationCount,
          terminationReason: result.terminationReason,
          finalStopReason: result.finalStopReason ?? null,
          toolSuccessCount: toolOk,
          toolFailureCount: toolFail,
        },
      });

      // Observation evaluators only see the observation they match — not sibling
      // tool spans. Put the reply + successful tool evidence on one observation
      // so the managed numeric-grounding judge has everything it needs.
      const emitSummary = opts?.emitTurnSummary !== false && successfulEvidence.length > 0;
      if (emitSummary) {
        const summaryInput = {
          userRequest: lastUser,
          toolEvidence: successfulEvidence.map((e) => ({ name: e.name, output: e.output })),
        };
        const summaryMetadata = {
          ...(opts?.promptMeta
            ? {
                promptId: opts.promptMeta.promptId,
                promptHash: opts.promptMeta.promptHash,
                release: opts.promptMeta.release,
              }
            : {}),
          iterationCount: result.iterationCount,
          terminationReason: result.terminationReason,
          finalStopReason: result.finalStopReason ?? null,
          toolSuccessCount: toolOk,
          toolFailureCount: toolFail,
          legacyTraceId: trace?.id,
          ...(actor.metadata ?? {}),
        };
        safe(() => {
          if (!trace) return;
          endObservation(trace.span({
            name: TURN_SUMMARY_OBSERVATION,
            input: summaryInput,
            output: result.reply,
            metadata: summaryMetadata,
          }));
        });
        await emitManagedEvaluatorSummary({
          input: summaryInput,
          output: result.reply,
          metadata: summaryMetadata,
        });
      }
    } catch {
      /* ignore */
    }
    return result;
  } catch (e) {
    try {
      trace?.update({ output: e instanceof Error ? e.message : "error" });
    } catch {
      /* ignore */
    }
    throw e;
  } finally {
    await flushTelemetry(lf);
  }
}

/**
 * The confirm gate's wrapped call — the same discriminated union
 * `executeWriteTool` returns. Typed exactly (not a loose `{ reply?: string }`,
 * which every object satisfies structurally) so a future shape change fails to
 * compile instead of silently tracing "done" for every confirmed action.
 */
export type TracedActionResult =
  | { ok: true; result: { reply: string } }
  | { ok: false; error: string };

/**
 * Wrap the confirm endpoint's execute/cancel of a pending action in its own
 * small trace, so every state change is attributable and replayable alongside
 * the turn that proposed it.
 */
export async function traceAgentAction<T extends TracedActionResult | { ok: true; result: { reply: string } } | { ok: true }>(
  actor: TraceActor,
  info: { toolName: string; actionId: string; decision: "confirm" | "cancel"; proposalTraceId?: string | null },
  run: () => Promise<T>,
): Promise<T> {
  const lf = getClient();
  if (!lf) return run();

  let trace: ReturnType<Langfuse["trace"]> | null = null;
  try {
    trace = lf.trace({
      name: "axis-agent-action",
      userId: actor.userId,
      sessionId: actor.sessionId ?? actor.userId,
      metadata: {
        ...(actor.metadata ?? {}),
        toolName: info.toolName,
        actionId: info.actionId,
        decision: info.decision,
        ...(info.proposalTraceId ? { proposalTraceId: info.proposalTraceId } : {}),
      },
      input: `${info.decision}:${info.toolName}`,
    });
  } catch {
    trace = null;
  }

  try {
    const result = await run();
    safe(() => {
      if ("result" in result && result.ok && result.result && "reply" in result.result) {
        trace?.update({ output: result.result.reply });
      } else if ("error" in result && !result.ok) {
        trace?.update({ output: result.error });
      } else {
        trace?.update({ output: info.decision });
      }
    });
    return result;
  } catch (e) {
    safe(() => trace?.update({ output: e instanceof Error ? e.message : "error" }));
    throw e;
  } finally {
    await flushTelemetry(lf);
  }
}

/**
 * Trace one externally initiated MCP / REST tool call. There is no PropLane
 * LLM turn for these calls—the customer owns the harness—but the tool input,
 * result, key id, and manager scope still need to be replayable when support
 * investigates an integration. Keep this separate from `traceAgentAction`:
 * calling a read tool is not a confirmation decision.
 */
export async function traceExternalToolCall<T>(
  actor: TraceActor,
  info: { toolName: string; input: unknown; transport: "mcp" | "rest"; keyId: string },
  run: () => Promise<T>,
): Promise<T> {
  const lf = getClient();
  if (!lf) return run();

  let trace: ReturnType<Langfuse["trace"]> | null = null;
  try {
    trace = lf.trace({
      name: "axis-mcp-tool-call",
      userId: actor.userId,
      sessionId: actor.sessionId ?? `mcp:${info.keyId}`,
      metadata: {
        ...(actor.metadata ?? {}),
        toolName: info.toolName,
        transport: info.transport,
        keyId: info.keyId,
      },
      input: info.input,
    });
  } catch {
    trace = null;
  }

  try {
    const result = await run();
    safe(() => trace?.update({ output: result }));
    return result;
  } catch (e) {
    safe(() => trace?.update({ output: e instanceof Error ? e.message : "error" }));
    throw e;
  } finally {
    await flushTelemetry(lf);
  }
}
