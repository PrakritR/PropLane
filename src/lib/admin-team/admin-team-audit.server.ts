import "server-only";
import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { updateAuditResult, writeAuditLog } from "@/lib/tools/audit";

export type AdminTeamFailure = { ok: false; status: number; error: string };

/** A recorded intent row. `finish` stamps what really happened onto it (best-effort: the intent row already exists). */
export type AdminTeamAudit = {
  ok: true;
  finish: (applied: boolean, extra?: Record<string, unknown>) => Promise<void>;
};

/**
 * One audit row per Admin team grant or revoke, written BEFORE the change. A grant that cannot be recorded is refused
 * (503), so there is never an admin role without its trail. Ids and enums only, no free text.
 *
 * The row starts as `applied: false`; the caller calls `finish(true)` once the change took effect, and `finish(false)` on
 * every path that refuses or undoes it (a redeem that is handed back included), so the trail says what actually happened,
 * not only what was attempted.
 */
export async function auditAdminTeam(
  db: SupabaseClient,
  actorUserId: string,
  action: string,
  summary: Record<string, unknown>,
): Promise<AdminTeamAudit | AdminTeamFailure> {
  const dedupeKey = `${action}:${randomUUID()}`;
  const actor = { db, landlordId: actorUserId, userId: actorUserId };
  const audit = await writeAuditLog(actor, {
    action,
    toolName: action,
    inputSummary: summary,
    resultSummary: { applied: false },
    dedupeKey,
  });
  if (!audit.recorded) {
    return { ok: false, status: 503, error: "Could not record the audit entry, so nothing was changed. Please retry." };
  }
  return {
    ok: true,
    finish: async (applied, extra = {}) => {
      try {
        await updateAuditResult(actor, dedupeKey, { applied, ...extra });
      } catch {
        // Best-effort, like every outcome stamp: a failed stamp must not fail or undo the change itself.
      }
    },
  };
}
