import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { isProspectGptShadowEnabled, runProspectGptShadow, type ProspectShadowBurst } from "@/lib/agent/prospect-gpt-shadow";
import { traceProspectShadowComparison } from "@/lib/observability/langfuse";

const QUIET_SECONDS = 20;

export type ProspectSmsChannel = "twilio" | "claw";

export function durableProspectSmsEnabled(): boolean {
  return process.env.PROSPECT_SMS_BURSTS_ENABLED?.trim() === "1";
}

function qstashConfig(): { url: string; token: string; callback: string; callbackSecret: string } | null {
  const url = process.env.QSTASH_URL?.trim();
  const token = process.env.QSTASH_TOKEN?.trim();
  const callback = process.env.PROSPECT_SMS_BURST_CALLBACK_URL?.trim();
  const callbackSecret = process.env.PROSPECT_SMS_BURST_CALLBACK_SECRET?.trim();
  return url && token && callback && callbackSecret ? { url, token, callback, callbackSecret } : null;
}

export function durableProspectSmsHealth(): { ok: true } | { ok: false; error: string } {
  if (!durableProspectSmsEnabled()) return { ok: false, error: "durable_bursts_disabled" };
  if (!qstashConfig()) return { ok: false, error: "durable_bursts_misconfigured" };
  if (!process.env.QSTASH_CURRENT_SIGNING_KEY?.trim() || !process.env.QSTASH_NEXT_SIGNING_KEY?.trim()) {
    return { ok: false, error: "durable_burst_signing_misconfigured" };
  }
  return { ok: true };
}

async function publishBurstJob(args: {
  burstId: string;
  revision: number;
  delaySeconds: number;
  attemptId: string;
}): Promise<{ ok: true; jobId: string | null } | { ok: false }> {
  const config = qstashConfig();
  if (!config) return { ok: false };
  const publish = await fetch(`${config.url.replace(/\/$/, "")}/v2/publish/${encodeURIComponent(config.callback)}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.token}`,
      "Content-Type": "application/json",
      "Upstash-Delay": `${Math.max(0, Math.ceil(args.delaySeconds))}s`,
      "Upstash-Deduplication-Id": `prospect-burst:${args.burstId}:${args.revision}:${args.attemptId}`,
      "Upstash-Forward-X-Prospect-Sms-Burst-Secret": config.callbackSecret,
    },
    body: JSON.stringify({ burstId: args.burstId, revision: args.revision }),
    signal: AbortSignal.timeout(5_000),
  }).catch(() => null);
  if (!publish?.ok) return { ok: false };
  const response = await publish.json().catch(() => null) as { messageId?: unknown } | null;
  return { ok: true, jobId: typeof response?.messageId === "string" ? response.messageId : null };
}

/** Durable ingress first. When enabled, a missing queue is an explicit failure, never an inline reply. */
export async function enqueueProspectSmsBurst(db: SupabaseClient, args: {
  sourceMessageId: string; managerUserId: string; counterpartyPhoneE164: string;
  channel: ProspectSmsChannel; body: string; replyFromNumber?: string | null;
}): Promise<{ ok: true; burstId: string; revision: number; duplicate: boolean } | { ok: false; error: string }> {
  if (args.channel === "claw") {
    return { ok: false, error: "retired_transport_unsupported" };
  }
  if (!durableProspectSmsEnabled()) return { ok: false, error: "durable_bursts_disabled" };
  const health = durableProspectSmsHealth();
  if (!health.ok) return health;
  const { data, error } = await db.rpc("record_prospect_sms_ingress", {
    p_source_message_id: args.sourceMessageId, p_manager_user_id: args.managerUserId,
    p_counterparty_phone_e164: args.counterpartyPhoneE164, p_channel: args.channel,
    p_body: args.body, p_reply_from_number: args.replyFromNumber ?? null, p_quiet_seconds: QUIET_SECONDS,
  });
  const row = Array.isArray(data) ? data[0] : data;
  if (error || !row?.burst_id) return { ok: false, error: "durable_ingress_unavailable" };
  const burstId = String(row.burst_id); const revision = Number(row.revision);
  // Retrying a webhook is also the first recovery path for a prior publish
  // outage. Re-publish the current revision with a stable queue dedupe id.
  // A stale callback is harmless because the DB claim fences its revision.
  const dueMs = Date.parse(String(row.due_at ?? ""));
  const delaySeconds = Number.isFinite(dueMs) ? Math.max(0, (dueMs - Date.now()) / 1000) : QUIET_SECONDS;
  const publish = await publishBurstJob({ burstId, revision, delaySeconds, attemptId: "ingress" });
  if (!publish.ok) return { ok: false, error: "durable_queue_unavailable" };
  await db.from("prospect_sms_bursts").update({
    queue_job_id: publish.jobId,
    published_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }).eq("id", burstId).eq("revision", revision);
  return { ok: true, burstId, revision, duplicate: row.inserted !== true };
}

