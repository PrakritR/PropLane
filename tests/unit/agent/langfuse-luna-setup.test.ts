import { describe, expect, it, vi } from 'vitest';
import { configureLunaJudge } from '../../../scripts/lib/langfuse-luna-setup.mjs';

const paused = { id: 'old', name: 'numeric-grounding', type: 'llm_as_judge', status: 'paused', prompt: [{ role: 'user', content: 'Original rubric {{input}} {{output}}' }], outputDefinition: { dataType: 'BOOLEAN' }, evaluationRuleAssignments: [{ evaluationRuleId: 'rule' }] };
const rule = { id: 'rule', name: 'numeric-grounding', enabled: true, sampling: 0.25, filter: [{ column: 'name', value: ['axis-agent-turn-summary'] }], evaluatorAssignments: [{ evaluatorId: 'old', variableMapping: null }] };
function requestFixture() {
  return vi.fn(async (path: string, opts?: { method?: string; body?: Record<string, unknown> }) => {
    if (!opts?.method) {
      if (path.endsWith('llm-connections')) return { data: [], meta: { totalPages: 1 } };
      if (path.endsWith('evaluators')) return { data: [paused], meta: {} };
      return { data: [rule], meta: {} };
    }
    if (path.endsWith('evaluators')) return { id: 'new', status: 'active' };
    return { ...rule, ...opts.body };
  });
}
describe('Langfuse Luna judge migration', () => {
  it('dry run reads configuration without modifying it or exposing credentials', async () => {
    const request = requestFixture();
    const result = await configureLunaJudge({ request, secretKey: 'secret-fixture', prompt: 'Fallback', dryRun: true });
    expect(request.mock.calls.every(([, opts]) => !opts?.method)).toBe(true);
    expect(JSON.stringify(result)).not.toContain('secret-fixture');
    expect(result.operations).toHaveLength(3);
  });
  it('preserves the rubric, score name, rule filters and sampling while replacing the paused judge', async () => {
    const request = requestFixture();
    const result = await configureLunaJudge({ request, secretKey: 'secret-fixture', prompt: 'Fallback' });
    expect(result.evaluatorId).toBe('new');
    expect(request).toHaveBeenCalledWith('/api/public/v2/evaluators', expect.objectContaining({ method: 'POST', body: expect.objectContaining({ prompt: paused.prompt, outputDefinition: paused.outputDefinition, modelConfig: { provider: 'openai', model: 'gpt-6-luna' } }) }));
    expect(request).toHaveBeenCalledWith('/api/public/v2/evaluation-rules/rule', { method: 'PATCH', body: { evaluatorAssignments: [{ evaluatorId: 'new', variableMapping: null }] } });
    expect(request.mock.calls.filter(([, opts]) => opts?.method === 'DELETE')).toHaveLength(0);
  });
  it('does not modify a rule when the new evaluator remains paused', async () => {
    const request = requestFixture();
    const wrapped = async (path: string, opts?: { method?: string; body?: Record<string, unknown> }) => opts?.method === 'POST' ? { id: 'new', status: 'paused' } : request(path, opts);
    await expect(configureLunaJudge({ request: wrapped, secretKey: 'fixture', prompt: 'Fallback' })).rejects.toThrow('not active');
    expect(request.mock.calls.some(([, opts]) => opts?.method === 'PATCH')).toBe(false);
  });
  it('fails closed before reading or mutating configuration without an OpenAI key', async () => {
    const request = requestFixture();
    await expect(configureLunaJudge({ request, secretKey: '', prompt: 'Fallback' })).rejects.toThrow('OPENAI_API_KEY');
    expect(request).not.toHaveBeenCalled();
  });
  it('preserves an existing OpenAI connection configuration and custom models', async () => {
    const base = requestFixture();
    const request = vi.fn(async (path: string, opts?: { method?: string; body?: Record<string, unknown> }) =>
      path.endsWith('llm-connections') && !opts?.method
        ? { data: [{ provider: 'openai', customModels: ['existing-model'], withDefaultModels: false, config: { baseURL: 'https://example.invalid/v1', customHeaders: { 'X-Route': 'retained' } } }], meta: { totalPages: 1 } }
        : base(path, opts));
    await configureLunaJudge({ request, secretKey: 'fixture', prompt: 'Fallback' });
    expect(request).toHaveBeenCalledWith('/api/public/llm-connections', expect.objectContaining({ method: 'PUT', body: expect.objectContaining({ customModels: ['existing-model', 'gpt-6-luna'], withDefaultModels: false, config: { baseURL: 'https://example.invalid/v1', customHeaders: { 'X-Route': 'retained' }, useResponsesApi: true } }) }));
  });
});
