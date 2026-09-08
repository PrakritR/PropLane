/**
 * Model routing for the interactive tool-calling agent.
 *
 * The agent runs on different Claude models depending on how complex the turn
 * is, so we spend the fewest tokens for a given answer quality: a "hi" greeting
 * runs on Haiku, an ordinary lookup on Sonnet, and a multi-part analytical
 * question on Opus. Routing is a pure, deterministic heuristic over the message
 * shape (length, intent keywords, conversation depth) — no extra LLM call, no
 * added latency, and it never lets message *content* trigger an action (the
 * messages are untrusted input; we only read their shape).
 *
 * Routing is conservative: the safe default is the mid tier. We only drop to
 * Haiku for clearly trivial turns and only escalate to Opus for clearly complex
 * ones, because misrouting a hard task to a weak model is the failure we most
 * want to avoid.
 */
import type Anthropic from "@anthropic-ai/sdk";
import { lastUserText as lastUserMessageText } from "@/lib/agent/chat-handler";

export type ModelTier = "simple" | "standard" | "complex";
export type AgentProvider = "anthropic" | "openrouter";
export type AgentRoute = "anthropic" | "fast_direct" | "fast_lookup";
export type AgentModelSelection = {
  model: string;
  tier: ModelTier;
  provider: AgentProvider;
  route: AgentRoute;
  /** Anthropic safety/reliability fallback for the OpenRouter fast lane. */
  fallbackModel?: string;
};

/** Route selection plus optional read-only fast-lane tool shortlist. */
export type AgentRouteSelection = AgentModelSelection & {
  toolNames?: readonly string[];
  readOnly?: boolean;
};

/** Pass-through for {@link runAgentTurn} when the route pins a tool shortlist. */
export function fastLaneRunOptions(routing: AgentRouteSelection): {
  toolNames?: readonly string[];
  readOnly?: boolean;
} {
  if (routing.toolNames === undefined) return {};
  return { toolNames: routing.toolNames, readOnly: routing.readOnly };
}

/**
 * Tier -> model id. Each tier is overridable via env for cost tuning without a
 * code change. `AXIS_AGENT_MODEL` (the original single-model env var) is kept as
 * a global hard override: when set, it forces that one model for every tier.
 */
const GLOBAL_OVERRIDE = process.env.AXIS_AGENT_MODEL?.trim() || "";

export const TIER_MODELS: Record<ModelTier, string> = {
  simple: GLOBAL_OVERRIDE || process.env.AXIS_AGENT_MODEL_SIMPLE?.trim() || "claude-haiku-4-5",
  standard: GLOBAL_OVERRIDE || process.env.AXIS_AGENT_MODEL_STANDARD?.trim() || "claude-sonnet-4-6",
  complex: GLOBAL_OVERRIDE || process.env.AXIS_AGENT_MODEL_COMPLEX?.trim() || "claude-opus-4-8",
};

/**
 * Back-compat: the previous single export. Equals the global override when set,
 * otherwise the standard-tier default. Existing imports keep working.
 */
export const AGENT_MODEL = TIER_MODELS.standard;

/** Per-model pricing in USD per million tokens (input, output). */
export const MODEL_PRICING: Record<string, { inputPerMTok: number; outputPerMTok: number }> = {
  "claude-haiku-4-5": { inputPerMTok: 1, outputPerMTok: 5 },
  "claude-sonnet-4-6": { inputPerMTok: 3, outputPerMTok: 15 },
  "claude-opus-4-8": { inputPerMTok: 5, outputPerMTok: 25 },
  "google/gemini-3.5-flash-lite": { inputPerMTok: 0.3, outputPerMTok: 2.5 },
};

const warnedUnpricedModels = new Set<string>();

/** Estimated USD cost of a turn from accumulated token usage. 0 if unpriced. */
export function estimateCostUsd(model: string, usage: { inputTokens: number; outputTokens: number }): number {
  const price = MODEL_PRICING[model];
  if (!price) {
    if (!warnedUnpricedModels.has(model)) {
      warnedUnpricedModels.add(model);
      console.warn(
        `[agent/model] No pricing for model "${model}"; cost traces for this model will report $0. Add it to MODEL_PRICING.`,
      );
    }
    return 0;
  }
  return (
    (usage.inputTokens / 1_000_000) * price.inputPerMTok +
    (usage.outputTokens / 1_000_000) * price.outputPerMTok
  );
}

// Words that signal analysis/reasoning across data rather than a single lookup.
const COMPLEX_SIGNALS = [
  "compare",
  "analyze",
  "analyse",
  "analysis",
  "trend",
  "forecast",
  "project",
  "projection",
  "reconcile",
  "break down",
  "breakdown",
  "across",
  "versus",
  " vs ",
  "correlat",
  "explain why",
  "root cause",
  "recommend",
  "strategy",
  "optimi", // optimize / optimise
];

const WRITE_SIGNALS = [
  "send ", "create ", "update ", "delete ", "cancel ", "schedule ", "pay ", "mark paid", "approve ", "reject ",
  "assign ", "invite ", "record ", "sign ", "revoke ", "complete ",
  "reply ", "text ", "message ",
];

const DIRECT_SIGNALS = [
  "what can you do", "how does proplane work", "how does this work", "help me", "what is proplane", "pricing",
];