/** Republish unpublished/expired-lease work with a fresh queue-attempt identity. */
export async function recoverProspectSmsBursts(db: SupabaseClient, now = new Date()): Promise<{ scanned: number; published: number; failed: number; shadowsCompleted: number; shadowsUnknown: number }> {
  const health = durableProspectSmsHealth();
  if (!health.ok) throw new Error(health.error);
  const stalePublishedAt = new Date(now.getTime() - 10 * 60_000).toISOString();
  const { data, error } = await db.from("prospect_sms_bursts")
    .select("id,revision,due_at,status,lease_expires_at,published_at")
    .or(`and(status.eq.queued,or(published_at.is.null,published_at.lt.${stalePublishedAt})),and(status.eq.generating,lease_expires_at.lt.${now.toISOString()}))`)
    .limit(20);
  if (error) throw new Error("prospect_burst_recovery_unavailable");
  let published = 0;
  let failed = 0;
  const publicationDeadline = Date.now() + 15_000;
  for (const row of data ?? []) {
    if (Date.now() >= publicationDeadline) break;
    const dueMs = Date.parse(String(row.due_at));
    const delaySeconds = Number.isFinite(dueMs) ? Math.max(0, (dueMs - now.getTime()) / 1000) : 0;
    const result = await publishBurstJob({
      burstId: String(row.id),
      revision: Number(row.revision),
      delaySeconds,
      attemptId: `recovery-${now.getTime()}-${randomUUID()}`,
    });
    if (!result.ok) { failed += 1; continue; }
    published += 1;
    await db.from("prospect_sms_bursts").update({
      queue_job_id: result.jobId,
      published_at: now.toISOString(),
      updated_at: now.toISOString(),
    }).eq("id", row.id).eq("revision", row.revision);
  }
  const shadows = await runPendingProspectShadows(db, now);
  return { scanned: data?.length ?? 0, published, failed, ...shadows };
}

type StoredShadowSnapshot = ProspectShadowBurst & {
  managerUserId?: string;
  primaryTraceId?: string | null;
};

/** Drain durable comparison jobs after submission. This runs in the recovery
 * cron, so a deferred outbox or a crashed callback cannot lose its shadow. */
