#!/usr/bin/env node
/**
 * One-shot setup for the Langfuse project:
 *   1. Ensure dataset `agent-rejected-actions` exists
 *   2. Create (or version) the `numeric-grounding` LLM-as-judge evaluator
 *   3. Create an evaluation rule targeting `axis-agent-turn-summary` at 100%
 *
 * Observation evaluators cannot read sibling tool spans — the app already emits
 * `axis-agent-turn-summary` with `{ userRequest, toolEvidence }` as input and
 * the final reply as output.
 *
 * Usage:
 *   vercel env run -e production -- npm run langfuse:setup
 */
import { createLangfuseClient, langfuseFetch } from "./lib/langfuse-ops.mjs";
import { configureLunaJudge } from "./lib/langfuse-luna-setup.mjs";

const DATASET = process.env.LANGFUSE_REJECTED_ACTIONS_DATASET?.trim() || "agent-rejected-actions";
const EVALUATOR_NAME = "numeric-grounding";
const SCORE_NAME = "numeric-grounding";
const OBSERVATION_NAME = "axis-agent-turn-summary";

export const NUMERIC_GROUNDING_JUDGE_PROMPT = `You are grading whether an AI property-management assistant's reply is numerically grounded in the tool evidence from the SAME turn.

INPUT:
{{input}}

OUTPUT (assistant reply):
{{output}}

Task:
1. Extract every factual numeric claim in the reply (money amounts, counts, percentages, dates with numbers, numeric ids). Ignore pure greetings, UI navigation, and soft hedges.
2. For each claim, decide if the same-turn toolEvidence supports it (exact or clearly equivalent value present in a tool output).
3. If the reply has NO applicable numeric claims, pass (score true).
4. Fail (score false) if ANY applicable claim is unsupported or contradicted by the evidence.

Return a boolean score with short reasoning listing ungrounded claims (numbers only — no names/emails).`;

async function ensureDataset(lf) {
  try {
    await lf.createDataset({
      name: DATASET,
      description:
        "Write proposals users denied. Replay to check candidate prompts avoid the same tool/args. Anti-regression only.",
    });
    console.log(`Created dataset ${DATASET}`);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/already|409|conflict/i.test(msg)) console.log(`Dataset ${DATASET} already exists`);
    else {
      try {
        await langfuseFetch(`/api/public/v2/datasets/${encodeURIComponent(DATASET)}`);
        console.log(`Dataset ${DATASET} reachable`);
      } catch {
        throw e;
      }
    }
  }
}

async function ensureDashboard() {
  const existing = await langfuseFetch("/api/public/unstable/dashboards", {
    query: { page: 1, limit: 50 },
  }).catch(() => ({ data: [] }));
  const data = Array.isArray(existing?.data) ? existing.data : [];
  const already = data.find((d) => d?.name === "Agent improvement loop");
  if (already) {
    console.log(`Dashboard already present id=${already.id}`);
    return already;
  }
  try {
    const created = await langfuseFetch("/api/public/unstable/dashboards", {
      method: "POST",
      body: {
        name: "Agent improvement loop",
        description:
          "Approval rate, numeric grounding, and loop-health signals for the PropLane assistant. Use npm run langfuse:agent-health-report for the portable fallback.",
      },
    });
    console.log(`Created dashboard id=${created?.id ?? "?"}`);
    return created;
  } catch (e) {
    console.warn(`Dashboard create skipped: ${e instanceof Error ? e.message : e}`);
    return null;
  }
}

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const judge = await configureLunaJudge({ request: langfuseFetch, secretKey: process.env.OPENAI_API_KEY, prompt: NUMERIC_GROUNDING_JUDGE_PROMPT, dryRun });
  console.log(JSON.stringify(judge, null, 2));
  if (dryRun) return;
  const lf = createLangfuseClient();
  await ensureDataset(lf);
  try {
    await lf.flushAsync();
  } catch {
    /* ignore */
  }

  const dashboard = await ensureDashboard();

  console.log(`
# Langfuse improvement-loop status

- Dataset: ${DATASET}
- Evaluator: ${EVALUATOR_NAME} (score ${SCORE_NAME})
- Observation filter: name = ${OBSERVATION_NAME}
- Sampling: 100%
- Dashboard: ${dashboard?.id ? `Agent improvement loop (${dashboard.id})` : "(create in UI if needed)"}
- Populate denials: npm run langfuse:sync-eval-dataset
- Health: npm run langfuse:agent-health-report
`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
