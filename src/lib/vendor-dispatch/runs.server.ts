import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Dispatch-run actions (vendor-dispatch-1018). One run = one job offered down
 * a rule's vendor chain after the manager approves. The portal UI and the
 * manager's SMS replies both call these; the server re-derives the workspace
 * and owner from the run, never from the caller. Owned by the dispatch-engine
 * workstream.
 */

export type DispatchRunActor = {
  /** Workspace owner the caller acts for (re-derived from the session by the route). */
  ownerUserId: string;
  /** The person approving: the owner or a teammate with Services access. */
  actorUserId: string;
  channel: "sms" | "portal";
};

export type DispatchRunActionResult =
  | { ok: true; status: string }
  | { ok: false; reason: "not_found" | "not_allowed" | "wrong_state" | "no_vendors" | "unavailable" };

/** Approve the run's chain, or (pickPosition) send only the vendor at that position. */
export async function approveDispatchRun(
  _db: SupabaseClient,
  _input: DispatchRunActor & { runId: string; pickPosition?: number | null },
): Promise<DispatchRunActionResult> {
  return { ok: false, reason: "unavailable" };
}

export async function declineDispatchRun(
  _db: SupabaseClient,
  _input: DispatchRunActor & { runId: string },
): Promise<DispatchRunActionResult> {
  return { ok: false, reason: "unavailable" };
}

/** After an exhausted chain: offer it again, or to every vendor of the trade at once. */
export async function retryDispatchRun(
  _db: SupabaseClient,
  _input: DispatchRunActor & { runId: string; broadcast: boolean },
): Promise<DispatchRunActionResult> {
  return { ok: false, reason: "unavailable" };
}

export async function cancelDispatchRun(
  _db: SupabaseClient,
  _input: DispatchRunActor & { runId: string },
): Promise<DispatchRunActionResult> {
  return { ok: false, reason: "unavailable" };
}
