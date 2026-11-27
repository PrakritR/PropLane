import { selectLunaTaskModel, TIER_MODELS, type AgentModelSelection } from "@/lib/agent/model";

/** Server-owned text task selection. Legacy identifiers remain provider-scoped. */
export function runtimeTaskModel(options: { maxOutputTokens?: number; timeoutMs?: number } = {}, legacy: AgentModelSelection = { model: TIER_MODELS.standard, tier: "standard", provider: "anthropic", route: "anthropic" }): AgentModelSelection {
  return selectLunaTaskModel(legacy, {
    reasoningEffort: "low", maxOutputTokens: 8_000, timeoutMs: 40_000, ...options,
  });
}

/**
 * Whole-turn wall-clock budget for a texted reply. The inbound pipeline runs inside a 120s `after()` window that
 * also covers debounce, tool reads, persistence and delivery; a turn that outlives it is killed with no reply.
 */
export const SMS_TURN_BUDGET_MS = 45_000;
/** Per-call ceiling for the Anthropic route of an SMS turn (the loop clips it further to the remaining budget). */
const SMS_ANTHROPIC_CALL_TIMEOUT_MS = 30_000;

/** Give a non-Luna SMS selection the same bounded budget Luna already has. */
export function withSmsTurnBudget(selection: AgentModelSelection, channel: string = "sms"): AgentModelSelection {
  const budget = channel === "voice" ? 15_000 : SMS_TURN_BUDGET_MS;
  return {
    ...selection,
    timeoutMs: Math.min(selection.timeoutMs ?? SMS_ANTHROPIC_CALL_TIMEOUT_MS, budget),
    turnBudgetMs: Math.min(selection.turnBudgetMs ?? budget, budget),
  };
}

/** SMS rollout is actor stable, and subordinate to the all-surface master flag. */
export function smsTaskModel(actorKey: string, channel: string = "sms", legacy: AgentModelSelection = { model: TIER_MODELS.standard, tier: "standard", provider: "anthropic", route: "anthropic" }): AgentModelSelection {
  const options = { reasoningEffort: "low" as const, maxOutputTokens: 8_000, timeoutMs: channel === "voice" ? 15_000 : 40_000 };
  const master = process.env.AXIS_AI_LUNA_ENABLED?.trim().toLowerCase();
  if (master !== undefined) {
    const selected = selectLunaTaskModel(legacy, options);
    return selected.provider === "openai" ? { ...selected, turnBudgetMs: options.timeoutMs } : withSmsTurnBudget(selected, channel);
  }
  const enabled = process.env.AXIS_SMS_AGENT_LUNA_ENABLED?.trim().toLowerCase() === "true";
  const rawPercent = process.env.AXIS_SMS_AGENT_LUNA_ROLLOUT_PERCENT?.trim() ?? "";
  const percent = Number(rawPercent);
  let hash = 2166136261;
  for (const char of actorKey) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
  if (!enabled || !process.env.OPENAI_API_KEY?.trim() || process.env.AXIS_AGENT_MODEL?.trim() ||
      !actorKey.trim() || !/^\d+(?:\.\d+)?$/.test(rawPercent) || !Number.isFinite(percent) || percent <= 0 || percent > 100 ||
      (hash >>> 0) % 100 >= percent) return withSmsTurnBudget(legacy, channel);
  return { ...legacy, ...options, turnBudgetMs: options.timeoutMs, model: "gpt-6-luna", provider: "openai", route: "luna_primary" };
}
