import "server-only";

import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";

export type ClaimedSmsTestBurst = {
  burstId: string;
  revision: number;
  workerId: string;
  sourceIds: string[];
  sourceMessageId: string;
  sessionId: string;
};

export async function recordAndClaimSmsTestBurst(
  db: SupabaseClient,
  args: { managerUserId: string; actorUserId: string; sessionId: string; body: string },
): Promise<ClaimedSmsTestBurst | null> {
  const sourceMessageId = `sms-test:${randomUUID()}`;
  const { data: recorded, error: recordError } = await db.rpc("record_authenticated_sms_test_ingress", {
    p_source_message_id: sourceMessageId,
    p_manager_user_id: args.managerUserId,
    p_test_actor_user_id: args.actorUserId,
    p_test_session_id: args.sessionId,
    p_body: args.body,
  });
  if (recordError) throw new Error("Could not record the SMS test message.");
  const record = Array.isArray(recorded) ? recorded[0] : recorded;
  const burstId = String(record?.burst_id ?? "").trim();
  const revision = Number(record?.revision ?? 0);
  if (!burstId || !Number.isInteger(revision) || revision < 1) return null;

  const workerId = `sms-test-${randomUUID()}`;
  const { data: claimed, error: claimError } = await db.rpc("claim_authenticated_sms_test_burst", {
    p_burst_id: burstId,
    p_revision: revision,
    p_worker_id: workerId,
    p_test_actor_user_id: args.actorUserId,
    p_test_session_id: args.sessionId,
    p_lease_seconds: 120,
  });
  if (claimError) throw new Error("Could not claim the SMS test turn.");
  const claim = Array.isArray(claimed) ? claimed[0] : claimed;
  if (claim?.claimed !== true) return null;
  const sourceIds = Array.isArray(claim.source_ids) ? claim.source_ids.map(String) : [];
  return { burstId, revision, workerId, sourceIds, sourceMessageId, sessionId: args.sessionId };
}

export async function completeSmsTestBurst(
  db: SupabaseClient,
  args: ClaimedSmsTestBurst & { actorUserId: string; reply: string; candidateContext?: unknown[] },
): Promise<boolean> {
  const { data, error } = await db.rpc("complete_authenticated_sms_test_burst", {
    p_burst_id: args.burstId,
    p_revision: args.revision,
    p_worker_id: args.workerId,
    p_test_actor_user_id: args.actorUserId,
    p_test_session_id: args.sessionId,
    p_candidate_body: args.reply,
    p_candidate_context: args.candidateContext ?? [],
  });
  return !error && data === true;
}
