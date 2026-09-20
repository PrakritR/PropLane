import "server-only";

import type { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { stampSmsTestProvenance } from "@/lib/sms/sms-test-provenance.server";
import { readSmsTestProvenance } from "@/lib/sms/sms-test-provenance";

type Db = ReturnType<typeof createSupabaseServiceRoleClient>;

export type PlannedScheduleMutation = {
  operation: "append" | "cancel" | "replace";
  event: Record<string, unknown>;
  expected?: { start: string; end: string };
};

export type PlannedScheduleMutationResult =
  | { available: false }
  | { available: true; ok: true; idempotent: boolean }
  | { available: true; ok: false; reason: string };

/** Generic (non-tour) planned-event boundary. The tour-specific RPC retains
 * reservation semantics; both RPCs share the same transaction advisory lock. */
export async function mutatePlannedScheduleEvent(
  db: Db,
  mutation: PlannedScheduleMutation,
): Promise<PlannedScheduleMutationResult> {
  const event = stampSmsTestProvenance(mutation.event);
  if (readSmsTestProvenance(event)?.workspaceId) {
    return { available: true, ok: false, reason: "Test workspace planned-event storage is unavailable." };
  }
  if (typeof (db as { rpc?: unknown }).rpc !== "function") return { available: false };
  const { data, error } = await db.rpc("mutate_planned_schedule_event", {
    p_operation: mutation.operation,
    p_event: event,
    p_expected_start: mutation.expected?.start ?? null,
    p_expected_end: mutation.expected?.end ?? null,
  });
  if (error) return { available: true, ok: false, reason: error.message };
  const result = data as { ok?: unknown; reason?: unknown; idempotent?: unknown } | null;
  if (result?.ok === true) return { available: true, ok: true, idempotent: result.idempotent === true };
  return { available: true, ok: false, reason: typeof result?.reason === "string" ? result.reason : "Calendar event is unavailable." };
}

export async function replaceManagerPlannedScheduleSlice(
  db: Db,
  args: {
    managerUserId: string;
    actorIsAdmin?: boolean;
    events: Record<string, unknown>[];
    /** Null means the caller did not provide an observed baseline. */
    expectedEvents: Record<string, unknown>[] | null;
    testWorkspaceId?: string | null;
  },
): Promise<PlannedScheduleMutationResult> {
  if (typeof (db as { rpc?: unknown }).rpc !== "function") return { available: false };
  const events = args.events.map((event) => stampSmsTestProvenance(event));
  const workspaceId = args.testWorkspaceId?.trim() || null;
  if (events.some((event) => {
    const marker = readSmsTestProvenance(event)?.workspaceId;
    return marker && marker !== workspaceId;
  })) return { available: true, ok: false, reason: "Test workspace schedule mismatch." };
  if (workspaceId && !Array.isArray(args.expectedEvents)) {
    return { available: true, ok: false, reason: "Test workspace schedule baseline is required." };
  }
  const { data, error } = workspaceId
    ? await db.rpc("replace_manager_planned_schedule_slice_namespace", {
        p_workspace_id: workspaceId,
        p_manager_user_id: args.managerUserId,
        p_events: events,
        p_expected_events: args.expectedEvents,
      })
    : await db.rpc("replace_manager_planned_schedule_slice", {
        p_manager_user_id: args.managerUserId,
        p_actor_is_admin: args.actorIsAdmin === true,
        p_events: events,
        p_expected_events: args.expectedEvents,
      });
  if (error) return { available: true, ok: false, reason: error.message };
  const result = data as { ok?: unknown; reason?: unknown } | null;
  if (result?.ok === true) return { available: true, ok: true, idempotent: false };
  return { available: true, ok: false, reason: typeof result?.reason === "string" ? result.reason : "Calendar write is unavailable." };
}
