import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { writeAuditLog } from "@/lib/tools/audit";

/**
 * The audit trail for PropLane staff changing one manager's billing terms.
 *
 * A staff override is somebody at PropLane spending PropLane's money or lifting a paid limit for
 * one account, so the interesting record is not "the value is now 5" — the settings blob already
 * says that — but WHO changed it, FROM what, and WHY. That is what this writes, one row per field
 * changed, into the same `audit_log` table every gated agent write already uses.
 *
 * `landlord_id` is the MANAGER the change is about and `actor_user_id` the staff member who made
 * it, so `audit_log_landlord_idx` answers "everything ever done to this account" in one query.
 *
 * `dedupe_key` is deliberately left unset. The agent convention keys it so a repeated action is
 * recognised as already-done; here a staff member setting the same cap twice is two real events,
 * and collapsing them would hide the second reason.
 *
 * One deliberate departure from the agent audit convention: `reason` IS free text. It is written
 * by PropLane staff about a commercial decision, not lifted from a resident or applicant, and the
 * whole point of the field is that a future reader can tell why the exception exists. It is capped
 * so a paste cannot bloat the row.
 */

export const ADMIN_BILLING_AUDIT_ACTION = "admin_billing_override";
export const ADMIN_BILLING_AUDIT_TOOL = "admin_manager_billing";

const MAX_REASON_CHARS = 280;

export function normalizeAdminAuditReason(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim().replace(/\s+/g, " ");
  if (!trimmed) return null;
  return trimmed.slice(0, MAX_REASON_CHARS);
}

export type AdminBillingAuditEntry = {
  /** The setting that moved, e.g. `propertyCap`. */
  field: string;
  before: string | number | boolean | null;
  after: string | number | boolean | null;
};

/**
 * Record one or more field changes. Best-effort per row: a failed audit insert is reported to the
 * caller but never thrown, because the write it describes has already landed and losing the whole
 * response over the trail would be worse than a gap in it. Callers surface `ok: false` in their
 * server logs rather than failing the request.
 */
export async function writeAdminBillingAudit(args: {
  db: SupabaseClient;
  actorUserId: string;
  managerUserId: string;
  entries: AdminBillingAuditEntry[];
  reason?: string | null;
}): Promise<{ ok: boolean; recorded: number }> {
  const reason = normalizeAdminAuditReason(args.reason);
  let recorded = 0;
  let ok = true;
  for (const entry of args.entries) {
    try {
      const outcome = await writeAuditLog(
        { db: args.db, landlordId: args.managerUserId, userId: args.actorUserId },
        {
          action: ADMIN_BILLING_AUDIT_ACTION,
          toolName: ADMIN_BILLING_AUDIT_TOOL,
          inputSummary: {
            field: entry.field,
            before: entry.before,
            after: entry.after,
            managerUserId: args.managerUserId,
            ...(reason ? { reason } : {}),
          },
          resultSummary: { applied: true },
        },
      );
      if (outcome.recorded) recorded += 1;
      else ok = false;
    } catch {
      ok = false;
    }
  }
  return { ok, recorded };
}
