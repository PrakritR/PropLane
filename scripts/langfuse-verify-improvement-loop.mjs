#!/usr/bin/env node
/**
 * Live smoke verification of the improvement-loop wiring against Langfuse:
 *   1. Create a throwaway proposal-style trace with a pending span
 *   2. Score action-approved = 0 on it
 *   3. Upsert it into agent-rejected-actions
 *   4. Confirm the dataset item is readable
 *
 * Usage:
 *   vercel env run -e production -- node scripts/langfuse-verify-improvement-loop.mjs
 */
import { createLangfuseClient, langfuseFetch } from "./lib/langfuse-ops.mjs";
import { startObservation } from "@langfuse/tracing";
import { LangfuseSpanProcessor } from "@langfuse/otel";
import { NodeSDK } from "@opentelemetry/sdk-node";

const DATASET = process.env.LANGFUSE_REJECTED_ACTIONS_DATASET?.trim() || "agent-rejected-actions";

async function waitForScore(traceId, name, predicate = () => true) {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    const scores = await langfuseFetch("/api/public/v2/scores", {
      query: { traceId, name, limit: 100 },
    });
    const hit = (scores?.data || []).find(
      (score) => score.traceId === traceId && score.name === name && predicate(score),
    );
    if (hit) return hit;
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }
  throw new Error(`score ${name} was not readable for trace ${traceId} within 90 seconds`);
}

async function main() {
  const processor = new LangfuseSpanProcessor({ flushAt: 1 });
  const otel = new NodeSDK({ spanProcessors: [processor] });
  otel.start();
  const lf = createLangfuseClient();
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const actionId = `verify-action-${stamp}`;

  const trace = lf.trace({
    name: "axis-agent-turn",
    userId: "00000000-0000-4000-8000-verifyloop0001",
    sessionId: `verify-session-${stamp}`,
    input: "Verify improvement loop: propose a rent reminder.",
    metadata: {
      role: "manager",
      promptId: "manager-assistant",
      promptHash: "verify",
      release: "local-verify",
      pendingAction: "send_rent_reminder",
      synthetic: true,
      purpose: "improvement-loop-smoke",
    },
  });

  trace.generation({
    name: "axis-agent-llm",
    model: "synthetic-no-provider-call",
    input: [{ role: "user", content: "Remind Maya about rent." }],
    output: [{ type: "text", text: "I can send a rent reminder." }],
    metadata: { iteration: 0, stopReason: "tool_use", synthetic: true, providerCallMade: false, purpose: "transport-only verification fixture" },
  }).end();

  trace.span({
    name: "pending:send_rent_reminder",
    input: { toolName: "send_rent_reminder" },
    output: { title: "Send rent reminder", fields: [{ label: "Resident", value: "Maya" }] },
    metadata: { ok: true, iteration: 0, synthetic: true },
  }).end();

  const summary = startObservation(
    "axis-agent-turn-summary",
    {
      input: {
        userRequest: "Remind Maya about rent.",
        toolEvidence: [{ name: "list_charges", output: { balanceCents: 210000 } }],
      },
      output: "I can send Maya a rent reminder for $2,100.",
      metadata: {
        iterationCount: 1,
        terminationReason: "pending_action",
        synthetic: true,
        verificationStamp: stamp,
      },
      environment:
        process.env.LANGFUSE_TRACING_ENVIRONMENT?.trim() ||
        process.env.VERCEL_ENV?.trim() ||
        "production",
    },
    { asType: "span" },
  );
  const summaryTraceId = summary.traceId;
  summary.end();
  await processor.forceFlush();
  if (!summaryTraceId) throw new Error("OpenTelemetry summary did not return a trace id");
  console.log(`summary-trace=${summaryTraceId}`);

  trace.span({
    name: "axis-agent-turn-summary",
    input: {
      userRequest: "Remind Maya about rent.",
      toolEvidence: [{ name: "list_charges", output: { balanceCents: 210000 } }],
    },
    output: "I can send Maya a rent reminder for $2,100.",
    metadata: {
      iterationCount: 1,
      terminationReason: "pending_action",
      synthetic: true,
    },
  }).end();

  await lf.flushAsync();
  const traceId = trace.id;
  if (!traceId) throw new Error("Langfuse did not return a trace id");
  console.log(`trace=${traceId}`);

  lf.score({
    traceId,
    name: "action-approved",
    value: 0,
    dataType: "NUMERIC",
    id: `action-approved-${actionId}`,
    comment: "denied:send_rent_reminder",
  });
  await lf.flushAsync();
  console.log("scored action-approved=0");

  // Give Langfuse a moment to index the score/trace before dataset sync.
  await new Promise((r) => setTimeout(r, 2500));

  await lf.createDatasetItem({
    id: `eval-${traceId}`,
    datasetName: DATASET,
    input: {
      generationInput: [{ role: "user", content: "Remind Maya about rent." }],
      userInput: "Verify improvement loop: propose a rent reminder.",
    },
    expectedOutput: {
      avoidTool: "send_rent_reminder",
      avoidUnchangedProposal: true,
    },
    sourceTraceId: traceId,
    metadata: {
      reason: "denied",
      toolName: "send_rent_reminder",
      synthetic: true,
      purpose: "improvement-loop-smoke",
    },
  });
  await lf.flushAsync();
  console.log(`dataset-item=eval-${traceId}`);

  const item = await langfuseFetch(`/api/public/dataset-items/${encodeURIComponent(`eval-${traceId}`)}`);
  if (!item?.id) throw new Error("dataset item not readable after upsert");
  console.log(`verified dataset item id=${item.id} sourceTraceId=${item.sourceTraceId || item.source_trace_id || "?"}`);

  const approvalScore = await waitForScore(
    traceId,
    "action-approved",
    (score) => Number(score.value) === 0,
  );
  console.log(`verified action-approved score id=${approvalScore.id}`);

  const rules = await langfuseFetch("/api/public/v2/evaluation-rules", { query: { limit: 100 } });
  const rule = (rules?.data || []).find((r) => r.name === "numeric-grounding");
  if (!rule || rule.enabled !== true) {
    throw new Error(`numeric-grounding rule missing/inactive: ${JSON.stringify(rule)}`);
  }
  const evaluators = await Promise.all((rule.evaluatorAssignments ?? []).map(({ evaluatorId }) =>
    langfuseFetch(`/api/public/v2/evaluators/${encodeURIComponent(evaluatorId)}`)));
  const matches = evaluators.filter(evaluator => evaluator.name === "numeric-grounding" && evaluator.status === "active" && evaluator.modelConfig?.provider === "openai" && evaluator.modelConfig?.model === "gpt-6-luna");
  if (matches.length !== 1) throw new Error(`Expected one active Luna numeric-grounding evaluator, found ${matches.length}`);
  const evaluatorId = matches[0].id;
  console.log(`verified evaluator rule id=${rule.id} evaluator=${evaluatorId} model=gpt-6-luna`);

  const groundingScore = await waitForScore(summaryTraceId, "numeric-grounding");
  console.log(`verified numeric-grounding score id=${groundingScore.id} value=${groundingScore.value}`);

  await otel.shutdown();
  console.log("OK improvement-loop smoke verification passed");
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
