import type { SupabaseClient } from "@supabase/supabase-js";
import type { SharedLineInbound } from "@/lib/one-number/contracts";

export type UnassignedLeadTurn = {
  leadId: string | null;
  /** Text to send back on the shared line, or null when nothing should go out. */
  reply: string | null;
  /** Set once the prospect picked or toured a room: the router re-routes them there. */
  assignedWorkspaceId: string | null;
};

/**
 * Step 7 of the router: a new prospect with no entry code is qualified in the
 * platform "Unassigned leads" queue. Owned by the leads workstream.
 */
export async function handleUnassignedLeadInbound(
  _db: SupabaseClient,
  _inbound: SharedLineInbound,
): Promise<UnassignedLeadTurn> {
  return { leadId: null, reply: null, assignedWorkspaceId: null };
}
