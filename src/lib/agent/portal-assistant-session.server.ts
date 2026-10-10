import "server-only";

/**
 * Reading the manager's one channel-neutral PropLane Assistant conversation.
 *
 * It lives here rather than in `sms-agent-turn.server.ts` so a caller that only needs to KNOW
 * which session a text belongs to — the inbound SMS router, deciding whether a bare "YES" is an
 * authorization or a line for the Team chat — does not have to pull in the whole agent turn (the
 * model client, tracing, billing) to ask.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

export const PORTAL_ASSISTANT_SESSION_COLUMNS =
  "id, landlord_id, kind, vendor_phone_e164, status, user_id, workspace_id";

export type PortalAssistantSessionRow = {
  id: string;
  landlord_id: string;
  kind: string;
  vendor_phone_e164: string | null;
  status: string;
  user_id: string | null;
  workspace_id?: string | null;
};

/**
 * The manager's existing Assistant conversation, or null when they have none.
 *
 * Read-only, and `ok: false` means the lookup itself failed — a caller must never read that as
 * "no conversation". The verified identity and work-number workspace are resolved before this is
 * called, so the lookup stays actor + workspace scoped.
 */
export async function readPortalAssistantSmsSession(
  db: SupabaseClient,
  args: { actorUserId: string; workspaceId?: string | null },
): Promise<{ ok: boolean; session: PortalAssistantSessionRow | null }> {
  const actorUserId = args.actorUserId.trim();
  const workspaceId = args.workspaceId?.trim() || null;
  if (!actorUserId) return { ok: false, session: null };

  let lookup = db
    .from("agent_sessions")
    .select(PORTAL_ASSISTANT_SESSION_COLUMNS)
    .eq("kind", "portal_chat")
    .eq("portal", "manager")
    .eq("landlord_id", actorUserId)
    .eq("user_id", actorUserId)
    .order("updated_at", { ascending: false })
    .limit(1);
  lookup = workspaceId ? lookup.eq("workspace_id", workspaceId) : lookup.is("workspace_id", null);
  const { data: existing, error } = await lookup.maybeSingle();
  if (error) {
    console.error("manager assistant portal session lookup failed", error.message);
    return { ok: false, session: null };
  }
  return { ok: true, session: (existing as PortalAssistantSessionRow | null) ?? null };
}
