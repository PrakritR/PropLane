/**
 * Shared audit-log helper for every agent write action. The pattern (extracted
 * from the original send_rent_reminder executor):
 *
 *   1. Record intent FIRST, idempotently — the audit insert happens before the
 *      side effect. A unique violation on dedupe_key means the action already
 *      ran; the caller short-circuits to an "already done" result.
 *   2. After the side effect, stamp the realized outcome with
 *      updateAuditResult(). A retryable hard failure may clear the dedupe key
 *      so a retry records a fresh attempt instead of "already done".
 *
 * Dedupe-key conventions (keep to these):
 *   - Repeatable sends (reminders, messages): `{tool}:{scopeId}:{targetId}:{YYYY-MM-DD}`
 *   - One-shot state transitions (accept bid, void lease, approve-pay):
 *     `{tool}:{scopeId}:{targetId}` — retries return already-done forever.
 *
 * input_summary/result_summary carry ids and enums only — never free text,
 * emails beyond the action's own target, or any other PII.
 */

/** The minimal context surface the helper needs; all three portal contexts satisfy it. */
export type AuditActor = {
  /** The audit_log.landlord_id scope column: the manager id for manager
   * actions, the actor's own user id for resident/vendor actions. */
  landlordId: string;
  userId: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any;
};

/**
 * The `audit_log.landlord_id` a fleet-wide cron pass writes under. Such a pass belongs to no one
 * manager and runs as no user, but the scope column is still required; the nil uuid is never a
 * real account, so it reads as "the system" wherever audit rows are listed.
 */
export const SYSTEM_AUDIT_SCOPE_ID = "00000000-0000-0000-0000-000000000000";

/** The audit actor for a fleet-wide system pass (a reminder or dispatch sweep). */
export function systemAuditActor(db: AuditActor["db"]): AuditActor {
  return { landlordId: SYSTEM_AUDIT_SCOPE_ID, userId: SYSTEM_AUDIT_SCOPE_ID, db };
}

export type AuditOutcome =
  | { recorded: true }
  | { recorded: false; duplicate: true }
  | { recorded: false; duplicate: false; error: string };

export async function writeAuditLog(
  actor: AuditActor,
  args: {
    action: string;
    toolName: string;
    inputSummary: Record<string, unknown>;
    resultSummary?: Record<string, unknown>;
    dedupeKey?: string | null;
  },
): Promise<AuditOutcome> {
  const { error } = await actor.db.from("audit_log").insert({
    actor_user_id: actor.userId,
    landlord_id: actor.landlordId,
    action: args.action,
    tool_name: args.toolName,
    input_summary: args.inputSummary,
    result_summary: args.resultSummary ?? null,
    dedupe_key: args.dedupeKey ?? null,
    created_at: new Date().toISOString(),
  });
  if (error) {
    if (error.code === "23505") return { recorded: false, duplicate: true };
    return { recorded: false, duplicate: false, error: String(error.message ?? "audit insert failed") };
  }
  return { recorded: true };
}

/**
 * Stamp the realized outcome onto the audit row identified by its dedupe key.
 * Pass clearDedupeKey when the side effect hard-failed and a same-day retry
 * should be allowed to record a fresh attempt.
 */
export async function updateAuditResult(
  actor: AuditActor,
  dedupeKey: string,
  resultSummary: Record<string, unknown>,
  opts: { clearDedupeKey?: boolean } = {},
): Promise<void> {
  try {
    await actor.db
      .from("audit_log")
      .update({
        result_summary: resultSummary,
        ...(opts.clearDedupeKey ? { dedupe_key: null } : {}),
      })
      .eq("dedupe_key", dedupeKey);
  } catch {
    // Best-effort: the intent row already exists; a failed outcome stamp must
    // not fail the action itself.
  }
}

/** Today's date bucket for repeatable-send dedupe keys. */
export function auditDayBucket(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}