export async function runPendingProspectShadows(
  db: SupabaseClient,
  now = new Date(),
): Promise<{ shadowsCompleted: number; shadowsUnknown: number }> {
  if (!isProspectGptShadowEnabled() || !process.env.OPENAI_API_KEY?.trim()) {
    return { shadowsCompleted: 0, shadowsUnknown: 0 };
  }
  const nowIso = now.toISOString();
  const workerId = `prospect-shadow-${randomUUID()}`;
  const { data, error } = await db.from("prospect_sms_shadow_jobs")
    .select("burst_id,burst_revision,manager_user_id,snapshot,status,lease_expires_at")
    .or(`status.eq.pending,and(status.eq.running,lease_expires_at.lt.${nowIso})`)
    .order("created_at", { ascending: true })
    .limit(2);
  if (error) throw new Error("prospect_shadow_recovery_unavailable");
  let shadowsCompleted = 0;
  let shadowsUnknown = 0;
  await Promise.all((data ?? []).map(async (row) => {
    const claimNow = new Date();
    const claimNowIso = claimNow.toISOString();
    let claim = db.from("prospect_sms_shadow_jobs").update({
      status: "running",
      lease_owner: workerId,
      lease_expires_at: new Date(claimNow.getTime() + 45_000).toISOString(),
      updated_at: claimNowIso,
    }).eq("burst_id", row.burst_id).eq("burst_revision", row.burst_revision).eq("status", row.status);
    if (row.status === "running") claim = claim.lt("lease_expires_at", claimNowIso);
    const { data: claimed, error: claimError } = await claim.select("burst_id").maybeSingle();
    if (claimError || !claimed) return;
    const snapshot = row.snapshot as StoredShadowSnapshot;
    const result = await runProspectGptShadow({ ...snapshot, onResult: undefined });
    const finalStatus = result.status === "completed" ? "completed" : "unknown";
    const comparison = "comparison" in result
      ? result.comparison
      : {
          identity: {
            burstId: snapshot.burstId ?? String(row.burst_id),
            burstRevision: snapshot.burstRevision ?? Number(row.burst_revision),
            promptId: snapshot.promptId,
            promptHash: snapshot.promptHash,
            release: snapshot.release,
            primaryProvider: snapshot.primaryProvider ?? "unknown",
            primaryModel: snapshot.primaryModel ?? "unknown",
            shadowProvider: "openai" as const,
            shadowModel: process.env.AXIS_PROSPECT_GPT_SHADOW_MODEL?.trim() || "unknown",
          },
          grounding: "unknown" as const,
          repetition: "unknown" as const,
          toolCorrectness: "unknown" as const,
        };
    const resultMetadata = { ...result, comparison };
    if (finalStatus === "completed") shadowsCompleted += 1;
    else shadowsUnknown += 1;
    await db.from("prospect_sms_shadow_jobs").update({
      status: finalStatus,
      result_metadata: resultMetadata,
      lease_owner: null,
      lease_expires_at: null,
      updated_at: new Date().toISOString(),
    }).eq("burst_id", row.burst_id).eq("burst_revision", row.burst_revision)
      .eq("status", "running").eq("lease_owner", workerId);
    await traceProspectShadowComparison({
      managerUserId: String(snapshot.managerUserId ?? row.manager_user_id),
      burstId: String(row.burst_id),
      primaryTraceId: snapshot.primaryTraceId ?? null,
      metadata: {
        status: resultMetadata.status,
        reason: "reason" in resultMetadata ? resultMetadata.reason : null,
        model: "model" in resultMetadata ? resultMetadata.model : comparison.identity.shadowModel,
        usage: "usage" in resultMetadata ? resultMetadata.usage : null,
        latencyMs: "latencyMs" in resultMetadata ? resultMetadata.latencyMs : null,
        burstRevision: comparison.identity.burstRevision,
        promptId: comparison.identity.promptId ?? null,
        promptHash: comparison.identity.promptHash ?? null,
        release: comparison.identity.release ?? null,
        primaryProvider: comparison.identity.primaryProvider ?? "unknown",
        primaryModel: comparison.identity.primaryModel ?? "unknown",
        grounding: comparison.grounding,
        repetition: comparison.repetition,
        toolCorrectness: comparison.toolCorrectness,
        comparison,
        provider: "openai",
        shadowRole: "prospect_gpt_shadow",
      },
    });
  }));
  return { shadowsCompleted, shadowsUnknown };
}

export async function claimProspectSmsBurst(db: SupabaseClient, args: { burstId: string; revision: number }) {
  const workerId = `prospect-burst-${randomUUID()}`;
  const { data, error } = await db.rpc("claim_prospect_sms_burst", { p_burst_id: args.burstId, p_revision: args.revision, p_worker_id: workerId, p_lease_seconds: 120 });
  const row = Array.isArray(data) ? data[0] : data;
  return { ok: !error && row?.claimed === true, workerId, sourceIds: Array.isArray(row?.source_ids) ? row.source_ids.map(String) : [] };
}

export async function completeProspectSmsBurst(db: SupabaseClient, args: { burstId: string; revision: number; workerId: string; status: "suppressed" | "dispatched" | "failed"; outboxId?: string | null; candidateBody?: string | null }) {
  const { data, error } = await db.rpc("complete_prospect_sms_burst", { p_burst_id: args.burstId, p_revision: args.revision, p_worker_id: args.workerId, p_status: args.status, p_outbox_id: args.outboxId ?? null, p_candidate_body: args.candidateBody ?? null });
  return !error && data === true;
}
