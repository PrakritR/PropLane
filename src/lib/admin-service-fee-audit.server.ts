import type { SupabaseClient } from "@supabase/supabase-js";

import type { ServiceFeePayer } from "@/lib/payment-policy";

/**
 * The audit trail behind PropLane staff's processing-fee override (PRP-277).
 *
 * Every change staff make to who pays a manager's processing fees is one `audit_log` row — the
 * same service-role-only table every gated agent write already records into, so there is no new
 * table, no new grant surface, and the purge manifest's existing classification applies: the row
 * is keyed on the MANAGER (`landlord_id`), so it is the manager's own trail and goes with their
 * account, while a deleted staff member only has their `actor_user_id` pointer cleared.
 *
 * The row is keyed by `action` = {@link ADMIN_SERVICE_FEE_OVERRIDE_AUDIT_ACTION} and carries the
 * whole change in `input_summary` (what staff asked for) and `result_summary` (what the resolver
 * now answers), so a later reader can tell "pinned resident" from "cleared the override" and can
 * see whether the change actually moved the bill — an override of `manager` on a Free plan, say,
 * changes nothing until the plan does.
 *
 * `reason` is the one free-text field. It is STAFF-authored — never resident or applicant
 * input — and is capped at {@link ADMIN_SERVICE_FEE_REASON_MAX_CHARS} so a paste cannot turn the
 * audit table into a document store.
 */
export const ADMIN_SERVICE_FEE_OVERRIDE_AUDIT_ACTION = "admin_service_fee_override";

export const ADMIN_SERVICE_FEE_REASON_MAX_CHARS = 240;

/** How many changes the admin screen shows under the dropdown. */
export const ADMIN_SERVICE_FEE_AUDIT_LIMIT = 10;

export type AdminServiceFeeOverrideChange = {
  id: string;
  /** ISO timestamp of the change. */
  at: string;
  actorUserId: string;
  /** The staff member's email, when their profile still exists; null once it is gone. */
  actorEmail: string | null;
  managerUserId: string;
  /** `null` means "no override" (the manager's own setting), on both sides. */
  previousOverride: ServiceFeePayer | null;
  newOverride: ServiceFeePayer | null;
  effectiveBefore: ServiceFeePayer;
  effectiveAfter: ServiceFeePayer;
  reason: string | null;
};

/**
 * Trim and cap the staff-entered reason. Returns null for an absent or blank value so the audit
 * row stores "no reason given" as null rather than as an empty string.
 */
export function normalizeServiceFeeOverrideReason(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.replace(/\s+/g, " ").trim();
  if (!trimmed) return null;
  return trimmed.slice(0, ADMIN_SERVICE_FEE_REASON_MAX_CHARS);
}

function readPayer(raw: unknown): ServiceFeePayer | null {
  return raw === "resident" || raw === "manager" || raw === "proplane" ? raw : null;
}

export async function recordAdminServiceFeeOverrideChange(
  db: SupabaseClient,
  change: Omit<AdminServiceFeeOverrideChange, "id" | "at" | "actorEmail">,
): Promise<void> {
  const { error } = await db.from("audit_log").insert({
    actor_user_id: change.actorUserId,
    landlord_id: change.managerUserId,
    action: ADMIN_SERVICE_FEE_OVERRIDE_AUDIT_ACTION,
    tool_name: null,
    input_summary: {
      previousOverride: change.previousOverride,
      newOverride: change.newOverride,
      reason: change.reason,
    },
    result_summary: {
      effectiveBefore: change.effectiveBefore,
      effectiveAfter: change.effectiveAfter,
    },
    dedupe_key: null,
    created_at: new Date().toISOString(),
  });
  // A change that cannot be recorded is surfaced, not swallowed: the whole point of the row is
  // that staff spending PropLane's money leaves a trace, so the caller answers 500 and re-reads.
  if (error) throw new Error(`Could not record the processing-fee change: ${error.message}`);
}

/** The most recent changes for one manager, newest first, with the actor's email resolved. */
export async function listAdminServiceFeeOverrideChanges(
  db: SupabaseClient,
  managerUserId: string,
  limit = ADMIN_SERVICE_FEE_AUDIT_LIMIT,
): Promise<AdminServiceFeeOverrideChange[]> {
  const { data, error } = await db
    .from("audit_log")
    .select("id, actor_user_id, landlord_id, input_summary, result_summary, created_at")
    .eq("landlord_id", managerUserId)
    .eq("action", ADMIN_SERVICE_FEE_OVERRIDE_AUDIT_ACTION)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) throw error;
  const rows = (data ?? []) as Array<{
    id: string;
    actor_user_id: string;
    landlord_id: string;
    input_summary: Record<string, unknown> | null;
    result_summary: Record<string, unknown> | null;
    created_at: string;
  }>;
  if (rows.length === 0) return [];

  const actorIds = Array.from(new Set(rows.map((row) => row.actor_user_id).filter(Boolean)));
  const emailById = new Map<string, string>();
  if (actorIds.length > 0) {
    const { data: profiles } = await db.from("profiles").select("id, email").in("id", actorIds);
    for (const profile of (profiles ?? []) as Array<{ id: string; email: string | null }>) {
      if (profile.email) emailById.set(profile.id, profile.email);
    }
  }

  return rows.map((row) => {
    const input = row.input_summary ?? {};
    const result = row.result_summary ?? {};
    return {
      id: row.id,
      at: row.created_at,
      actorUserId: row.actor_user_id,
      actorEmail: emailById.get(row.actor_user_id) ?? null,
      managerUserId: row.landlord_id,
      previousOverride: readPayer(input.previousOverride),
      newOverride: readPayer(input.newOverride),
      // A row written before the resolver existed would have no effective payer; "resident" is
      // the plan floor and the only answer that never bills anyone unexpectedly.
      effectiveBefore: readPayer(result.effectiveBefore) ?? "resident",
      effectiveAfter: readPayer(result.effectiveAfter) ?? "resident",
      reason: typeof input.reason === "string" && input.reason ? input.reason : null,
    };
  });
}
