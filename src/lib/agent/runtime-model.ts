import { selectLunaTaskModel, TIER_MODELS, type AgentModelSelection } from "@/lib/agent/model";

/** Server-owned text task selection. Legacy identifiers remain provider-scoped. */
export function runtimeTaskModel(options: { maxOutputTokens?: number; timeoutMs?: number } = {}, legacy: AgentModelSelection = { model: TIER_MODELS.standard, tier: "standard", provider: "anthropic", route: "anthropic" }): AgentModelSelection {
  return selectLunaTaskModel(legacy, {
    reasoningEffort: "low", maxOutputTokens: 8_000, timeoutMs: 40_000, ...options,
  });
}

/** SMS rollout is actor stable, and subordinate to the all-surface master flag. */
export function smsTaskModel(actorKey: string, channel: string = "sms", legacy: AgentModelSelection = { model: TIER_MODELS.standard, tier: "standard", provider: "anthropic", route: "anthropic" }): AgentModelSelection {
  const options = { reasoningEffort: "low" as const, maxOutputTokens: 8_000, timeoutMs: channel === "voice" ? 15_000 : 40_000 };
  const master = process.env.AXIS_AI_LUNA_ENABLED?.trim().toLowerCase();
  if (master !== undefined) {
    const selected = selectLunaTaskModel(legacy, options);
    return selected.provider === "openai" ? { ...selected, turnBudgetMs: options.timeoutMs } : selected;
  }
  const enabled = process.env.AXIS_SMS_AGENT_LUNA_ENABLED?.trim().toLowerCase() === "true";
  const rawPercent = process.env.AXIS_SMS_AGENT_LUNA_ROLLOUT_PERCENT?.trim() ?? "";
  const percent = Number(rawPercent);
  let hash = 2166136261;
  for (const char of actorKey) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
  if (!enabled || !process.env.OPENAI_API_KEY?.trim() || process.env.AXIS_AGENT_MODEL?.trim() ||
      !actorKey.trim() || !/^\d+(?:\.\d+)?$/.test(rawPercent) || !Number.isFinite(percent) || percent <= 0 || percent > 100 ||
      (hash >>> 0) % 100 >= percent) return legacy;
  return { ...legacy, ...options, turnBudgetMs: options.timeoutMs, model: "gpt-6-luna", provider: "openai", route: "luna_primary" };
}
