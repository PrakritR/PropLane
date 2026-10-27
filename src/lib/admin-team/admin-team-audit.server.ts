import "server-only";
import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { writeAuditLog } from "@/lib/tools/audit";

export type AdminTeamFailure = { ok: false; status: number; error: string };

/**
 * One audit row per Admin team grant or revoke, written BEFORE the change. A grant that cannot be recorded is refused
 * (503), so there is never an admin role without its trail. Ids and enums only, no free text.
 */
export async function auditAdminTeam(
  db: SupabaseClient,
  actorUserId: string,
  action: string,
  summary: Record<string, unknown>,
): Promise<AdminTeamFailure | null> {
  const audit = await writeAuditLog(
    { db, landlordId: actorUserId, userId: actorUserId },
    { action, toolName: action, inputSummary: summary, resultSummary: { applied: false }, dedupeKey: `${action}:${randomUUID()}` },
  );
  if (audit.recorded) return null;
  return { ok: false, status: 503, error: "Could not record the audit entry, so nothing was changed. Please retry." };
}
