/** Stable-ID migration of the existing numeric judge, preserving scores and rules. */
export const LUNA_JUDGE_MODEL = 'gpt-6-luna';
const ROOT = '/api/public/v2';
const MAPPING = [{ variable: 'input', source: 'input' }, { variable: 'output', source: 'output' }];

async function listAll(request, path, cursorBased = true) {
  const rows = [];
  let cursor;
  for (let page = 1; page <= 100; page++) {
    const result = await request(path, { query: cursorBased ? { limit: 100, cursor } : { limit: 100, page } });
    if (!Array.isArray(result.data)) throw new Error(`Invalid list response from ${path}`);
    rows.push(...result.data);
    if (cursorBased) {
      cursor = result.meta?.cursor;
      if (!cursor) return rows;
    } else if (page >= (result.meta?.totalPages ?? 1)) return rows;
  }
  throw new Error(`Pagination limit exceeded for ${path}`);
}

export async function configureLunaJudge({ request, secretKey, prompt, dryRun = false }) {
  if (!secretKey?.trim()) throw new Error('OPENAI_API_KEY is required for the Luna judge.');
  const connections = await listAll(request, '/api/public/llm-connections', false);
  const evaluators = await listAll(request, `${ROOT}/evaluators`);
  const rules = await listAll(request, `${ROOT}/evaluation-rules`);
  const named = evaluators.filter(e => e.name === 'numeric-grounding');
  const matching = named.filter(e => e.type === 'llm_as_judge' && e.status === 'active' && e.modelConfig?.provider === 'openai' && e.modelConfig?.model === LUNA_JUDGE_MODEL);
  if (matching.length > 1) throw new Error('Several active Luna numeric-grounding evaluators exist; choose one explicitly before modifying rules.');
  const previous = named.find(e => e.evaluationRuleAssignments?.length) ?? named[0];
  const relatedRules = rules.filter(r => r.evaluatorAssignments?.some(a => named.some(e => e.id === a.evaluatorId)) || ['numeric-grounding', 'numeric-grounding-on-turn-summary'].includes(r.name));
  if (relatedRules.length > 1) throw new Error('Several numeric-grounding rules exist; refusing ambiguous migration.');
  const priorRule = relatedRules[0];
  const connection = connections.find(c => c.provider === 'openai');
  const operations = [];
  const mutate = async (path, method, body, synthetic) => {
    operations.push({ path, method, ...(body.modelConfig ? { modelConfig: body.modelConfig } : {}) });
    return dryRun ? synthetic : request(path, { method, body });
  };
  await mutate('/api/public/llm-connections', 'PUT', {
    provider: 'openai', adapter: 'openai', secretKey: secretKey.trim(),
    customModels: [...new Set([...(connection?.customModels ?? []), LUNA_JUDGE_MODEL])],
    withDefaultModels: connection?.withDefaultModels ?? true,
    config: { ...(connection?.config ?? {}), useResponsesApi: true },
  }, { id: connection?.id ?? 'planned-openai-connection' });
  // Authentication-paused evaluators cannot be reactivated through definition PATCH.
  // Create an active version family and repoint the existing rule; retain old history.
  const evaluator = matching[0] ?? await mutate(`${ROOT}/evaluators`, 'POST', {
    name: 'numeric-grounding', type: 'llm_as_judge',
    prompt: previous?.prompt ?? prompt,
    variableMapping: previous?.variableMapping ?? MAPPING,
    modelConfig: { provider: 'openai', model: LUNA_JUDGE_MODEL },
    outputDefinition: previous?.outputDefinition ?? {
      dataType: 'BOOLEAN',
      scoreReasoningInstructions: 'Short reason listing any ungrounded numeric claims (numbers only).',
      scoreValueInstructions: 'true if every applicable numeric claim is grounded in toolEvidence; false otherwise.',
    },
  }, { id: 'planned-luna-numeric-grounding', status: 'active' });
  if (evaluator.status !== 'active') throw new Error(`Luna evaluator is not active (${evaluator.status ?? 'unknown'}); rule was not modified.`);
  const oldIds = new Set(named.map(e => e.id));
  const assignments = priorRule
    ? priorRule.evaluatorAssignments.filter(a => !oldIds.has(a.evaluatorId))
    : [];
  assignments.push({ evaluatorId: evaluator.id, variableMapping: priorRule?.evaluatorAssignments?.find(a => oldIds.has(a.evaluatorId))?.variableMapping ?? null });
  const ruleBody = priorRule
    ? { evaluatorAssignments: assignments }
    : { name: 'numeric-grounding', enabled: true, sampling: 1, filter: [{ type: 'stringOptions', column: 'name', operator: 'any of', value: ['axis-agent-turn-summary'] }], evaluatorAssignments: assignments };
  let rule = priorRule;
  if (!priorRule || JSON.stringify(priorRule.evaluatorAssignments) !== JSON.stringify(assignments)) {
    rule = await mutate(priorRule ? `${ROOT}/evaluation-rules/${encodeURIComponent(priorRule.id)}` : `${ROOT}/evaluation-rules`, priorRule ? 'PATCH' : 'POST', ruleBody, { ...priorRule, ...ruleBody, id: priorRule?.id ?? 'planned-numeric-grounding-rule' });
  }
  return { dryRun, evaluatorId: evaluator.id, evaluatorStatus: evaluator.status, ruleId: rule.id, ruleEnabled: rule.enabled, model: LUNA_JUDGE_MODEL, operations, previousEvaluatorId: previous?.id };
}