const LOOKUP_TOOL_KEYWORDS: [RegExp, string[]][] = [
  [/\b(sms|texts|work.number|potential tenant|prospect)\b/i, ["list_sms_conversations"]],
  [/\b(overdue|charge|charges|rent roll)\b/i, ["get_overdue_charges", "list_charges", "get_my_balance", "list_my_charges"]],
  [/\b(lease|leases)\b/i, ["list_leases", "get_my_lease"]],
  [/\b(work order|work orders|maintenance|service request)\b/i, ["list_work_orders", "list_my_work_orders", "list_my_service_requests"]],
  [/\b(application|applications)\b/i, ["list_applications", "get_my_application_status"]],
  [/\b(property|properties|listing|listings)\b/i, ["list_properties", "get_property_details"]],
  [/\b(calendar|tour|availability)\b/i, ["list_calendar_events", "list_my_schedule"]],
  [/\b(inbox|message|messages)\b/i, ["list_inbox_threads", "list_my_inbox_threads"]],
  [/\b(job|jobs|bid|bids|offer|offers)\b/i, ["list_my_jobs", "list_my_bids", "list_my_offers"]],
];

// Short, self-contained pleasantries / acknowledgements.
const TRIVIAL_PHRASES = [
  "hi",
  "hii",
  "hey",
  "hello",
  "yo",
  "thanks",
  "thank you",
  "thx",
  "ok",
  "okay",
  "cool",
  "great",
  "got it",
  "sounds good",
  "yes",
  "no",
  "yep",
  "nope",
  "bye",
];


function lastUserText(messages: Anthropic.MessageParam[]): string {
  return lastUserMessageText(messages);
}

/**
 * Classify a turn's complexity from message shape alone. Pure function: no IO,
 * no model call, content is read only for length/keyword/shape signals.
 */
export function classifyComplexity(messages: Anthropic.MessageParam[]): ModelTier {
  const text = lastUserText(messages).trim();
  const lower = text.toLowerCase();
  const wordCount = lower.split(/\s+/).filter(Boolean).length;
  const questionMarks = (text.match(/\?/g) || []).length;
  const turnCount = messages.length;

  // Clearly complex: analytical intent, multiple questions in one message, a
  // long prompt, or a deep conversation that has accumulated a lot of context.
  const hasComplexSignal = COMPLEX_SIGNALS.some((s) => lower.includes(s));
  if (
    hasComplexSignal ||
    questionMarks >= 2 ||
    wordCount > 60 ||
    text.length > 400 ||
    turnCount >= 10
  ) {
    return "complex";
  }

  // Clearly trivial: a greeting/acknowledgement with no real request, no
  // question, and early in the conversation. We match against a known set of
  // pleasantries rather than a raw length cutoff, so short but real commands
  // ("list my leases") stay on the standard tier where quality is safer.
  // Anything past the first couple of turns is more likely a real follow-up.
  const isTrivialPhrase = TRIVIAL_PHRASES.includes(lower.replace(/[.!?,]+$/g, ""));
  if (turnCount <= 2 && questionMarks === 0 && isTrivialPhrase) {
    return "simple";
  }

  // Everything else: the safe default.
  return "standard";
}

/** Pick the model and tier for a turn. */
export function selectModel(messages: Anthropic.MessageParam[]): { model: string; tier: ModelTier } {
  const tier = classifyComplexity(messages);
  return { model: TIER_MODELS[tier], tier };
}

function fastLaneEnabled(actorKey: string): boolean {
  if (process.env.AXIS_AGENT_FAST_ENABLED?.trim().toLowerCase() !== "true") return false;
  if (!process.env.OPENROUTER_API_KEY?.trim()) return false;
  const percentage = Math.min(100, Math.max(0, Number(process.env.AXIS_AGENT_FAST_ROLLOUT_PERCENT || 0)));
  if (!Number.isFinite(percentage) || percentage <= 0) return false;
  let hash = 2166136261;
  for (const char of actorKey) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
  return (hash >>> 0) % 100 < percentage;
}

/**
 * Choose a provider and, for the fast lane, a strictly read-only shortlist.
 * Unknown or ambiguous requests intentionally return the established Anthropic
 * route; this selector optimizes only clear wins.
 */
export function selectAgentRoute(args: {
  messages: Anthropic.MessageParam[];
  actorKey: string;
  availableTools: readonly string[];
  hasAttachments?: boolean;
}): AgentRouteSelection {
  const normal = selectModel(args.messages);
  const fallback = process.env.AXIS_AGENT_MODEL_STANDARD?.trim() || "claude-sonnet-4-6";
  if (args.hasAttachments || !fastLaneEnabled(args.actorKey)) {
    return { ...normal, provider: "anthropic", route: "anthropic" };
  }
  const text = lastUserText(args.messages).trim().toLowerCase();
  if (!text || WRITE_SIGNALS.some((signal) => text.includes(signal)) || classifyComplexity(args.messages) === "complex") {
    return { ...normal, provider: "anthropic", route: "anthropic" };
  }
  const fastModel = process.env.AXIS_AGENT_FAST_MODEL?.trim() || "google/gemini-3.5-flash-lite";
  const isDirect = TRIVIAL_PHRASES.includes(text.replace(/[.!?,]+$/g, "")) || DIRECT_SIGNALS.some((signal) => text.includes(signal));
  if (isDirect) {
    return { model: fastModel, tier: "simple", provider: "openrouter", route: "fast_direct", fallbackModel: fallback, toolNames: [], readOnly: true };
  }
  const match = LOOKUP_TOOL_KEYWORDS.find(([pattern]) => pattern.test(text));
  const toolName = match?.[1].find((candidate) => args.availableTools.includes(candidate));
  if (toolName) {
    return { model: fastModel, tier: "simple", provider: "openrouter", route: "fast_lookup", fallbackModel: fallback, toolNames: [toolName], readOnly: true };
  }
  return { ...normal, provider: "anthropic", route: "anthropic" };
}
